# AGENTS.md — 学习看板 StudyBoard

> **进入本项目先读这三个文件，顺序不可颠倒：**
> 1. `AGENTS.md`（本文件）—— 项目全局：是什么、怎么构建、什么红线
> 2. `HANDOFF.md` —— 战术状态：现在在哪、卡在哪、下一步精确动作
> 3. `DECISIONS.md` 最近 5–10 条 —— 演进脉络与已否方案
>
> 读完做**代码对账**（`git status` / `git log --oneline -10` / 核对 HANDOFF 产物清单），
> 文档与代码冲突时**永远信代码**。然后向用户一句话复述「我要做 X，卡点是 Y，
> 下一步是 Z」，确认后再动手。

---

## 这是什么

**完全离线**的课程表 + 课程笔记看板，Electron 桌面应用。
数据全部存在用户本机，不做账号、不做云同步、不做遥测。

- 版本：`0.3.0`（package.json）
- 许可：MIT，版权人 `salty`
- 平台：Windows x64（macOS 能构建但**未签名不可用**，见下）

## 技术栈与目录

| 目录 | 内容 |
|---|---|
| `src/main/` | 主进程：服务、IPC handler、自检（smoke） |
| `src/renderer/` | 渲染层：视图、组件、编辑器、样式 |
| `src/shared/` | 两侧共用：类型、常量、i18n 词典、IPC 契约 |
| `src/preload/` | 上下文隔离的桥 |
| `build/` | NSIS 安装器脚本（`installer.nsh`） |
| `scripts/` | 构建/自检/基准的入口脚本 |
| `extension/` | 浏览器扩展（把学校网站下载的 PDF/PPT 存到收件箱） |

技术选型：Electron 44 + electron-vite + TypeScript（严格模式）+ 原生 DOM（**没有前端框架**）。
编辑器是 CodeMirror（Markdown 模式）与 TipTap（富文本模式）**动态 import** 的双实现。

## 常用命令

```bash
npm run dev            # 开发（热重载）
npm run typecheck      # 类型检查（node + web 两套 tsconfig）
npm run build          # 构建生产产物到 out/
npm run package:win    # 打 Windows 安装包 → release/<版本>/
npm run package:mac    # 打 macOS（未签名，产物不可用，见下）

# 自检（核心保障，见下）
npm run smoke                  # 基础场景
npm run smoke:timetable        # 课表：单格编辑、增量重绘、图片模式
npm run smoke:calendar         # 日历：课表事件按周次出现 + 自建日程 + 重复 + 提醒 + 持久化
npm run smoke:portal           # 网站门户
npm run smoke:cards            # 课程卡片三态（在学/想学/已学）
npm run smoke:notes            # 笔记：编辑器、图片预览、导出
npm run smoke:sync             # 同步与冲突
npm run smoke:export           # 导出
npm run smoke:ai               # AI 助手
npm run smoke:notion           # Notion 推送/拉取
npm run smoke:security         # 安全闸（17 条断言）
npm run smoke:materials        # 课程资料：导入闸、HEIC、缩略图
npm run smoke:update           # 数据闸口：降级保护
npm run smoke:migrate          # 数据闸口：老数据升级
npm run smoke:i18n             # 以英文启动 + 逐页截图（肉眼核对漏翻）
```

## 自检（smoke）是硬闸门

**这是本项目最重要的工程约束**，比测试覆盖率重要得多。

自检会**真的启动一个 Electron 实例**，用隔离的临时数据目录，走真实交互路径
（点击、双击、填值、保存），然后断言界面上的实际结果。

几条必须知道的规则：

1. **提交前跑，打包前跑。** `npm run package:win` 不会替你跑自检。
2. **自检跑的是「测试版构建」**（`STUDY_BOARD_TEST_BUILD=1`），会覆盖 `out/`。
   所以**自检必须排在 `npm run build` 之前**，否则打出来的包里混着测试代码。
   `scripts/smoke.mjs` 里有一条双向校验会拦住这种情况。
3. **断言要看「真实结果」，不要看「元素在不在」。** 例如图片必须断言
   `naturalWidth > 0`（src 写对但被 CSP 挡住时元素照样在 DOM 里）；文案必须
   断言渲染出来的文字（只看下拉框的值会漏掉「值变了但界面没变」）。
4. **失败先怀疑测试，再怀疑产品。** 但两种可能都要走到底 ——
   历史上两类都出现过（见 `HANDOFF.md` 坑位区）。
5. **别为了通过而放宽断言。** 放宽断言等于把闸门拆了。

### 环境注意事项（会浪费你很多时间，先看）

- **`run_in_background` 的任务会被沙箱拦住**，即使传了 `dangerouslyDisableSandbox`。
  必须**前台**跑；前台超时会自动转后台并保留提权。
- 连续跑多个 Electron 实例时，**渲染进程偶发被外部 kill**
  （日志里是 `渲染进程崩溃： killed` / `child-gone`）。隔 10 秒重跑即过。
  跑全套时用「失败重试」循环。
- **PowerShell 工具在本环境不返回 stdout**（只有 exit code），要拿输出用 bash。
- `reg.exe` 在程序黑名单里，**不能用**（连 `reg query` 都不行）。
- safe-delete 对**绝对路径**有 bug（会把 cwd 拼到路径前面），
  删 TEMP 里的东西可能失败。
- 上游镜像偶发 **502 Bad Gateway**（下载 electron / NSIS 工具时），重跑即可。

## 数据与存储

- 默认数据根：`%APPDATA%\StudyBoard`
- **便携模式**：程序同级目录下的 `study-board-data/`（靠 `portable.flag` 探测）
- 各存储都是**原子写**（临时文件 + rename）
- **数据格式版本闸口**：数据根目录的 `data-version.json` 记录 `schema` 与
  写入它的 app 版本。启动时（建存储之前）过闸口，四条分支：
  - `fresh` → 写印记
  - `same` → 只刷新 app 版本号
  - `upgrade` → **先整目录备份到 `.backups/`** 再逐级迁移
  - `downgrade`（数据比程序新）→ 备份 + 显著提示，**但继续启动**

**改任何存储的读写格式，必须同时**：
1. 递增 `DATA_SCHEMA`
2. 在 `src/main/services/dataVersion.ts` 注册迁移函数
3. 加自检场景（参考 `smoke:update` / `smoke:migrate`）

## 安全红线

- 渲染层 CSP 是 `default-src 'none'`，**只放行 `'self'` / `data:` / `blob:` / `sb-asset:`**，
  **没有任何 http(s)**。这条是「不联网」承诺的技术实现，不要为了图方便放宽。
- 本地文件通过自定义协议 `sb-asset://` 提供，**必须做路径逃逸校验**
  （`smoke:security` 里有 `assetEscapeOk` 等断言盯着）。
- 唯一的联网动作是用户主动触发的：AI「测试连接」、抓取网站图标。
  新增任何网络请求前先想清楚这条。
- **密钥不落明文**：AI Key 与 Notion Token 存系统钥匙串，界面不回读。
- 密钥、token、密码**绝不写入交接文件**。

## i18n

- 词典在 `src/shared/i18n/`（`zh-CN.ts` / `en-US.ts`），**扁平点分 key**
- 渲染层用 `t()`；展示主进程抛的中文错误用 `tm()`
- **缺翻译是两层降级**：英文缺 → 回落中文；两边都缺 → 显示 key 本身
- **加词条必须两边一起加**，`dictionaryOk()` 断言会列出差异
- 改完必须跑 `npm run smoke:i18n`（以英文启动 + 逐页截图）
  —— grep 只能证明「源码里没有中文」，证明不了「界面上没有中文」

## 发布

- 版本号在 `package.json`；产物在 `release/<版本>/`
- GitHub Actions：`.github/workflows/release.yml`，推 `v*` tag 触发
- **安装包没有代码签名** → 用户首次运行会看到 SmartScreen 拦截框。
  README 与 Release 正文里都写明了怎么绕过。
- **macOS 未签名 = 完全打不开**（Gatekeeper 直接拦，不是 Windows 那种可绕过）。
  所以 mac job 只验证构建，**不往 Release 挂**。

## 平台规则文件

本项目没有 CLAUDE.md / .cursorrules / .trae 规则。若将来新增，
只在其中加一行：「进入本项目先读根目录 `AGENTS.md`、`HANDOFF.md`、`DECISIONS.md`，
并遵守其协议」，不要复制协议正文。
