# 学习看板 StudyBoard

一个**完全离线**的课程表 + 课程笔记看板，桌面应用形态，数据全部存在你自己的电脑上。

不做账号、不做云同步、不做遥测；关掉网络也能照常使用。

[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#下载安装)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

---

## 它能做什么

### 模块一 · 课程表

课表有两种录入方式，**互为补充**，切换展示方式不会丢数据：

| 方式 | 说明 |
| --- | --- |
| 表格模式 | 8 列（节数 + 周一至周日），行数即节数，默认 11 节，可在 **1–20** 之间增减 |
| 图片模式 | 最多 3 张课表截图，支持 `jpeg` / `png` / `HEIF`，可随时替换 |

- 每个格子可填：持续时间、课程名称、授课老师、授课位置、备注
- 悬停预览、双击编辑（也支持键盘：Tab 聚焦，回车打开）
- 可给每节课设置起止时间，也能按「开始时间 + 单节时长 + 课间」一键生成
- 打开应用第一眼就是课表，固定在最上方
- 导入的照片会自动缩小到长边 2400px 再保存，手机直出的大图也不会撑爆磁盘

### 模块二 · 课程与学习

**网站门户**
- 内置慕课、B站、知网三个入口
- 可自行添加：填网址 → 命名 → 自动抓取图标 → 点击直达

**课程卡片**
- 卡片可翻转
  - 正面：课程名称、授课老师、打分、难度、掌握程度
  - 背面：给分标准、课程大致结构（选填）
- 可手动增删改，双击编辑
- 如果课表用的是表格模式，课程名与老师会自动带入

**笔记**
- 每张卡片对应一篇笔记，标题自动命名为 `课程名_授课老师`
- 双模式编辑器：**Markdown** 与 **富文本**，同一份内容两种视图
- 笔记以纯 `.md` 文件保存在 `notes_library/`，目录**可以直接用 Obsidian 打开**
- 外部改动文件，界面自动刷新；界面里改，文件自动写回

**笔记拓展**
- 一键导出为 **PDF / Word / Markdown**
- 与 **Obsidian** 天然互通；可选接入 **Notion** 做双向同步
- 接 **AI** 助手：按课程主题整理资料并写入笔记，写入方式（自己粘贴 / AI 直接写入）由你决定，且**不会改动你已有内容**

---

## 下载安装

到 [Releases](../../releases) 页面下载对应平台的安装包：

| 系统 | 文件 | 说明 |
| --- | --- | --- |
| Windows 10/11 | `StudyBoard-<版本>-win-x64-setup.exe` | 双击安装，可选安装目录，不写注册表之外的系统位置 |
| macOS | `StudyBoard-<版本>-mac-arm64.dmg`（Apple 芯片）<br>`StudyBoard-<版本>-mac-x64.dmg`（Intel） | 拖入「应用程序」即可 |

### macOS 首次打开的注意事项

本项目目前没有购买 Apple 开发者证书，安装包未做签名/公证。第一次打开时 macOS 会提示「无法验证开发者」，这是正常现象：

- **方式一**：在「应用程序」里右键点击 StudyBoard → 选择「打开」→ 在弹窗里再点一次「打开」
- **方式二**：终端执行 `xattr -dr com.apple.quarantine /Applications/StudyBoard.app`

之后就能正常双击打开了。

### Windows SmartScreen

同理，首次运行可能弹出「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」即可。

---

## 数据存在哪里

默认放在系统标准目录，卸载应用不会删除：

| 系统 | 位置 |
| --- | --- |
| Windows | `%APPDATA%\StudyBoard\` |
| macOS | `~/Library/Application Support/StudyBoard/` |

里面的结构：

```
StudyBoard/
├── config.json           # 所有设置
├── secrets.bin           # AI Key / Notion Token（系统钥匙串加密）
├── study-board.db        # 课表、卡片、门户等结构化数据
├── notes_library/        # 笔记正文，纯 Markdown，可直接当 Obsidian 库
├── timetable_images/     # 课表截图
└── icons_cache/          # 网站图标缓存
```

在「设置 → 数据位置」里可以：

- 更换笔记库目录（换到你的 Obsidian Vault 里也行）
- 打开**便携模式**，把数据放到程序同级目录，方便随 U 盘携带（需重启生效）

---

## 从源码构建

### 环境要求

- **Node.js 22.x**（仓库内有 `.nvmrc`，用 `nvm use` 即可）
- npm 10+
- Windows 上打包 macOS 安装包、或反过来，都是不行的 —— 各自平台需要在各自系统上构建，或用仓库自带的 GitHub Actions

### 命令

```bash
git clone <你的仓库地址>
cd study-board
npm ci

npm run dev          # 开发模式（热更新）
npm run typecheck    # 类型检查
npm run build        # 构建到 out/

npm run smoke             # 冒烟测试：起真实窗口，自检主进程 / preload / 界面
npm run smoke:timetable   # 课程表端到端：写入单元格 + 图片导入 + 渲染 + 截图
npm run bench             # 性能与内存基准，报告打到 stdout 并写入 .preview/
npm run bench:compare     # 对比两组基准报告（取中位数，并给出区间）
npm run icon              # 重新生成应用图标（纯脚本绘制，无图像库依赖）

npm run package:win  # 打 Windows 安装包 -> release/<版本>/
npm run package:mac  # 打 macOS dmg     -> release/<版本>/
```

冒烟测试与基准都会把数据写到**系统临时目录**里，不会碰到你真实的学习数据。
`npm run smoke:timetable` 会往 `.preview/` 里留两张截图（表格模式 / 图片模式），
在 CI 或没人盯着屏幕时也能确认渲染结果。

改动渲染路径或存储层之后，建议跑一次 `npm run bench` 确认没有退化。
测量方法、本次优化的实测数据、以及「试过但决定不做」的项，
都记在 [docs/PERFORMANCE.md](./docs/PERFORMANCE.md)。

### 自动发布

仓库里配置了 GitHub Actions（`.github/workflows/release.yml`）。推一个 tag 就会自动在 Windows 和 macOS 上分别构建，把安装包挂到 Release 里：

```bash
git tag v0.1.0
git push origin v0.1.0
```

---

## 隐私与安全

这个项目的安全承诺很具体，都可以自己验证：

- **不监听任何端口**。前后端通信走 Electron 的进程间通信，不启 HTTP 服务，`netstat -ano | findstr StudyBoard` 应该是空的
- **渲染层没有 Node 权限**。页面拿不到文件系统、拿不到命令行，只能调用白名单里的接口
- **页面不能联网**。内容安全策略里 `connect-src 'self'`，渲染层发不出任何外部请求
- **不收集任何数据**。没有统计、没有崩溃上报、没有自动更新回传
- **密钥不进配置文件**。AI Key 与 Notion Token 用系统钥匙串加密后单独存放，界面永远不回读

只有你主动点击学习网站、或主动使用 AI / Notion 功能时，才会发生网络请求，而且都由主进程代理，域名和参数都是明确的。

细节见 [docs/SECURITY.md](./docs/SECURITY.md)。

---

## 目录结构

```
src/
├── main/         主进程：唯一持有系统权限的地方
│   ├── ipc/      所有 IPC 处理器（按模块分文件）
│   ├── services/ 设置、资源协议等
│   ├── paths.ts  所有本地路径的唯一出口
│   └── security.ts 全局安全基线
├── preload/      安全桥：只暴露白名单接口
├── shared/       主进程与渲染层共享的类型与常量
└── renderer/     界面层：原生 TypeScript + Web Components，零框架
```

设计取舍与理由见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)，
性能与内存的测量方法和实测数据见 [docs/PERFORMANCE.md](./docs/PERFORMANCE.md)。

---

## 参与贡献

欢迎提 Issue 和 PR，请先读一下 [CONTRIBUTING.md](./CONTRIBUTING.md)。

特别欢迎这几类贡献：

- 新平台适配（Linux）
- 笔记编辑器体验优化
- 翻译（当前只有简体中文）

---

## 许可证

[MIT](./LICENSE)

---

## English

**StudyBoard** is an offline-first desktop app that combines a class timetable with course note-taking.

- **Timetable**: table mode (8 columns, 1–20 periods) or image mode (up to 3 screenshots, incl. HEIF)
- **Study hub**: quick links to learning sites, flip-able course cards, Markdown & rich-text note editor
- **Notes** live as plain `.md` files in `notes_library/`, which works directly as an Obsidian vault
- Export to PDF / Word / Markdown, optional Notion sync, optional AI assistant

**Privacy by design**: no listening ports, no telemetry, no network access from the UI process. Everything stays on your machine.

Download from [Releases](../../releases). Build from source with `npm ci && npm run dev`.
