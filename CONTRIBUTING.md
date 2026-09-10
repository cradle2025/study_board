# 参与贡献

感谢你有兴趣参与。下面几条请先看一下，能省下不少来回。

---

## 开发环境

```bash
nvm use              # 使用 .nvmrc 指定的 Node 版本（22.x）
npm ci               # 严格按 package-lock.json 安装
npm run dev          # 启动开发模式
```

提交前请确保这三条都通过：

```bash
npm run typecheck    # 类型检查，必须零错误
npm run build        # 构建必须成功
npm run smoke        # 冒烟测试：应用能起、界面能挂载
```

`npm run smoke` 会启动一个真实窗口，渲染层加载完成后自动退出，退出码 0 表示通过。适合在改完主进程/preload 后快速自检。

---

## 代码约定

### 类型

- 全程 TypeScript，`strict: true`，`noUncheckedIndexedAccess: true`
- 用 `import type` 导入纯类型（开了 `verbatimModuleSyntax`）
- 跨进程共享的类型一律放 `src/shared/`，不要在主进程和渲染层各写一份

### 安全底线

以下内容请**不要**修改，改了大概率会被打回：

- `BrowserWindow` 的 `sandbox` / `contextIsolation` / `nodeIntegration` 相关配置
- `src/main/security.ts` 里的导航拦截、窗口拦截、权限拒绝
- `src/main/paths.ts` 的 `safeJoin` 校验
- `index.html` 里 CSP 的收紧方向（可以更严，不能更松）

### 新增 IPC 通道

这是最常见的改动，流程固定：

1. 在 `src/shared/channels.ts` 登记通道名
2. 在 `src/shared/api.ts` 声明渲染层可见的方法签名
3. 在主进程 `src/main/ipc/` 下对应模块实现处理器，**入参必须做校验**
4. 在 `src/preload/index.ts` 暴露方法
5. 启动自检会自动检查是否有通道漏注册

不要在渲染层直接 `ipcRenderer.invoke` —— 渲染层根本拿不到 `ipcRenderer`。

### 新增运行时依赖

加之前先问自己：**能不能用纯 JS 实现？**

- 能用纯 JS 就别用原生模块 —— 原生模块会让「双平台免编译构建」这件事失效
- 能用标准库就别引依赖 —— 生产依赖目前只有 7 个，希望能保持在这个量级
- 引入新依赖时请说明体积影响

### 界面

- 不引入前端框架。用原生 TypeScript + Web Components
- 样式类名前缀 `sb-`
- 只用各版本 Chromium 都稳定支持的 CSS 特性，避免嵌套语法、`color-mix()`、`:has()` 这类新特性
- 颜色一律走 `src/renderer/styles/base.css` 里的 CSS 变量，不要写死色值 —— 否则深色模式会挂

---

## 提交 PR

- 一个 PR 做一件事。杂糅的重构 PR 很难 review
- 说明**为什么**这么改，而不只是改了什么
- 涉及界面的改动，附一张截图
- 涉及安全相关文件的改动，请在描述里单独说明

## 提交 Issue

- Bug 请附上：系统版本、应用版本、复现步骤、预期与实际结果
- 有报错的话，把完整报错贴上来
- 功能建议请说明使用场景，而不只是"想要某个功能"

---

## 特别欢迎的贡献

- **Linux 支持**（打包配置 + 平台差异处理）
- **英文翻译**（目前只有简体中文，代码里已预留 i18n 结构）
- **笔记编辑器体验优化**
- **文档改进** —— 尤其是「新手照着做卡住了」的地方
