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

应用出网只有四种情况，全部由主进程发起，
**渲染层永远发不出网络请求**（CSP `connect-src 'self'`）：

1. 用户在「网站门户」点击某个学习网站 → 交给系统默认浏览器打开（应用自己不请求）
2. 用户在「网站门户」点击「补齐图标」或某个站点的 ⟳ → 抓取该站点图标（见下）
3. 用户主动使用 AI 助手 → 请求用户自己配置的接口地址
4. 用户主动使用 Notion 同步（推送 / 拉取 / 测试连接）→ 请求 `https://api.notion.com`。
   地址是**写死的常量**（`shared/notion.ts` 的 `NOTION_API_ORIGIN`），用户改不了，
   只能配置 Token 与目标 id。缺 Token 或缺目标时**在发请求之前就报错**，
   不会发出一个没有凭据的请求——这一条由 `npm run smoke:notion` 断言

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

## 渗透测试记录（2026-09-12）

### 威胁模型

假设最坏情况：**渲染层里已经住进一段攻击者的内容**（比如一篇导入的恶意笔记）。
探针就是那个攻击者，从被攻破的渲染层出发逐条尝试——这才是这个应用真实面对的场景，
因为应用本身就要渲染用户自己（或从别处导入）的 Markdown。

测试固化为 `npm run smoke:security`，每次改动都能重跑。

### 发现并已修复的问题

**S1（高危）`window.open` 绕过协议白名单 → 任意程序执行**

- **根因**：`window.ts` 给主窗口注册 `setWindowOpenHandler` 时直接调了
  `shell.openExternal(url)`。而 `setWindowOpenHandler` 是**后注册覆盖先注册**的，
  这一行把 `security.ts` 里那个带协议白名单的安全版整个顶掉了。
- **攻击链**：笔记里写一行 `<a href="file:///C:/Windows/System32/cmd.exe" target="_blank">点我</a>`
  （markdown 按 `html: true` 原样渲染）→ 用户点击 → 系统执行 cmd.exe。
  `smb://` 远程共享上的 exe 同理。
- **修复**：`window.ts` 的 handler 改为走 `openExternalSafely` 的协议白名单
  （`http/https/mailto`），其余协议静默拒绝。
- **回归断言**：探针里 `window.open('file:///...')` 必须返回 `null`（deny）。

**S2（中危，数据完整性）重命名注入 → 笔记「隐形」**

- **根因**：`safeNoteTitle` 允许标题以 `.` 开头（它只洗路径分隔符），
  而 `#scan()` 会把 `.` 开头的文件当隐藏文件忽略（为了跳过 `.study-board` / `.obsidian`）。
  「应用能写出来的文件名」与「应用能扫回来的文件名」不是同一组集合。
- **触发链**：把笔记重命名为 `.. .. x` → 文件写出来、索引更新 →
  下一次任何 `list()`/`find()` 触发对账 → 文件被跳过 → 判定「被外部删除」→
  **摘掉索引、解绑卡片关联、落盘持久化**。文件明明还在磁盘上，界面里凭空消失。
- **修复**：`safeNoteTitle` 对称地剥掉**开头**的点和空格（它本来就剥结尾的）。
- **回归断言**：重命名注入之后笔记必须还能读回来（`renameRoundTripOk`）。

### 测试结果矩阵（全部通过）

| 攻击手法 | 期望 | 结果 | 证据 |
| --- | --- | --- | --- |
| 渲染层访问 `process` / `require` / `Buffer` / `module` | 全部 `undefined` | ✅ 挡住 | 沙箱 + contextIsolation |
| 经典逃逸：`top.process`、iframe `contentWindow.process` | `undefined` / 无法建 | ✅ 挡住 | `frame-src 'none'` + sandbox |
| preload 暴露面 | 只有 `studyBoard` 一个注入对象 | ✅ 只有它 | `Object.keys(window)` |
| 密钥读取通道 | 不存在 get 类方法 | ✅ 只有 set/clear | 渲染层永远只见布尔值 |
| 注入 `<script>` 执行 | 不执行 | ✅ CSP 拦 | `script-src 'self'`，控制台有违规报告 |
| `<img onerror="…">` 内联事件处理器 | 不执行 | ✅ CSP 拦 | 同上 |
| `javascript:` URL 导航 | 不执行 | ✅ CSP 拦 | 同上 |
| `fetch('https://…')` | 拒绝，请求不发出 | ✅ CSP 拦 | `connect-src 'self'` |
| `WebSocket('wss://…')` | 拒绝 | ✅ CSP 拦 | 同上 |
| 远程图片 beacon（信息外带） | 不加载 | ✅ CSP 拦 | `img-src` 不含 https |
| `sb-asset://` 编码穿越（`%2e%2e%2f`） | 404 | ✅ 挡住 | `safeJoin` 前缀检查 |
| `sb-asset://` 反斜杠穿越（`..%5C`） | 404 | ✅ 挡住 | Windows 路径归一化 |
| `sb-asset://` 连跳四级出数据目录 | 404 | ✅ 挡住 | 同上 |
| `sb-asset://` 未知桶 / 绝对路径注入 | 404 | ✅ 挡住 | 桶白名单 + 拒绝绝对路径 |
| `sb-asset://` 正常路径（对照组） | 200 可加载 | ✅ 正常 | 区分「被挡」与「文件不存在」 |
| 笔记 id 路径穿越（`../../etc/passwd`、绝对路径） | 拒绝 | ✅ 拒绝 | id 只查索引，不到磁盘 |
| 重命名标题注入（`..\` + `<script>`） | 清洗，不报错不丢数据 | ✅ 洗成 `evil script` | `safeNoteTitle` |
| 创建 `<img onerror>` 标题 | 清洗 | ✅ 尖括号被剥 | 同上 + 渲染层 escapeHtml |
| 导出相对路径 / 错误扩展名 | 拒绝 | ✅ 拒绝 | `resolveTarget` 校验 |
| 原型污染（`__proto__` / `constructor.prototype`） | 原型不受污染 | ✅ 干净 | 逐字段取值，不整体 assign |
| 非法卡片状态值 | 落回默认，不崩 | ✅ 落 `learning` | `normalizeCourseStatus` |
| 1MB 课程名 | 截断，不崩 | ✅ 截成 60 字符 | `MAX_CARD_TEXT` |
| 非法 settings 补丁 / 非法课表坐标 | 拒绝 | ✅ 拒绝 | 设置校验 / 坐标校验 |
| `openExternal` 打 `file://` / `javascript:` / `smb://` | 拒绝 | ✅ 拒绝 | 协议白名单（S1 修复的回归验证） |
| `openPath` / `revealPath` 越出应用目录 | 拒绝 | ✅ 拒绝 | `assertInsideAppRoots` |
| `window.open` 打非白名单协议 | deny | ✅ deny | S1 修复的回归验证 |
| 改 `location.href` 导航到外部地址 | 拦截，不跳走 | ✅ 拦住 | `will-navigate` 拦截 |
| 主进程监听 TCP 端口 | 无监听 | ✅ netstat 确认 | 「绝不把端口暴露到公网」 |

### 已知并接受的风险

1. **`targetPath` 允许任意绝对路径**（扩展名必须与格式一致）。
   导出本来就是「写到用户选的位置」，正常路径上系统保存对话框挡着；
   渲染层被攻破时能写任意 `.md/.html/.docx/.pdf`——但内容受格式约束，
   写不出可自动执行的东西，且这个前提本身已是「渲染层沦陷」之后的事。
2. **AI 结果预览按 `html: true` 渲染**，不洗 HTML——洗不干净。
   执行面由 CSP 兜底（本轮已实证 `<script>` 与事件处理器都不执行）。
3. **生产环境 `devTools: false` 无法在 smoke 里动态验证**（smoke 跑的是未打包的
   开发进程）。静态配置已审查，打包成品验证时再人工确认一次。
4. **端口监听硬断言目前只在 Windows 上做**（netstat 参数各平台不同）。

### 第二轮：非脚本执行面与闸口（同日补充）

第一轮查的是「直球」——`process`/`require`、内联脚本、`fetch` 出网、`%2e%2e` 穿越。
第二轮补上攻击者真正会用的第二梯队，共 9 组。**全部通过**，但过程中
抓到了三个**探针自身的缺陷**与**一个真实代码缺陷**，后者见 S3。

| 组 | 手法 | 结果 |
| --- | --- | --- |
| G1 间接逃逸 | `constructor.constructor`、`Function('return process')`、`window.opener` 链、iframe `contentWindow.constructor` | ✅ 全部 blocked |
| G2 CSP 旁路 | `<base>`、`<form>`、`<object>`、`<meta refresh>`、内联 `style url()`、远程 `<link rel=stylesheet>`、`<iframe srcdoc>` | ✅ 全部未落地，`baseURI` 未变 |
| G3 协议走私 | 大小写、前导空白、制表符、换行、协议相对 `//`、空主机、`data:`、`vbscript:`、UNC、userinfo | ✅ 全部拒绝（`https://` 带 userinfo 属合法 URL，按设计放行） |
| G4 资源协议 | 双重编码 `%252e`、NUL 截断、5000 字符超长路径、空桶、未知桶、冒号注入、全编码 dotdot | ✅ 全部 404 |
| G5 资料闸口 | 伪装扩展名 `.exe`、`paths` 类型混淆、31 个超批量、收件箱 `../` 穿越、认领不存在文件、资料 id 穿越 | ✅ 全部挡住 |
| G6 出网闸口 | AI / Notion 未配密钥时调用 complete / test / push / pull / resolve / preview | ✅ 全部拦在出网之前，报「还没配置…」 |
| G7 密钥面 | preload 上有没有读回明文的通道；set 通道对空值 / 超长 / 含换行 / 非字符串的反应 | ✅ 只有 set/clear 四个方法，四类垃圾输入全拒 |
| G8 存储面 | `localStorage` 残留、Service Worker 是否接管页面 | ✅ 均干净 |
| G9 IPC 面 | 能否摸到裸 `ipcRenderer` / `electron`；`studyBoard.notes.read` 可否被改写 | ✅ 都不行（桥已 frozen） |

### S3（低危，行为一致性）资源桶名大小写影响是否命中

- **现象**：渲染层请求 `sb-asset://TIMETABLE/<真课表图>` 时能读到文件。
  表面上像是「大小写变形绕过了桶检查」。
- **根因**：Electron 在把请求交给 `protocol.handle` 之前，**已经把 hostname
  规范化成小写**了。所以 `pickBase` 收到的是 `'timetable'`——命中的正是那个
  **合法**的桶，文件真实存在，当然读得到。真正越界的桶名仍然会被 `default: throw` 拒掉。
- **为什么不算漏洞**：读到的始终是桶内文件，没有越界。
- **但仍然修了**：行为不该由客户端的大小写写法决定。现在统一
  `url.hostname.toLowerCase()` 再查桶，语义变成「桶名不区分大小写」这一条明确规则。
- **教训**：这个差异**只跑 Node 的 `new URL()` 是发现不了的**——它不会把非特殊
  scheme 的 hostname 转小写。只有真跑 Electron 才看得见。单测覆盖不到的地方，
  必须靠真机探针。

### 探针自身的三个缺陷（写对了才谈得上「验证」）

这三条都不是产品问题，是**测试写错反而给出虚假安全感**，价值在于它们是怎么被发现的：

1. **`typeof null === 'object'` 把安全误报成逃逸。**
   原写法 `typeof (window.opener && window.opener.process)`：`opener` 为 `null`
   （正是期望的安全状态）时表达式得到 `null`，`typeof` 返回 `'object'`。
   必须先把 `null` 挑出来再取 `typeof`。
2. **用 `fetch` 读 `sb-asset://` 是错的。** CSP 是 `connect-src 'self'`，
   **不含 `sb-asset:`**，所以 `fetch` 一律 `Failed to fetch`——连正常图片都读不到，
   这个探针退化成「什么都测不出来」。`img-src` 里才有 `sb-asset:`，
   `<img>` 才是这条协议的真实消费者（攻击者能用的也正是它）。改回 `<img>`。
3. **CSP 的 `base-uri 'none'` 挡的是效果、不是元素。**
   `<base>` 照样能 append 进 DOM，所以「DOM 里有没有 base 元素」不能当判据。
   改成比对注入前后 `document.baseURI` 是否变化。

这三条有一个共同点：**断言在「没修好」时也照样为真**。与上一轮 Notion 探针那个
恒真假通过是同一种病——凡是「拦住了没有」的断言，都要先确认它在「没拦住」时
真的会失败。

### 打包成品的验证（2026-09-12）

安装包不是「构建成功」就算数的，得真的跑一遍。对
`StudyBoard-0.1.0-win-x64-setup.exe` 的 `win-unpacked` 产物实测：

| 检查项 | 方法 | 结果 |
| --- | --- | --- |
| 完整安全探针 | 对打包产物设 `STUDY_BOARD_SMOKE=1` 实跑 | ✅ **exit 0**，全部断言通过（路径确认为 `…app.asar/…`） |
| 端口监听 | netstat 按主进程 PID 过滤 | ✅ 无任何 LISTENING |
| devTools 真的关了 | 从 `app.asar` 解出 `out/main/index.js` 查配置 | ✅ `devTools: !app.isPackaged`，打包态为 `false` |
| CSP 是否被正确替换 | 解出 `out/renderer/index.html` | ✅ 生产策略已写入（`%CSP%` 占位符已替换） |
| 沙箱基线 | 解出主进程 bundle 查 `webPreferences` | ✅ `sandbox:true` / `contextIsolation:true` / `nodeIntegration:false` / `webSecurity:true` |
| 源码泄漏 | `asar list` 找 `.map` / `.ts` | ✅ 无源码与 source map |
| 卡死救援通道 | 实跑内检查窗口事件监听 | ✅ `unresponsive`/`responsive` 各 1、`render-process-gone` 3、`did-fail-load` 2，日志可写 |
| 正常启动 | 直接运行 exe | ✅ 正常建数据目录，无报错 |

### 已知并接受的打包问题

- **冒烟测试代码进了生产包**。`smoke.ts`（含全部攻击探针与 payload 字符串）
  被打了进去，体积约占了主进程 bundle 的大半。它由 `STUDY_BOARD_SMOKE=1`
  环境变量门控，正常使用不会触发；但任何人都能设这个变量把它拉起来。
  攻击载荷本身没有杀伤力（都是 `evil.example.com` 这类占位地址），
  实际风险很低，**但它本不该出现在用户下载的东西里**。留待后续用构建期
  别名或条件编译排除。
- `docx@9.7.1` 把 `@types/node` 声明成了**运行时依赖**（上游的打包疏忽），
  electron-builder 忠实地把它收进了 asar。只有 LICENSE 与 package.json 两个文件，
  影响可忽略。

---

## 十、报告安全问题

请不要开公开 Issue。通过仓库的 Security 面板提交私密报告，或发邮件给维护者。我们会尽快回应，并在修复后于 CHANGELOG 中致谢（如果你愿意署名）。
