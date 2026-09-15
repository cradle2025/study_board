# HANDOFF.md — 战术交接

> 本文件**每次交接覆盖重写**，只保留当前战役。
> 历史由 git 承担；跨战役的决策沉淀进 `DECISIONS.md`。
>
> 交接时间：2026-09-15 晚
> 交接人：小鲸（DeepSeek 娘）
> 交接时的 HEAD：`0aecbf9`（`chore: LICENSE 版权人改成 salty`）

---

## 1. 目标与范围边界

### 当前战役：**课表支持「按周次不同」**

用户原话：「每一周的课表可能都不一样，这一点需要做成新功能」。

已与用户确认的两个设计前提（**不要再重新辩论**）：

1. **做到「单元格级周次」** —— 用户明确选了三个方案里最灵活的那个，
   即每个格子标记适用周次（每周/单周/双周/指定周），**同一时间段可以并存多门课**。
2. **老数据自动铺到所有周次** —— 现有已录入的课视为「每周都上」，
   用户只需补充「只有某些周才上」的课。对现有数据零操作。

### 边界（不要越界）

- **不要动**笔记、课程卡片、资料、门户、AI、Notion 这些模块。
- **不要**顺手做「整列复制」—— 用户明确说了**不值得，不做**。
- 这次要动**数据格式**，所以必须同步处理迁移（见第 8 节）。
- 版本号建议升到 **0.4.0**（数据格式变更）。

---

## 2. 已完成事实（均附验证方式）

### 2.1 发布链路（本战役之前的成果，已闭环）

| 事项 | 状态 | 验证方式 |
|---|---|---|
| 数据格式版本闸口 | 完成 | `npm run smoke:update` + `npm run smoke:migrate` 通过 |
| 便携模式数据在升级中不丢 | 完成 | 实机：装 0.3.0 → 植入数据 → 覆盖安装 → 数据完好 |
| 便携模式开关真的生效 | 完成 | 走 `settings:set-portable` 通道，真的搬数据 |
| 界面完整双语（602 词条） | 完成 | `npm run smoke:i18n`；渲染层只剩 2 处 `console.*` 中文 |
| 署名 salty | 完成 | `package.json` 的 `author`、`LICENSE` 版权人 |
| GitHub Actions 发布工作流 | 完成 | `.github/workflows/release.yml`（**从未在真实 Actions 上跑过**，见第 4 节） |

### 2.2 课表「连堂复用」（上一个战役，已闭环）

| 事项 | 状态 | 验证方式 |
|---|---|---|
| 「复制上一节」按钮 | 完成 | `npm run smoke:timetable` 的 `reuseOk: true` |
| 「复用已录入的课程」下拉 + 原生 autocomplete | 完成 | 同上，`reuseOptionCount: 5` |
| 编辑器高度上限（防止按钮掉出视口） | 完成 | `src/renderer/styles/base.css` 的 `.sb-tt-editor` |

### 2.3 全量自检

交接时**15 个场景全绿** + `npm run typecheck` 通过。
跑法见 `AGENTS.md`；全套约 7 分钟（含重试）。

### 2.4 当前发布候选产物

```
release/0.3.0/StudyBoard-0.3.0-win-x64-setup.exe   106,596,634 字节
sha256  4afb948724a79f806705595e32d6a541ef2b5e46b2e348b5856ee83c97f3246f
```

验证方式：`sha256sum release/0.3.0/StudyBoard-0.3.0-win-x64-setup.exe`

包内容已审计：`out/main/index.js` 里「自检」出现 **0 次**；asar 361 条目，
smoke / bench / sourcemap / secrets 全为 0。

---

## 3. 进行中半成品

**无。** 工作区干净（`git status` 无输出），所有改动已提交。

---

## 4. 阻塞与未决

| 事项 | 卡在哪 | 需要谁 |
|---|---|---|
| **GitHub 仓库还没建** | 用户第一次做，我给了逐步指导但还没执行 | **用户**：填表建仓库 → `git push` |
| **代码签名签不签** | 需要花钱（OV 约 $200/年，EV 约 $400/年） | **用户**决策 |
| **Actions 工作流从未真跑过** | 依赖仓库先建好 | 建仓库后第一次推 tag 才能验证 |
| **macOS 构建** | 未签名 = 完全打不开；需要 Apple Developer 账号（$99/年）+ 公证 | 用户决策 |

### 关于 GitHub 仓库（给用户的指导已发出，此处存要点）

- 仓库名建议 `study-board`
- **表单里「添加 README / .gitignore / 许可」三项必须全部关掉** ——
  本地仓库已有这三样，让 GitHub 再建一份会导致第一次 push 被拒
  （`non-fast-forward`，报错信息对新手完全不可读）
- 可见度：要给别人下载安装包就必须**公开**（私人仓库的 Release 对非协作者是 404）
- 用户 GitHub **显示名**是 `摇篮2025`，但登录名（ASCII）**尚未确认** ——
  填 `repository` 字段前必须先问清楚

---

## 5. 关键决策及理由（本战役相关子集）

### 5.1 周次功能为什么必须「整套一起改」

**做了什么**：决定数据层与 UI 层必须同一次落地，不做「先数据后 UI」的分阶段。

**为什么**：数据层先支持「一格多门课」、而 UI 还按「一格一门课」读写的话，
用户双击编辑一个格子再保存，**会静默删掉这一格里其它周次的课** ——
没有任何提示，用户只会发现课没了。

**否掉了什么**：「先改 store + 迁移，UI 下个会话再跟」这个看似稳妥的分阶段方案。

**下一步依赖**：无。

### 5.2 周次规则的数据形状

```ts
type WeekRule =
  | { kind: 'all' }                    // 每周
  | { kind: 'odd' }                    // 单周
  | { kind: 'even' }                   // 双周
  | { kind: 'list'; weeks: number[] }  // 指定周（如 [1,3,5] 或 1–8 展开）
```

**为什么这么选**：这四种恰好覆盖国内教务系统的常见表达；用判别联合而不是
「`weeks: number[]` + 特殊空值」，是因为「每周」和「单周」语义不同，
塞进同一个数组会让渲染层到处写 `if (weeks.length === 0)` 这种判空。

### 5.3 迁移策略（用户选定）

现有 `cells` 的每个格子 → 包成**单元素数组**，补 `id`，`weeks` 设为 `{kind:'all'}`。
因为闸口在迁移前会**整目录备份**，这一步可回退。

### 5.4 其他相关决策

见 `DECISIONS.md`（尤其 D-001 数据格式闸口、D-004 i18n 的扁平 key 与两层降级）。

---

## 6. 坑位记录（五段式）

### K-001 · 探针模板字符串里不能出现反引号

- **现象**：改 `src/main/smoke.ts` 里的探针后，`tsc` 报
  `error TS1005: ',' expected`，位置指向探针内部某行，看不出跟反引号有关。
- **根因**：探针本身是一个 `` `...` `` 模板字符串。在它的注释里再写一对反引号
  （例如 `` `loading="lazy"` ``）会**提前截断模板**，后面的代码变成普通文本。
- **解法**：探针的注释里**一律不写反引号**，用引号或直接写标识符。
- **验证方式**：`npx tsc --noEmit -p tsconfig.node.json` 无报错。
- **失效模式**：只影响 `smoke.ts` 里那几个 `*_PROBE` 常量；
  普通源码里的模板字符串不受此限。

### K-002 · 图片断言必须考虑 `loading="lazy"`

- **现象**：`smoke:materials` 的 `imageThumbOk` 约 50% 概率失败，
  失败信息看着像「缩略图坏了」。
- **根因**：缩略图是 `loading="lazy"`。落在首屏之外时 Chromium
  **根本不发起请求** —— 元素在、`src` 正确，但 `currentSrc` 为空、`complete` 为 false。
  图在不在首屏内取决于布局时机，所以时好时坏。
- **解法**：断言里**显式把 `loading` 置为 `eager` 并重设 `src`** 强制发起加载。
  （`scrollIntoView` 试过，**不可靠**：四次里四次仍然没加载。）
- **验证方式**：`npm run smoke:materials` 连跑 4 次全绿。
- **失效模式**：这条只解决「测试触发不了懒加载」。
  如果将来改成 `IntersectionObserver` 之类的自定义懒加载，要重新处理。

### K-003 · 改了 `Record<X, string>` 表之后必须 grep 所有取值处

- **现象**：把 `TAB_LABEL` / `TAB_EMPTY` 从「存文案」改成「存 key」后，
  界面上**直接显示 key 本身**（`study.tab.learning`）。渲染不报错、控制台无输出。
- **根因**：漏了三个调用点没包 `t()`。表里存 key 之后，漏包的调用点
  不会编译失败（`string` 还是 `string`），只是把 key 当文案渲染出来。
- **解法**：改完这类表**立刻 grep 一遍所有取值处**。
  本项目涉及的表：`TAB_LABEL` / `TAB_EMPTY` / `STATUS_TOAST` / `STATUS_ACTIONS` /
  `MODE_LABEL` / `MODE_HINT` / `EXPORT_ITEMS` / `AI_PRESETS`。
  注意 `STATUS_ACTIONS[...]` 返回**数组**，`t()` 加在内层字段上，grep 看着「没包」是对的。
- **验证方式**：`npm run smoke:cards` 的 `statusOk`；
  更普适的是 `npm run smoke:i18n`（界面上不该出现 key 形式的文本）。
- **失效模式**：只在「表的值会被渲染」时才有意义；纯内部用的表不受影响。

### K-004 · 往 fixed 浮层加内容前先看容器有没有高度约束

- **现象**：给课表单元格编辑器加了一项「复用已录入的课程」之后，
  在小窗口 / 高 DPI 缩放 / 锚点靠下的情况下，编辑器底部的「保存」按钮
  **被推出视口且无法滚动到**。
- **根因**：`showFloating` 的 `place()` 只保证「尽量放进视口」：
  翻转也放不下时把 `top` 夹在上边距 —— 元素比视口还高时底部就出界了。
  而 `.sb-tt-editor` **没有 `max-height`**。
  这段逻辑读起来像「已经处理好了」，其实只处理了「放得下但位置不合适」。
- **解法**：`.sb-tt-editor` 加 `max-height: calc(100vh - 24px)` + `overflow-y: auto`。
- **验证方式**：`npm run smoke:timetable` 通过；肉眼在小窗口下打开编辑器确认可滚动。
- **失效模式**：其他 fixed 浮层（模态卡片等）如果也长了内容，
  要各自检查有没有高度约束。

### K-005 · 便携数据的升级保护依赖「被升级版本自己也带这段逻辑」

- **现象**：装 0.1.0（无保护）→ 植入 `study-board-data` → 装 0.3.0（有保护），
  **数据被删了**。
- **根因**：升级时安装程序先执行的是**已安装版本**的卸载器，
  不是新版编译出来的那个。
- **解法**：无法在单侧修好。已把约束写进 `build/installer.nsh` 的注释，
  并把 `SB_STASH_DIR` 标成**跨版本契约**（升级时「暂存到哪」由旧版卸载器决定，
  「从哪恢复」由新版安装程序决定 —— 改这个路径会让从旧版升级的数据留在 `$TEMP`）。
- **验证方式**：装 0.3.0 → 植入数据 → 再用 0.3.0 覆盖安装 → 数据完好。
- **失效模式**：对初版无影响（0.1.0/0.2.0 从未发布）。
  **但如果将来改了 `SB_STASH_DIR`，从旧版升级会「看起来丢了数据」。**

### K-006 · Python 批量改写源码时的三个固定坑

- **现象**：脚本改完文件后，`tsc` 报奇怪的语法错，或 `git diff` 变成整个文件重写。
- **根因**（三个独立原因，都踩过）：
  1. **`str.replace` 默认替换全部**。用「插到某锚点之前」的写法时，
     锚点若出现多次会插多份（本项目在 `smoke.ts` 里造出过重复函数）。
  2. **路径字符串 `r'D:\...\'` 以反斜杠结尾会吞掉结束引号**。
  3. **读写带 CRLF 的文件没用 `newline=''`**，Python 会把整个文件转成 LF。
- **解法**：
  1. 替换前确认锚点唯一，或显式传 `count`；**替换后立刻 grep 计数验证**。
  2. 路径用正斜杠。
  3. `io.open(p, encoding='utf-8', newline='')`。
- **验证方式**：改完 `npx tsc --noEmit` + `git diff --stat` 看行数是否合理。
- **失效模式**：只影响「用脚本批量改源码」这种工作方式。

---

## 7. 产物清单

| 产物 | 路径 | 验证方式 |
|---|---|---|
| 发布候选安装包 | `release/0.3.0/StudyBoard-0.3.0-win-x64-setup.exe` | `sha256sum` = `4afb9487...`（全量见下） |
| 差分更新块索引 | `release/0.3.0/*.blockmap` | 存在即可（将来做自动更新要用） |
| 发布工作流 | `.github/workflows/release.yml` | 推 `v*` tag 触发；**从未真跑过** |
| 安装器脚本 | `build/installer.nsh` | 注释里写了 `SB_STASH_DIR` 的跨版本契约 |
| 自检场景 | `src/main/smoke.ts` + `scripts/smoke.mjs` | 15 个场景，见 `AGENTS.md` |
| 中英词典 | `src/shared/i18n/{zh-CN,en-US}.ts` | 602 条，`dictionaryOk()` 断言对齐 |
| 英文界面截图 | `npm run smoke:i18n` 生成（`.preview/i18n-*.png`） | 肉眼核对漏翻 |

完整校验和：`4afb948724a79f806705595e32d6a541ef2b5e46b2e348b5856ee83c97f3246f`

> 注：`.preview/` 是自检的临时产物目录（已在 `.gitignore` 里），
> 交接时已清空。需要截图时重跑 `npm run smoke:i18n` 会重新生成。

---

## 8. 下一步精确动作

### 第 0 步：接手对账（必做）

```bash
cd <项目根>
git log --oneline -5          # 应看到 0aecbf9 在 HEAD
git status                    # 应无输出
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
npm run smoke                 # 应通过（约 1 分钟）
```

任何一项不符 → 先查清楚再往下走，不要基于幻觉现状开工。

### 第 1 步：改数据模型（`src/shared/types.ts`）

```ts
export type WeekRule =
  | { kind: 'all' }
  | { kind: 'odd' }
  | { kind: 'even' }
  | { kind: 'list'; weeks: number[] }

export interface TimetableCell {
  /** 新增：同一格多门课要能区分、要能单独增删改 */
  id: string
  courseName: string
  teacher: string
  location: string
  remark: string
  duration: string
  /** 新增：适用周次 */
  weeks: WeekRule
}
```

`TimetableData` 的改动：

```ts
  /** key = "节:列"，值是**这一格上的所有课**（不同周次可以并存） */
  cells: Record<string, TimetableCell[]>
  /** 一学期多少周 */
  weekCount: number
  /** 当前查看第几周；0 = 不按周次过滤（看全部） */
  currentWeek: number
```

同时在 `src/shared/limits.ts` 加 `DEFAULT_WEEK_COUNT`（建议 16）与
`MAX_WEEK_COUNT`（建议 30）。

### 第 2 步：迁移（`src/main/services/dataVersion.ts`）

1. `DATA_SCHEMA` 从 `1` 递增到 `2`
2. 注册 v1 → v2 迁移：每个 `cells[key]` 的单对象 →
   `[{ ...cell, id: <新生成>, weeks: { kind: 'all' } }]`；
   `weekCount` 填 `DEFAULT_WEEK_COUNT`，`currentWeek` 填 `0`
3. **迁移必须幂等**：已经是数组的不再包一层
4. 备份逻辑已存在（闸口在迁移前整目录备份），不用重写

### 第 3 步：存储（`src/main/services/timetable.ts`）

- 形状校验要认新结构，且**拒绝**没有 `id` 或 `weeks` 非法的新数据
- 单格操作从「整格覆盖」改成**按 `id` 增删改**：
  - `setCell(key, cell)` → 保留（有 `id` 则替换，无则新增）
  - `removeCell(key, id)` → 新增
- **同时加批量接口**（这次用得上，且避免 N 次整文件重写）：
  `setCells(entries: Record<string, TimetableCell[]>)`，
  内部一次性应用、**只 `#persist()` 一次**
- `#persist()` 是整份 `timetable.json` 重写（临时文件 + rename），
  所以**任何「一次逻辑操作」都应该只触发一次 persist**

### 第 4 步：IPC 契约（三个文件，别找错）

课表相关的东西分散在三处，**没有一个叫 `ipc.ts` 的文件**：

| 文件 | 放什么 |
|---|---|
| `src/shared/channels.ts` | 通道名常量，如 `TIMETABLE_SET_CELL: 'timetable:set-cell'` |
| `src/shared/api.ts` | 桥的**类型契约**（`window.studyBoard` 的形状） |
| `src/preload/index.ts` | 桥的实现（把调用转成 `ipcRenderer.invoke`） |

新增「按 id 删一门课」的话，三处都要加。
改完 `npm run typecheck` 会替你检查两侧是否对齐 —— 契约是共用的，
漏改一侧编译不过。

### 第 5 步：渲染层

**`src/renderer/components/timetable-panel.ts`**（工作量最大）

- 一格渲染多门课：`data.cells[key]` 现在是数组。
  建议堆叠显示，每门课带一个周次标记（如「单周」小角标）
- 按 `currentWeek` 过滤：`currentWeek === 0` 时显示全部
- 编辑器改成「列出这一格的所有课，每门可单独编辑/删除」+「＋ 添加另一门」
- 每门课的编辑里加**周次规则选择器**（每周 / 单周 / 双周 / 指定周）

**`src/renderer/views/timetable-editor-view.ts`**

- 加「当前第几周」选择器（含「全部」）
- 加「一学期多少周」的设置项

### 第 6 步：i18n

新增约 25 条 × 2 语言。**两边一起加**，否则 `dictionaryOk()` 会失败。
改完跑 `npm run smoke:i18n`。

### 第 7 步：自检

在 `smoke:timetable` 里加断言，至少覆盖：

1. **迁移**：构造一份 v1 形状的数据 → 启动 → 断言变成了 v2 形状、
   原课程还在、`weeks` 是 `{kind:'all'}`、**且迁移前有备份**
2. **一格多课**：往同一格写两门课（单周 / 双周）→ 断言两门都在
3. **周次过滤**：切到第 3 周 → 断言只显示单周那门；切到第 4 周 → 只显示双周那门
4. **不误删**：编辑同一格里的第一门课并保存 → 断言第二门**还在**
   （这条直接盯着第 5.1 节那个风险）

### 第 8 步：版本与打包

1. `package.json` 版本升到 **0.4.0**
2. `npm run typecheck && npm run smoke` 全绿
3. `npm run package:win`
4. 审计：`out/main/index.js` 里「自检」应为 **0 次**；
   asar 里 smoke / bench / sourcemap / secrets 应为 **0**
5. 更新本文件与 `DECISIONS.md`，commit（message 注明 handoff）

---

## 交接五问自检

1. **零提问测试** —— 新 agent 只读三件套 + 代码，能直接接手吗？
   ✅ 能。周次功能的形状、迁移策略、每一步改哪个文件、断言写什么都在第 8 节。
2. **重辩论测试** —— 会不会重新辩论已定的决策？
   ✅ 不会。第 1 节写明「三个方案里选了单元格级周次」「老数据铺到所有周次」，
   第 5.1 节写明「为什么不能分阶段」。
3. **验证测试** —— 能一条命令验证产物是对的吗？
   ✅ 能。`sha256sum` + `npm run smoke`（15 场景）。
4. **回头路测试** —— 知不知道哪些方案已被否？
   ✅ 知道。整列复制（用户明确否决）、「先数据后 UI」的分阶段（技术否决）。
5. **猝死测试** —— 十分钟后上下文清空，损失什么？
   ✅ 无。所有状态已落盘，工作区干净。
