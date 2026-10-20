# ReviewX 设计系统

> 来源：设计稿「ReviewX 设计方向探索」· v2 交互原型（单组件原型 `prototype/app.dc.html` 及其 7 个状态画板）
> 适用范围：ReviewX 桌面端（AI 代码检视工作台：检视队列、报告抽屉、规则配置、会话日志）
> 本文档从 v2 原型源码中提取，所有数值均与原型一致。

---

## 1. 设计原则

1. **安静的中性底色，颜色只用于表达状态。** 界面主体是白 / 浅灰 + 近黑文字；蓝、绿、红、橙只出现在状态、徽标和提示上。
2. **一个主操作。** 每个区域最多一个黑色主按钮（`btn-p`），其余用描边或文字按钮。
3. **状态可读、可追溯。** 每个 MR 都有明确的状态文案（检视中 3/7、2 条待处理、检视失败…），报告和处理记录只追加，不覆盖。
4. **人决定，AI 建议。** AI 意见默认「待处理」，必须由用户逐条「发送到 CodeHub」或「不发送」，所有操作可撤销。
5. **可访问性是默认值。** 真实的 `<button>` / `<a>`、`role="switch|dialog|status|tablist"`、`:focus-visible` 焦点环、尊重 `prefers-reduced-motion`。

---

## 2. 颜色

### 2.1 中性色（Ink / Surface / Line）

| Token | 值 | 用途 |
|---|---|---|
| `ink-900` | `#121212` | 主文字、主按钮底色、开关开启、Toast 底色 |
| `ink-800` | `#1f2328` | Markdown 正文标题、代码文字 |
| `ink-700` | `#3b3f42` | 次级强调文字、进行中状态、进度段（已完成） |
| `ink-600` | `#59636e` | 日志 INFO 文字 |
| `ink-500` | `#62686c` | **次要文字**（说明、元信息、文字按钮）——使用最多 |
| `ink-400` | `#8c9195` | 弱化文字（时间行、未开始步骤、禁用 Tab） |
| `ink-300` | `#a3a8ad` | 占位/从未获取的状态点 |
| `line-strong` | `#c6c9cc` | 输入框 / 次按钮描边、关闭的开关 |
| `line` | `#e1e3e6` | **默认分割线与卡片描边** |
| `line-soft` | `#e3e6e9` / `#eceef0` / `#eef0f2` | 列表行内分割、紧凑行容器 |
| `surface-0` | `#ffffff` | 页面、卡片、抽屉 |
| `surface-1` | `#f5f7f8` | 侧边栏、分段控件底、关闭按钮底 |
| `surface-1b` | `#f5f7fa` / `#f7f8fa` | 编辑器表头、普通 MR 卡片底 |
| `surface-2` | `#eef0f2` | 中性 Pill 底、行内代码底 |
| `surface-hover` | `#e8ebed` | 导航 / 文字按钮 hover |
| `surface-row-hover` | `#f7f8f9` | 列表行 hover |
| `code-bg` | `#f3f5f7`（组件）/ `#f6f8fa`（Markdown） | 代码块 |

### 2.2 品牌 / 交互色

| Token | 值 | 用途 |
|---|---|---|
| `blue-500` | `#007cff` | 焦点环、主按钮 hover 描边、进度条 |
| `blue-400` | `#3d9bff` | Logo 圆点 |
| `blue-700` | `#0059b8` | 链接、「待处理」文字、信息态 |
| `blue-800` | `#003f82` | 链接 hover |
| `blue-50` | `#eaf3ff` | 信息 Pill 底、导航徽标底 |
| `blue-25` | `#f5f9ff` / `#f4f8fe` | 信息条底、选中规则行、「下一个待处理」卡片底 |
| `blue-border` | `#c9dcf3` / `#cfe2fb` / `#8dbfff` | 信息条描边 |

### 2.3 语义色

| 语义 | 文字 / 图标 | 背景 | 描边 | 典型场景 |
|---|---|---|---|---|
| 成功 Success | `#18733f` | `#e3f9ec` / `#f3fbf6` | `#c7e5d2` | 已发布、已更新、已处理完、未发现问题 |
| 错误 Danger | `#ac3039`（hover `#8f2630`） | `#fff0f1` / `#fff8f8` | `#edc4c7` / `#efc9cc` | 检视失败、获取失败、发布失败、危险按钮 |
| 警告 Warning | `#9a4a08` | `#fff3e8` | `#e0a96b` | 需核对、日志 WARN |
| 提醒 Caution | `#7a4a10` | `#fdf6ec` | — | 「旧版本」标签、发送结果未知 |
| 中性 Muted | `#62686c` / `#3b3f42` | `#eef0f2` | — | 不发送、已被取代、排队中、只读 |

### 2.4 意见严重级别（Severity）

| 级别 | 标签 | 背景 | 文字 | 描边 |
|---|---|---|---|---|
| Fatal | `Fatal` | `#c62f3a` | `#ffffff` | `#c62f3a` |
| Major | `Major` | `#fdebdc` | `#a14a0b` | `#f2c49d` |
| Minor | `Minor` | `#fff6d6` | `#7a5b00` | `#ecd68c` |
| Suggestion | `Suggestion` | `#eaf1f8` | `#3d5a80` | `#c9d8ea` |

严重级别标签为方角（`radius 6px`）、`12px / 600`、`letter-spacing: .02em`，与圆角 Pill 区分。

### 2.5 代码高亮（GitHub Light 风格）

| 类型 | 颜色 |
|---|---|
| 默认 | `#1f2328` |
| 注释 | `#6e7781` |
| 字符串 | `#0a3069` |
| 关键字 | `#cf222e` |
| 数字 / 常量 | `#0550ae` |
| 函数 / 类型 | `#8250df` |

### 2.6 对比度约定

- 正文文字 ≥ 4.5:1；`#62686c` on `#ffffff` ≈ 5.6:1，可用于 12px 说明文字。
- `#8c9195` 仅用于非关键的弱化信息（时间、未开始步骤）。
- 需要区分的状态同时以**文案 + 圆点/图标**表达，不只依赖色相。

---

## 3. 字体

### 3.1 字体栈

```css
--font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial,
             'PingFang SC', 'Microsoft YaHei', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji';
--font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
```

- 全局 `font-variant-numeric: tabular-nums`，数字（时间、计数、MR 号）等宽对齐。
- MR 编号（`!404`）、提交哈希、时长、路径使用 `.mono`。
- 根元素：`14px / 1.5`，`-webkit-font-smoothing: antialiased`。

### 3.2 字号阶梯

| Token | 字号 / 字重 / 行高 | 用途 |
|---|---|---|
| `display` | 32px / 600 / 1.4 | 页面标题 H1（检视队列、规则配置、会话日志） |
| `title-lg` | 24px / 700 / 1.45 | 抽屉标题（MR 标题） |
| `title-md` | 24px / 600 | 抽屉内分区标题（检视意见） |
| `title-group` | 21px / 600 | 意见分组标题（含 `· N` 计数，计数 400 + `#8c9195`） |
| `empty-title` | 22–26px / 500 | 空状态标题 |
| `title-sm` | 17px / 600 / 1.5 | 项目分组标题、MR 卡片标题（最多 2 行）、确认弹窗标题 |
| `title-xs` | 16px / 600 | 意见卡片标题（单行省略）、编辑器标题 |
| `body-lg` | 15px / 1.6 | Markdown 意见正文 |
| `body` | 14px / 1.5 | 默认正文、导航、按钮（v2 按钮 14px） |
| `body-sm` | 13px | 说明、元信息、表格 |
| `caption` | 12px / 500 | Pill、徽标、字段标签、侧边栏小字 |

字重仅用 400 / 500 / 600 / 700，其中 600 用于绝大多数标题与按钮。

---

## 4. 间距、圆角、阴影

### 4.1 间距

基于 2px 细分、4px 主节奏：`2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 22 · 24 · 32 · 40 · 64`

| 场景 | 值 |
|---|---|
| 主内容区内边距 | `40px clamp(20px, 3vw, 44px) 64px` |
| 侧边栏内边距 / 分区间距 | `32px 20px 22px` / `24px` |
| 抽屉头部 / 内容内边距 | `22px clamp(18px, 4vw, 36px)` |
| MR 卡片内边距 | `20px 24px 18px` |
| 意见卡片头部 | `10px 18px`，`min-height: 60px` |
| 卡片网格间距 | `16px` |
| 项目分组上间距 | `32px` |
| 行内元素间距 | `8px` / `10px`（最常用） |

### 4.2 圆角

| Token | 值 | 用途 |
|---|---|---|
| `r-xs` | 2–4px | 进度段、行内代码 |
| `r-sm` | 6px | 严重级别标签、Markdown 代码 |
| `r-md` | 9–11px | Logo、导航项（10）、输入框 / 代码块（11） |
| `r-lg` | 12–14px | 确认条（12）、信息条（13）、**卡片 / 浮层（14）** |
| `r-xl` | 15–16px | 抽屉内状态面板（15）、编辑器面板（16） |
| `r-2xl` | 18px | 模态对话框 |
| `r-full` | 999px | 按钮、Pill、分段控件、开关、Toast |

### 4.3 阴影（全部基于 ink `rgb(18 18 18)`）

| Token | 值 | 用途 |
|---|---|---|
| `shadow-drawer` | `-12px 0 48px rgb(18 18 18 / 7%)` | 右侧抽屉 |
| `shadow-pop` | `0 10px 32px rgba(18,18,18,.14–.16)` | 下拉菜单、检视队列浮层 |
| `shadow-toast` | `0 8px 24px rgba(18,18,18,.25)` | Toast |
| `shadow-modal` | `0 16px 48px rgba(18,18,18,.22)` | 确认对话框 |
| `shadow-knob` | `0 1px 2px rgba(0,0,0,.2)` | 开关滑块 |

卡片默认**无阴影**，靠 1px 描边区分层级。

---

## 5. 布局

- **画布宽度**：1440px 设计，流式布局（`expand: fill`），无固定宽度。
- **两栏结构**：`aside`（`flex: 1 1 300px`，`#f5f7f8` 底，右侧 1px 分割线）+ `main`（`flex: 999 1 560px`）。窄屏时自动换行为上下结构。
- **MR 卡片网格**：`grid-template-columns: repeat(auto-fill, minmax(440px, 1fr))`，`gap: 16px`；已完成/无需处理的 MR 折叠为紧凑行列表（行高 52px）。
- **抽屉**：右侧 `flex: 0 1 780px`，背景遮罩 `rgb(18 18 18 / 12%)` + `backdrop-filter: blur(6px)`；头部 `position: sticky`，意见卡片头部在其下方继续 sticky。
- **宽表格**：规则表 `min-width: 620px`，外层容器横向滚动。
- `html { scrollbar-gutter: stable; overflow-x: clip }` 防止抽屉开合时布局跳动。

---

## 6. 图标

- 24×24 viewBox 的线性图标，`fill: none; stroke: currentColor; stroke-width: 1.6; round caps/joins`。
- 尺寸：`.ico` 16px（默认）、`.ico-s` 12px（行内、箭头、外链）。
- 装饰图标一律 `aria-hidden="true"`；纯图标按钮必须有 `aria-label`。
- 不使用 emoji。

---

## 7. 组件

### 7.1 按钮 `.btn`

基础：`min-height 40px`、`padding 0 16px`、`radius 999px`、`14px / 600`、`gap 7px`、`white-space: nowrap`。卡片内紧凑尺寸 `min-height 34px; padding 0 15px`；图标按钮 `38×38`。

| 变体 | 默认 | Hover | 用途 |
|---|---|---|---|
| `btn-p` 主要 | 底 `#121212` / 字 `#fff` | 底 `#303030` + 描边 `#007cff` | 发送到 CodeHub、开始检视、重新检视 |
| `btn-s` 次要 | 底 `#fff` / 描边 `#c6c9cc` | 底 `#f5f7f8` / 描边 `#8c9195` | 不发送、去核对、停止检视 |
| `btn-q` 文字 | 透明 / 字 `#62686c`，`padding 0 10px` | 底 `#e8ebed` / 字 `#121212` | 撤销、全部展开、关闭 |
| `btn-d` 危险 | 底 `#ac3039` / 字 `#fff` | 底 `#8f2630` | 移除项目（仅在确认对话框中） |
| 禁用 | `opacity .42; cursor: not-allowed` | — | 发送中锁定 |

加载态：按钮内放 `.spin` + 进行时文案（「发送中…」「停止中…」「校验中」）。

### 7.2 Pill / 状态标签 `.pill`

`padding 3px 10px`、`radius 999px`、`12px / 500 / 1.6`、可选前置 `.dot`（5px 圆点，`currentColor`）或 `.spin`。底色/文字取自 §2.3 语义表。

MR 卡片底部的状态文案不用底色，只用「圆点 + 彩色文字」，例如 `● 2 条待处理`（`#0059b8 / 600`）。

### 7.3 MR 卡片

- `min-height 204px`、`padding 20px 24px 18px`、`radius 14px`、默认描边 `#e3e6e9` + 底 `#f7f8fa`。
- 结构：`!IID`（mono 600）+ 可选「旧版本」标签 → 标题（17px，最多 2 行）→ 时间行（13px `#8c9195`，单行省略）→ 可选 7 段进度条 → 底部状态 + 单个操作按钮。
- 变体：
  - **下一个待处理**：描边 `1.5px solid #0059b8`、底 `#f4f8fe`。
  - **检视失败**：底 `#fff8f8`、描边 `#efc9cc`，状态文字 `#ac3039`。
  - **所属项目获取失败（过期组）**：`opacity .55`。

### 7.4 七段进度条

`grid-template-columns: repeat(7, 1fr)`、`gap 3px`、每段 `height 4px; radius 2px`。已完成 `#3b3f42`、当前 `#9aa0a6`（呼吸动画 `rxbreathe`）、未开始 `#e1e3e6`。带 `role="img"` 与 `aria-label`（如「检视进度 3/7」）。

对应七个检视步骤：读取 MR 信息 → 拉取源分支 → 拉取目标分支 → 校验 MR 未变化 → 生成变更快照 → OpenCode 检视 → 保存报告与意见。

### 7.5 侧边栏导航 `.navlink`

`min-height 40px`、`padding 0 12px`、`radius 10px`、`14px #62686c`。当前项：底 `#fff`、描边 `#e1e3e6`、字 `#121212 / 500`，`aria-current="page"`。右侧徽标：`12px / 500`、`#eaf3ff` 底 `#0059b8` 字。

关注项目列表：状态圆点（7px，已更新 `#18733f` / 失败 `#ac3039` / 获取中 `#8c9195` / 未获取 `#a3a8ad`）+ 项目名 + `···` 菜单（28×28）。

### 7.6 抽屉（MR 详情）

- `role="dialog"`，右侧滑入：`rxdrawerin 260ms cubic-bezier(.22,1,.36,1)`（`translateX(32px)` → 0），关闭 `180ms ease-in`。
- 头部：标题 24px/700、副行（项目路径 · `!IID` 外链 · 源分支 → 目标分支）、右上 38px 圆形关闭按钮（`#f5f7f8` 底）。
- 历史分段 Tab：`role="tablist"`，容器 `#f5f7f8` + 1px 描边 + `padding 3px` + 全圆角；选中项白底描边。
- 内容状态：有待处理意见 / 检视进行中 / 检视失败 / 暂无检视记录 / 未发现问题 / 已归档（只读）。

### 7.7 检视意见卡片

- `radius 14px`、描边 `#e1e3e6`、`margin-top 18px`。
- Sticky 头部（`min-height 60px`）：严重级别标签 → 标题（单行省略，`title` 属性带全文）→ 处理状态 → 右侧操作（`不发送`（次）+ `发送到 CodeHub`（主））。
- 已处理的意见：文字降为 `#62686c`，出现「撤销」文字按钮。
- 正文 `.md`：15px/1.6 Markdown，`code` 85% + `rgba(175,184,193,.2)` 底；代码片段 `.code` 带行高 1.85 与语法高亮；「查看修复建议」「展开全部代码」可折叠。
- 分组：按处理状态排序（待处理/发送中 → 结果未知/失败 → 已处理），分组标题 21px + 8px 色点 + 延伸分割线。

意见处理状态：

| 状态 | 文案 | 底 / 文字 |
|---|---|---|
| pending | 待处理 | `#eaf3ff` / `#0059b8` |
| sending | 发送中… | `#eaf3ff` / `#0059b8` + spin |
| published | 已发布 | `#e3f9ec` / `#18733f` |
| manual | 已发布 · 人工确认 | `#e3f9ec` / `#18733f` |
| dismissed | 不发送 | `#eef0f2` / `#62686c` |
| unknown | 结果未知（需到 CodeHub 核对） | `#fdf6ec` / `#7a4a10` |
| failed | 发布失败 | `#fff5f5` / `#ac3039` |
| superseded | 已被新报告取代 | `#eef0f2` / `#62686c` |

### 7.8 状态面板与提示条

- **信息条**（`role="status"`）：`padding 12px 16px`、`radius 13px`、描边 `#c9dcf3`、底 `#f5f9ff`、13px。
- **失败说明**：描边 `#edc4c7`、底 `#fff8f8`、`radius 15px`、`padding 18px 20px`。
- **结论面板**（未发现问题 / 无可检视的变更）：成功描边 `#c7e5d2`，中性描边 `#c6c9cc`。
- **内联确认**（`role="alertdialog"`，如「其余全部不发送」）：`#f5f7f8` 底、`#c6c9cc` 描边、`radius 12px`。

### 7.9 表单

- `.field`：`min-height 40px`、`padding 8px 12px`、`radius 11px`、描边 `#c6c9cc`、13px；聚焦 `outline 2px #007cff` + 描边 `#007cff`；错误描边 `#ac3039` + `aria-invalid`。
- 字段标签：12px `#62686c`，`<label for>` 关联。
- 下拉（自定义 listbox）：触发器沿用 `.field`，`aria-haspopup="listbox"`；选项选中底 `#f0f2f4` + 600。
- 校验反馈在字段下方 `role="status"` 12px，颜色按 tone：bad `#ac3039` / info `#0059b8` / ok `#18733f` / muted `#62686c`。

### 7.10 开关 Switch

`role="switch"` + `aria-checked`，36×22、全圆角；开 `#121212`，关 `#c6c9cc`；滑块 16px 白色，`left` 3px ↔ 17px，`shadow-knob`。

### 7.11 浮层、对话框、Toast

- **浮层**（检视队列 / 下拉）：白底、`#e1e3e6` 描边、`radius 14px`、`padding 16px`、`shadow-pop`，宽 `min(560px, 100%)`。
- **模态对话框**：`role="dialog" aria-modal="true"`，`min(460px, 100%)`、`radius 18px`、`padding 22px 24px`、`shadow-modal`；操作区右对齐「取消（btn-s）+ 危险/主操作」。
- **Toast**：`role="status"`，底部居中 `bottom: 28px`，`#121212` 底白字、13px、全圆角、`padding 11px 18px`、`shadow-toast`，宽度 `max-width: calc(100% - 32px)`。

### 7.12 日志行

| 级别 | 标签底 | 标签字 | 行底 | 左侧色条（inset 3px） |
|---|---|---|---|---|
| INFO | `#eef0f2` | `#59636e` | `#ffffff` | 无 |
| WARN | `#fff3e8` | `#9a4a08` | `#fffcf8` | `#e0a96b` |
| ERROR | `#fbdde0` | `#ac3039` | `#fff0f1` | `#ac3039` |

### 7.13 Logo

32×32、`radius 9px`、`#121212` 底，白色小写 `rx`（17px / 700 / `letter-spacing -0.06em`）+ 4px `#3d9bff` 圆点；旁边字标 `ReviewX` 17px / 600 / `-0.02em`。

---

## 8. 动效

| 名称 | 定义 | 用途 |
|---|---|---|
| `rxspin` | `rotate(360deg)` 1s linear infinite | `.spin` 加载圈（10px，1.5px 描边，右侧透明） |
| `rxbreathe` | 50% `opacity .45` | 当前进度段 |
| `rxfadein / rxfadeout` | 260ms ease-out / 180ms ease-in | 遮罩 |
| `rxdrawerin / rxdrawerout` | 260ms `cubic-bezier(.22,1,.36,1)` / 180ms ease-in | 抽屉 |
| 展开 `rise` | 160ms，`translateY(-4px)` → 0 | 历史折叠内容 |
| 折叠箭头 | `rotate(90deg)`，150ms | 展开 / 收起 |

进入慢于退出（260 / 180ms）。`prefers-reduced-motion: reduce` 时关闭遮罩与抽屉动画。

---

## 9. 文案规范

- 简体中文，动词开头的操作：「开始检视」「发送到 CodeHub」「不发送」「去核对」「重新检视」「取消排队」。
- 进行中用省略号：「发送中…」「停止中…」「正在终止子进程…」。
- 状态带数字与步骤：「检视中 3/7」「2 条待处理」「1 条需核对」「步骤 7/7 输出格式无效」。
- 失败说明要给出原因与时间：「发送失败：网络不可用（14:30）」。
- 主动停止不算故障：「主动停止不计为故障，没有生成可发布的意见」。
- 专有名词保持原样：MR、CodeHub、OpenCode、FATAL/MAJOR/MINOR/SUGGESTION。

---

## 10. CSS Token 速查

```css
:root {
  /* ink */
  --rx-ink-900: #121212; --rx-ink-800: #1f2328; --rx-ink-700: #3b3f42;
  --rx-ink-500: #62686c; --rx-ink-400: #8c9195; --rx-ink-300: #a3a8ad;
  /* line & surface */
  --rx-line-strong: #c6c9cc; --rx-line: #e1e3e6; --rx-line-soft: #eef0f2;
  --rx-surface-0: #ffffff; --rx-surface-1: #f5f7f8; --rx-surface-2: #eef0f2;
  --rx-surface-hover: #e8ebed;
  /* brand */
  --rx-blue-500: #007cff; --rx-blue-700: #0059b8; --rx-blue-800: #003f82;
  --rx-blue-50: #eaf3ff; --rx-blue-25: #f5f9ff; --rx-blue-border: #c9dcf3;
  /* semantic */
  --rx-success: #18733f; --rx-success-bg: #e3f9ec; --rx-success-border: #c7e5d2;
  --rx-danger: #ac3039;  --rx-danger-hover: #8f2630; --rx-danger-bg: #fff0f1; --rx-danger-border: #edc4c7;
  --rx-warning: #9a4a08; --rx-warning-bg: #fff3e8;
  --rx-caution: #7a4a10; --rx-caution-bg: #fdf6ec;
  /* type */
  --rx-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --rx-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  /* radius */
  --rx-r-sm: 6px; --rx-r-md: 11px; --rx-r-lg: 14px; --rx-r-xl: 16px; --rx-r-modal: 18px; --rx-r-full: 999px;
  /* shadow */
  --rx-shadow-drawer: -12px 0 48px rgb(18 18 18 / 7%);
  --rx-shadow-pop: 0 10px 32px rgb(18 18 18 / 16%);
  --rx-shadow-modal: 0 16px 48px rgb(18 18 18 / 22%);
  --rx-shadow-toast: 0 8px 24px rgb(18 18 18 / 25%);
  /* motion */
  --rx-ease-out: cubic-bezier(.22, 1, .36, 1);
  --rx-dur-in: 260ms; --rx-dur-out: 180ms;
}
```

---

## 附录：设计稿文件清单

| 画板 | 文件 |
|---|---|
| 00 原型入口 · 检视队列（完整单组件原型） | `prototype/app.dc.html` |
| 01 报告抽屉 · 有待处理意见 | `prototype/drawer-pending-findings.dc.html` |
| 02 报告抽屉 · 检视进行中 | `prototype/drawer-running.dc.html` |
| 03 报告抽屉 · 检视失败 | `prototype/drawer-failed.dc.html` |
| 04 报告抽屉 · 暂无检视记录 | `prototype/drawer-no-record.dc.html` |
| 05 报告抽屉 · 未发现问题 | `prototype/drawer-no-issues.dc.html` |
| 06 规则配置 | `prototype/rules-config.dc.html` |
| 07 会话日志 | `prototype/session-logs.dc.html` |

v2 的 01–07 画板都是 `<dc-import name="app">` 以不同初始视图（`view` / `open` 参数）挂载同一个原型组件。
