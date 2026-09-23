# ReviewX

ReviewX 是仅面向 Windows 10/11 的本地 CodeHub Merge Request 代码检视工具。它把 open MR 放入一个全局 FIFO 队列，每次只运行一个只读 OpenCode 检视；每条 Finding 只有在用户明确点击“发送到 CodeHub”后，才会写入 CodeHub。

ReviewX 不会定时刷新、自动检视、自动评论，也不提供远程访问、数据库或发布重试。

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本
- pnpm 11.19（源码开发）
- Git，可在 `PATH` 中找到 `git.exe`
- CodeHub CLI，可在 `PATH` 中找到 `codehub.exe` 或安全的 `codehub.ps1` npm shim
- OpenCode CLI，可在 `PATH` 中找到 `opencode.exe` 或安全的 `opencode.ps1` npm shim，并已配置默认模型及其认证

CodeHub 必须返回不含用户信息、查询参数或片段的 HTTPS clone URL，并在 `mr view` JSON 中返回不含凭据的 HTTPS `web_url`。缺少该字段表示 CLI 版本不兼容，刷新会失败并提示升级。`repo view` 的项目 `web_url` 是必填字符串，原样保存，不做 URL 校验或缺失降级。ReviewX 不提供凭据输入或认证管理；项目地址不具备 MR 地址的过滤保证。

## 安装与启动

从发布 tarball 安装：

```powershell
npm install --global .\reviewx-1.0.0.tgz
reviewx
```

唯一启动入口是无参数 `reviewx`。启动成功后，终端会显示随机 loopback 地址和本次日志路径，并尝试用 Windows 默认浏览器打开页面。浏览器打开失败时服务仍会继续运行，可手动访问终端中的地址。

如果已有实例运行，第二次执行只会提示现有地址，不会再创建服务。旧命令或任何额外参数都会被拒绝；`reviewx --help` 只显示无参数用法。

服务只监听 `127.0.0.1`，不启用 CORS。所有状态变更接口同时校验精确 Host、同源 Origin 和 JSON Content-Type。

网页会每 1 秒调用一次 `GET /api/state` 同步本地队列和任务进度。该请求只读取 ReviewX 本地状态，不会刷新 CodeHub MR，也不会触发 Git、OpenCode 或评论操作。全部接口与请求/响应契约见 [Web API 接口说明](docs/API.md)。

左栏“查看当前会话日志”在新标签页打开 `/logs`，按 INFO / ERROR 着色并保留完整诊断文本。页面可见时每 2 秒自动读取当前会话日志，翻阅历史内容时保持位置，位于底部时跟随新增记录；原始纯文本仍可通过 `GET /api/logs/current` 读取。

## 使用流程

1. 输入正整数 Project ID；ReviewX 会先调用 CodeHub 验证 Project。
2. 点击“刷新 MR”手动获取各 Project 当前 open MR。
3. 点击“开始检视”或“重新检视”；任务按点击顺序进入全局 FIFO。
4. 按需展开“完整报告”；报告首次展开时加载，收起后保留缓存。PASS 直接完成；有 Findings 时进入待处理。
5. 在每张 Finding 卡片上直接选择“发送到 CodeHub”或“不发送”；已跳过项可在新 attempt 创建前撤销。

详情抽屉优先展示 Findings，完整报告位于其后并默认收起。发送或跳过后，问题全文与位置保持不变。可用键盘打开 MR、通过方向键切换检视历史，用 Escape 关闭详情并返回原入口；页面遵循系统的“减少动态效果”设置。

Finding 头部展示严重等级、处理状态和操作按钮，概览展示版本与检视标识。正文和报告中标注了支持语言的代码块使用本地语法高亮，未标注及未知语言保留纯文本。展示样式不会改变发送到 CodeHub 的正文。

停止活动检视会终止 Windows 子进程树并清理临时工作区；单次检视失败会停止其余排队项。评论发送与检视队列彼此独立，但任一时刻只允许发送一条评论。MR 卡片和详情标题中的 `!IID ↗` 可直接在新标签页打开 CodeHub MR。

## 本地数据

永久数据位于 `%LOCALAPPDATA%\ReviewX`：

- `state.json`：版本化原子状态文件
- `reports\<attempt-id>\report.md`：每次成功 attempt 的不可变报告
- `logs\reviewx-*.log`：每次启动独立保存的英文诊断日志
- `workspaces\`：检视期间使用、完成后清理的临时 Git 对象和可信任务目录

移除 Project 只移除登记项，不删除快照、attempt、报告、发布记录或日志；重新添加后历史会恢复可见。不要手工编辑运行中实例的状态文件。

## 源码开发

产品行为与验收标准见 [PRD](docs/PRD.md)，请求、响应和兼容规则见 [API](docs/API.md)。

目录职责：`app/` 为页面、API 入口及通用组件；`src/cli/` 为启动与退出；`src/client/review-workspace/` 为工作台；`src/server/` 中 runtime 统一持有状态、队列、取消与发布，bootstrap 负责装配，review、integrations、storage、platform 分别负责检视、外部系统、持久化与平台能力。`src/shared/` 只存浏览器兼容的合同与纯处理；规则、字体、测试分别位于 `resources/`、`public/`、`tests/`。

CLI/API 可以依赖服务端，服务端不反向依赖 CLI；客户端只依赖共享层，不引用服务端实现；共享层不引用上层或 Node 内建模块，生产代码不依赖测试。`pnpm lint` 包含导入方向、本地引用和循环检查。工作台使用唯一控制 Hook 管理轮询，子组件不各自创建请求循环。

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

`/preview` 提供 MR 样式预览：2 个虚拟项目、14 条固定样例，覆盖全部 11 类状态、三种检视阶段，以及有问题和无问题的完成结果。它与主页共用卡片、详情抽屉和 CSS；详情、历史切换和完整报告可正常浏览，数据操作按钮不提交请求，示例 CodeHub 链接不跳转。数据仅保存在内存，刷新或重新打开后样例与排序不变；日志入口仍查看当前本地会话。

`pnpm dev` 只用于开发页面；正式入口仍是构建后的无参数 `reviewx`。质量检查命令：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:e2e
pnpm test:ai
pnpm test:package
```

每轮改动完成时必须执行完整质量检查，最后串行运行 `pnpm test:ai` 和 `pnpm test:package`，无需额外指示、开关或逐次确认。`pnpm test:ai` 使用临时真实 Git 仓库和源码引擎调用当前 OpenCode 默认模型。`pnpm test:package` 会重新构建、创建 npm tarball、隔离安装，验收随机端口、浏览器失败降级和单实例生命周期，再自动使用已安装引擎执行真实模型验收。两者会消耗真实模型额度，可能产生费用，但不会调用真实 CodeHub 或创建评论；需要分别核对生成意见。任一步失败或未执行都不能宣称整体验收通过。`pnpm test` 本身仍是快速确定性测试入口。

先构建以生成 Next 类型。桌面 E2E 使用单 worker，保护业务、键盘、焦点、滚动和导航，不设置手机或精确视觉矩阵；失败时保留截图与 trace。生产模式通过 `REVIEWX_E2E_PRODUCTION=1` 选择，不与安装验收并行，二者共享构建目录。覆盖率仅统计单元/集成对 src/app 的执行，不代表浏览器、真实模型或安装覆盖。

验收产物不纳入版本控制：安装包及元数据位于 `artifacts/`（元数据为 `package-verification.json`），源码与安装包真实 AI 输出分别位于 `test-results/acceptance/<时间戳>/`，覆盖率报告位于 `coverage/`。记录环境、命令、通过/失败/未执行状态和证据位置，分别核对两层生成意见的代码依据与正文哈希；技术脚本通过不替代质量复核。历史记录不替代当前验证。

## 故障排查

- 找不到 CodeHub/Git/OpenCode：确认对应 `.exe` 或 npm `.ps1` shim 已加入当前用户 `PATH`；不支持仅有 `.cmd` 的不安全启动器。
- OpenCode 结果被拒绝：检查诊断中的材料、实际已读证据或正式合同错误。只有 `reviewx_submit` 和正常整体终态可产生结果；聊天 JSON 不被接受，也不会自动重试。
- Git 输入被拦截：完整 diff 或源文件快照命中了凭据模式；先移除并轮换仓库内凭据，再重新检视。
- 无法自动打开浏览器：从终端复制 `http://127.0.0.1:<port>` 地址；服务通常仍在运行。
- 页面操作被拒绝或服务进入致命状态：查看页面中的“原因、影响、下一步”和折叠的“技术详情”，或打开左栏“查看当前会话日志”排查。
- MR 被误判为非开放状态：ReviewX 同时接受 `mr view` 返回的 `open` 和 `opened`；如果仍报错，请在日志中确认 CodeHub 实际返回的 `state` 值。
- 意外退出后：排队中、检视中和停止中的 attempt 会恢复为已停止；中断评论的当前 Finding 会标为 unknown，其他 pending Finding 仍可继续处理，ReviewX 不会自动补发。旧版多条批次中的后续项仍兼容恢复为 not_attempted。

报告与 Finding Markdown 均按不可信输入处理：原始 HTML、危险 scheme、表单和嵌入内容会被丢弃，图片只展示为经过公共 HTTP(S) allowlist 校验的链接，不会自动加载。

## 多轮检视与外置规则

生产流程为固定 T/S/B → 受控工具按需读取 → reviewx_submit → 正常整体终态 → 不可变报告。通过原版 OpenCode HTTP 接入，按运行时能力校验，不锁定版本；不指定模型、不复制认证、不重定向 HOME。不可控的全局工具、MCP、显式 instructions、任务配置输入会在代码交付前拒绝。允许用户级 AGENTS.md 存在；仍拒绝运行目录及其祖先目录的 AGENTS.md。会话等待 idle/error/disconnected，由 60 分钟总预算兜底；serve 使用 stdout/stderr 合计 16 KiB 的滚动缓冲，不因累计日志量终止，错误诊断保留最近 16 KiB 输出。原生 OpenCode 会话可能保留源码；ReviewX 的默认执行摘要不保留源码或推理。

默认通用策略、中文评论骨架及 C++/Python 规则来自安装包 resources/review-rules，不依赖启动 cwd。可在 %LOCALAPPDATA%\ReviewX\rules\profile.json 显式配置项目框架和知识：

```json
{
  "version": 1,
  "resources": { "knowledge": { "path": "team.md", "version": "2026-09" } },
  "languages": { ".h": ["cpp"] },
  "projects": { "123": ["qt", "pyqt5", "pyside2", "knowledge"] }
}
```

team.md 相对 rules 目录。框架可分别选择；不根据仓库内容猜测绑定。不设置 profile 时使用默认规则；显式资源缺失、路径越界或链接/junction 会失败。规则仅为 UTF-8 文本，不执行脚本，不解析递归 include 或远程资源。每次 attempt 冻结资源内容、版本、顺序和哈希，修改只影响以后检视。

页面最多 200 行/32 KiB（正文预算 24 KiB），blob 最大 16 MiB，完整 diff/累计交付各 64 MiB，提交最大 1 MiB/100 条，每条 body 最大 64 KiB。标记为不支持的变更从可审范围排除并记入限制，不阻断其余变更的检视；其余必需材料仍须完整交付；未知文本语言沿用通用规则，.ui/.qrc 不做代码生成。

成功目录保存 report.md、submission.v1.json、execution.v1.json；state.json 保持 v1，发布字段不变。回滚只更换程序，保留当前 state.json 和发布记录，不能拿旧备份覆盖新增结果。旧版可忽略独立执行文件。

完整检视约束、安全边界与验收标准见 [PRD](docs/PRD.md)。开发验证命令统一见本文“源码开发”。
