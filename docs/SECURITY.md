# 安全说明

本文档描述本项目的安全模型、已落地的措施，以及**你可以自己验证**的方式。

---

## 威胁模型

我们在防什么：

| 场景 | 目标 |
| --- | --- |
| 端口被暴露到局域网/公网 | 应用**从不监听任何端口** |
| 渲染层被注入的脚本拿到系统权限 | 渲染层没有 Node 能力，只能调白名单接口 |
| 界面被诱导加载远程内容 | 禁止导航、禁止新窗口、CSP 只允许本地资源 |
| 笔记库里的恶意文件名导致越权读写 | 所有路径必须过 `safeJoin` 校验 |
| API Key / Token 泄漏 | 用系统钥匙串加密存储，且永不回读给界面 |
| 依赖供应链风险 | 生产依赖尽量少，且优先纯 JS 实现 |

不在防什么：

- 用户本机已经被完全控制（恶意软件、键盘记录器）—— 这超出应用边界
- 用户主动把自己的 API Key 贴给别人

---

## 一、网络暴露

**这是最重要的一条：应用不监听任何 TCP/UDP 端口。**

前后端通信走 Electron 的进程间通信（IPC），不启动 HTTP 服务，因此不存在"端口没绑到 127.0.0.1"这种问题。

### 自己验证

应用运行时执行：

```bash
# Windows
netstat -ano | findstr LISTENING | findstr <StudyBoard 的 PID>

# macOS
lsof -nP -iTCP -sTCP:LISTEN | grep -i studyboard
```

预期结果：**没有任何输出**。

也可以直接按 PID 看该进程持有的所有监听端口：

```bash
# macOS / Linux
lsof -nP -p <PID> | grep LISTEN
```

### 出网方向

应用出网只有四种情况，全部由主进程发起，**渲染层永远发不出网络请求**（CSP `connect-src 'self'`）：

1. 用户在「网站门户」点击某个学习网站 → 交给系统默认浏览器打开（应用自己不请求）
2. 用户在「网站门户」点击「补齐图标」或某个站点的 ⟳ → 抓取该站点图标（见下）
3. 用户主动使用 AI 助手 → 请求用户自己配置的接口地址
4. 用户主动开启 Notion 同步 → 请求 Notion 官方 API

没有遥测、没有崩溃上报、没有自动更新回传、没有访问任何本项目自己的服务器（项目也没有服务器）。

#### 图标抓取（唯一一处应用自己发起的网络请求）

「网站门户」需要显示站点图标，这是唯一一处**应用自己**发起的网络请求。约束：

| 约束 | 说明 |
| --- | --- |
| 只在用户显式点击时触发 | 启动路径上没有任何网络调用；默认状态完全离线 |
| 仅 `http` / `https` | 重定向的每一跳都重新校验协议，最多 3 跳，防 `file:` 之类 |
| `useSessionCookies: false` | 不发送任何 Cookie，不带上用户的登录态 |
| 网页 512 KB / 图标 2 MB / 8 秒超时 | 体积与时长双重上限 |
| 响应字节一律经 Chromium 解码后重编码为 PNG | 伪装成图片的 HTML / SVG / 脚本一律解不出来，等于被丢弃；不会有外来字节被原样落盘 |
| 失败只影响图标 | 回退到「色块 + 首字」，站点本身照常可用 |

实现见 `src/main/services/iconFetch.ts`。图标文件存在 `icons_cache/`，
通过 `sb-asset://icon/<file>` 只读读取（同第五节），文件名是 uuid，不接受任意路径。

> 已知取舍：为了让校内站点（如教务系统）也能加进来，**没有封禁私有网段**。
> 也就是说，如果你自己往门户里填一个内网地址并点抓取图标，应用会去请求它 ——
> 这与你用浏览器打开该地址是同一件事，且请求不带任何凭据。

---

## 二、渲染层隔离

`BrowserWindow` 的 `webPreferences` 里这几项是**不可协商的底线**，任何 PR 都不应修改：

```ts
sandbox: true,                    // 渲染进程沙箱
contextIsolation: true,           // 隔离 preload 与页面上下文
nodeIntegration: false,           // 页面拿不到 Node
nodeIntegrationInWorker: false,
nodeIntegrationInSubFrames: false,
webSecurity: true,                // 同源策略照常生效
allowRunningInsecureContent: false,
```

打包后 `devTools: false`，避免终端用户被诱导打开控制台执行脚本。

---

## 三、IPC 安全

所有 IPC 都经过 `src/main/ipc/index.ts` 的统一封装：

1. **通道白名单**：通道名必须登记在 `src/shared/channels.ts`，否则注册时直接抛错。
2. **来源校验**：只接受来自 `file://` 或 `localhost` 开发服务器的调用，其它 frame 一律拒绝。
3. **异常收敛**：主进程异常被转换成 `{ ok: false, error }`，不泄漏堆栈给渲染层。
4. **入参校验**：每个处理器都把入参当不可信数据处理 —— 枚举值白名单、数值范围收敛、路径必须是绝对路径且校验合法协议。

`preload` 侧同样受限：

- 不暴露 `ipcRenderer` 本体，只暴露具名方法
- 通道名在 preload 里写死，渲染层无法拼接
- 事件订阅必须在白名单内

`src/shared/api.ts` 里显式声明了渲染层可见的全部能力 —— 想加新能力，必须先改这个文件，等于强制过一次评审。

---

## 四、内容安全策略（CSP）

生产环境：

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: sb-asset:;
font-src 'self' data:;
connect-src 'self';
media-src 'self' sb-asset:;
object-src 'none';
frame-src 'none';
child-src 'none';
worker-src 'self' blob:;
base-uri 'none';
form-action 'none'
```

`connect-src 'self'` 是关键：**渲染层发不出任何外部请求**。

CSP 通过 `index.html` 里的 `%CSP%` 占位符在构建时注入，开发和生产用同一份页面源文件，只是策略不同 —— 避免出现"开发时能跑、打包后才发现被 CSP 拦住"的情况。

`script-src` 在生产环境**不含** `'unsafe-inline'`。

---

## 五、本地资源访问

界面需要显示笔记库里的图片，但又不能给页面任意读文件的能力。方案是自定义协议：

```
sb-asset://<bucket>/<相对路径>
```

- 只有三个 bucket：`notes`（笔记库）、`timetable`（课表照片）、`icon`（站点图标）
- 每个 bucket 锁死在自己的目录里，路径经过 `safeJoin` 校验
- `safeJoin` 拒绝：绝对路径、盘符、`..` 穿越、UNC 前缀、`\0`
- 只读不写，永远不出网

见 `src/main/paths.ts` 与 `src/main/services/assetProtocol.ts`。

### 笔记库的文件监听

界面上「外部改了文件，界面自己刷新」靠的是主进程里的一个文件监听器
（`src/main/services/notesSync.ts`）。它的权限边界：

- **只看一个目录**，而且只看这个目录**根下**的 `.md`。子目录、隐藏文件
  （`.study-board/` 里的索引、备份、回收站）一律不看
- **只读**：监听器自己不写任何文件，它只是发现变化后重新对账
- **不执行任何东西**：对账做的是「扫文件名 → 读文件头几十字节拿 frontmatter
  → 更新索引」，不解析、不加载、不信任文件内容
- 文件名来自 `readdirSync`，拼接一律过 `safeJoin`
- 监听在**渲染层发起不了、也停不掉**：通道不在 `CHANNELS` 白名单里，
  它是主进程自己启动的后台任务

用户把笔记库指到一个巨大的目录上会拖慢启动——这是已知的使用成本，
不是安全边界问题（对账只扫描一层，不递归）。

### 导出：把文件写到用户指定的位置

导出是本应用里**唯一一处会往笔记库和自有数据目录之外写文件**的功能
（`src/main/services/exporter.ts`），因此边界要写清楚：

- 目标路径正常由**系统保存对话框**决定——也就是用户亲自选的
- 渲染层可以传 `targetPath` 绕开对话框（这是给自动化测试用的口子），
  但主进程仍按不可信数据处理：必须**绝对路径**、**扩展名必须与格式一致**、
  不许含 `\0`。不校验的话，一个「导出 pdf」的请求就能写出任意扩展名的文件
- 四种格式都是**纯写**，不读目标路径上的任何东西（不做「先读再合并」）
- 内容来源只有一处：笔记存储按 id 读出来的那篇 `.md`，文件名不参与路径拼接
- **DOCX 侧不联网**：正文里 `http(s)` 的图片一律跳过，只认 `data:` URI
  与笔记库目录下的相对路径（相对路径过 `safeJoin`，越界就丢）
- **PDF 侧禁用 JavaScript**：渲染导出页的是一个隐藏窗口，
  `sandbox: true` / `contextIsolation: true` / `nodeIntegration: false` /
  `javascript: false`。正文是按 `html: true` 渲染的，`<script>` 会原样进入
  这份 HTML，所以干脆给渲染进程关掉脚本能力——排版不需要它
- 导出的 HTML 自带 `default-src 'none'` 的 CSP，只放行 `data:` / `file:`
  的图片，页面上发不出任何网络请求

---

## 六、密钥存储

- AI Key 与 Notion Token **不写进 `config.json`**
- 使用 Electron `safeStorage`（Windows DPAPI / macOS Keychain）加密后存入独立的 `secrets.bin`
- 界面只能读到一个布尔值（是否已配置），**永远不回读密钥原文**
- 设置页的密钥输入框在保存后立即清空

> 状态：`secrets.bin` 与 `safeStorage` 链路已在架构中定义，具体实现在「笔记拓展」阶段落地。

---

## 七、外链处理

- 渲染层不能自行导航（`will-navigate` 被拦截）
- 不能开新窗口（`setWindowOpenHandler` 返回 `deny`）
- 不允许挂载 `<webview>`
- 只有 `https:` / `http:` / `mailto:` 三种协议会被交给系统浏览器；URL 必须能被正确解析，且非 `mailto:` 时必须有主机名

所有链接都走系统默认浏览器打开，**应用内不承载任何第三方页面**。

---

## 八、依赖与兼容性

- **生产依赖只有 4 个**，且全部是纯 JS / WASM，没有原生模块（`.node`）

  | 包 | 用途 | 状态 |
  | --- | --- | --- |
  | `libheif-js` | HEIF/HEIC 解码（WASM 内联，懒加载） | 已在使用 |
  | `docx` | 生成 Word 文档（导出） | 已在使用 |
  | `chokidar` | 笔记库文件监听 | 已在使用 |
  | `markdown-it` | Markdown → HTML / token（导出 + 富文本编辑器） | 已在使用 |

#### 为什么编辑器那一大堆包不在这个表里

CodeMirror 与 TipTap 加起来会拉进六十多个包，但它们**全部在 `devDependencies`**。
判断依据是构建配置本身：

```
main     → externalizeDepsPlugin()  → 依赖被外部化，运行时从 node_modules 读 ⇒ 必须在 dependencies
preload  → externalizeDepsPlugin()  → 同上
renderer → （没有这个插件）          → 所有 import 被 vite 打包进 bundle ⇒ 运行时不需要 node_modules
```

渲染层产物是自包含的，这一点**验证过而不是推断的**：把 `@codemirror`、`@tiptap`、
`@lezer`、`prosemirror-*`、`turndown` 全部从 `node_modules` 里移走，
笔记编辑器照样跑通——说明代码确实都在 bundle 里。

> `markdown-it` 是那个**例外**：它原本也在上面这份「可以移走」的名单里，
> 但导出功能落地后，主进程也要用它把 `.md` 解析成 HTML / token。
> 主进程的依赖是外部化的，所以它必须待在 `dependencies`——
> 否则打包后运行时 `require('markdown-it')` 会直接失败。
> 渲染层那边不受影响，vite 照样把它打进 bundle。

不这么分的话，`electron-builder` 会把这些包**再打一份**进安装包，
白白多出十几 MB。这条区分对「运行时依赖越少越好」这条硬约束是实打实的。

#### 刻意**没有**引入的

`js-yaml` 与 `gray-matter`（frontmatter 只用到「键值对 + 小数组」，
自己实现约 100 行，完整 YAML 规范在这里全是攻击面）、
`turndown-plugin-gfm`（表格规则本身有缺陷，见
[ARCHITECTURE.md 第十四节](./ARCHITECTURE.md)，自己写反而更准）、
任何原生模块、任何前端框架。

- 没有原生模块意味着：不需要 `electron-rebuild`，也不会有 ABI 不匹配导致的安全补丁无法及时更新
- 版本全部锁在 `package-lock.json`，CI 与本地构建环境一致
- 如果某个依赖长期没有被引用，应当直接删掉——**留着不用的依赖只有成本，没有收益**

### 自查命令

```bash
npm run audit:prod      # 只扫生产依赖的已知漏洞
npm ls --omit=dev       # 看生产依赖树
```

---

## 九、已知限制

诚实列出来：

1. **macOS 安装包未签名/未公证**。首次打开需要右键 → 打开。这不影响本地数据安全，但意味着无法验证安装包来源 —— 请只从本仓库的 Releases 页下载。
2. **笔记库目录由用户指定**。如果把笔记库设成某个敏感目录，应用就有那个目录的读写权限。默认位置是安全的，改目录时请自行确认。
3. **AI / Notion 功能会把内容发到第三方**。这是功能本身决定的，只有你主动触发时才会发生，且接口地址由你自己配置。
4. **导出的 HTML / PDF 不加载外链图片**。为保持「应用不联网」，导出页的 CSP 只放行 `data:` 与本地文件；正文里写成 `https://…` 的图片不会显示。放进笔记库、用相对路径引用的图片正常。
5. **导出会覆盖目标路径上的同名文件**。正常路径上由系统保存对话框替你确认；自动化路径（直接传 `targetPath`）不做二次确认。
6. **便携模式**会把数据放在程序同级目录，如果程序装在共享位置，注意文件权限。

---

## 十、报告安全问题

请不要开公开 Issue。通过仓库的 Security 面板提交私密报告，或发邮件给维护者。我们会尽快回应，并在修复后于 CHANGELOG 中致谢（如果你愿意署名）。
