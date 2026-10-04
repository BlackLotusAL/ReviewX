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
4. 按需展开“完整报告”；报告首次展开时加载，收起后保留缓存。完整检视且无有效问题才显示 PASS；部分完成始终单独标记，有有效 Findings 时仍可逐条发布。
5. 在每张 Finding 卡片上直接选择“发送到 CodeHub”或“不发送”；已跳过项可在新 attempt 创建前撤销。

详情抽屉优先展示 Findings，完整报告位于其后并默认收起。发送或跳过后，问题全文与位置保持不变。可用键盘打开 MR、通过方向键切换检视历史，用 Escape 关闭详情并返回原入口；页面遵循系统的“减少动态效果”设置。

Finding 头部展示严重等级、处理状态和操作按钮，概览展示版本与检视标识。正文和报告中标注了支持语言的代码块使用本地语法高亮，未标注及未知语言保留纯文本。展示样式不会改变发送到 CodeHub 的正文。

停止活动检视会终止 Windows 子进程树并清理临时工作区；单次检视失败不影响其余排队项。评论发送与检视队列彼此独立，但任一时刻只允许发送一条评论。MR 卡片和详情标题中的 `!IID ↗` 可直接在新标签页打开 CodeHub MR。

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

`review/finding-state` 集中维护 Finding 人工决策、发布开始与结果、中断恢复和旧 attempt 归档，协调 Finding、发布批次、attempt 汇总及全局发送占用。runtime 负责外部调用，StateStore 负责串行事务与原子落盘；状态变更在事务草稿上重新校验，归档与创建新 attempt 仍在同一事务内完成。

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

## 原生检视与故障处理

检视支持两种工作流：默认 `legacy` 保留 OpenCode 原生四代理审查和逐问题独立复核；设置 `REVIEWX_WORKFLOW=balanced` 启用一次综合发现、主机调度的小批量独立复核（每批最多 4 个候选，并发 2）和确定性汇总。真实样本质量验收通过前不切换默认值。全部代理沿用本机 OpenCode 默认模型，无品牌或版本白名单；缺少所需原生接口、任务工具或权限能力时会提示兼容性错误。实现参考见 resources/review-workflow-provenance.md，性能观测与验收见 [检视性能说明](docs/REVIEW_PERFORMANCE.md)。

仓库根目录和变更路径祖先目录的 AGENTS.md/CLAUDE.md 提供项目规则，resources/rules 提供入队时冻结的全局补充。表达偏好不能改变固定输出章节。

模型返回字段化意见；脚本统一生成中文 Markdown。结构异常最多修复一次，保留有效项并标记未完整，原文一并保存。SSE 只显示进度，断流不推翻完整结果，也不会重复发送生成请求。

单任务失败后继续其他排队任务。目录清理失败只警告；进程退出无法确认、报告或状态无法保存时暂停队列，可使用“重试清理并继续”。日志故障不单独阻止检视。

新数据使用 %LOCALAPPDATA%/ReviewX，直接在该目录保存状态、锁文件、报告、日志和工作区，state.json version=2。旧 native-v2 子目录不自动读取、迁移或删除。重启停止中断任务，保留尚未开始的队列，先检查遗留进程。

真实 AI 默认验收三处单位换算缺陷；REVIEWX_ACCEPTANCE_CASE=clean 为无缺陷对照，lifetime-defects/async-defects 检查生命周期和异步逻辑。源码与安装包分别保存原始输出、结构、正文和执行信息；脚本通过后仍需人工核对意见依据。
