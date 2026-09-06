# ReviewX 多轮检视验收记录

验收日期：2026-09-06（Asia/Hong_Kong）

环境：Windows、Node.js 24.14.1（产品最低要求 22）、pnpm 11.19、Next.js 16.2.9、React 19.2.8、OpenCode 1.18.25。

## 多轮检视新增验收

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 初检、反证、整理 | PASS | unit reviewer 测试强制至少一次独立复核；真实 Git + 默认 DeepSeek V4 Flash 烟测三轮返回 1 条有效权限 Finding。 |
| 继续查证 | PASS | `needs_context` 无 Findings 并触发下一轮；三轮未解决时拒绝 PASS；真实协议验证整理之后还能继续同一会话。 |
| 只读副本 | PASS | 真实 Git 验证 source / merge-base、未改动调用方、目标分支独立前进、代理配置、凭据文件和链接排除；大文件原生上下文可读。 |
| 阶段配置 | PASS | 查证仅 read/glob/grep；整理仅 StructuredOutput；DeepSeek V4 整理显式 thinking disabled，普通模型保持原配置。 |
| 请求关联 | PASS | 真实本机服务及 HTTP shim 校验会话、唯一请求 ID、父消息、完成标记、模型与错误；拒绝串线/重复/未完成数据；允许有效 tool-calls 完成。 |
| 证据与置信度 | PASS | 拒绝非整数分数、非法路径、缺失文件、越界行号及只引用未改动上下文；过滤 <90 的意见，保留局限。 |
| 格式纠正 | PASS | 全 attempt 共用一次预算，跨查证轮次不重置；供应商错误不进入纠正。 |
| 超限、取消与清理 | PASS | 单轮 >20 步拒绝；一个 deadline 覆盖 Git 和检视；取消挂起 HTTP 后进程退出、端口释放；超时清除 Findings/报告引用并停止后续队列。 |
| 原文与历史 | PASS | 五轮真实协议原样保留中文、换行、引号、反斜杠、代码围栏、置信度 95；旧 v1 状态可缺少新字段且不回填。 |
| 产品呈现 | PASS | 浏览器验证阶段、置信度、自评分说明、核实依据、历史未评估、逐条发送、PASS 提示及停止。 |

OpenCode 1.18.25 另有实际接口兼容问题：成功 `POST message` 返回 `info.structured`，但 GET 含格式约束的 user 历史消息会报 `Expected OutputFormatJsonSchema`。ReviewX 使用预分配的唯一 messageID 校验响应 parentID，并通过原生 SSE 采集工具与用量，避免依赖此 GET。上游将该类型定义为 Schema.Class：[OutputFormatJsonSchema](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/schema/src/v1/session.ts#L62)。输出工具需显式放行：[权限过滤](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/llm/request.ts#L193)。

## 真实模型质量对照

六类可执行 fixture 分别验证真实越权、跨文件契约、边界回归、调用方保护、默认值保障和既有缺陷。每类固定相同源提交及基线，用相同模型 `deepseek/deepseek-v4-flash` 对旧、新方案各运行三次。先运行独立的行为断言：所有 base 通过，正例的 source 失败，反例的 source 通过。新方案再对最终结果执行 Schema 与证据校验。完整 36 次运行已通过，以下为这组固定样例的验收结果。

| 样例 | 旧方案 | 新方案 |
| --- | --- | --- |
| 真实越权 | 命中 3/3 | 命中 3/3 |
| 跨文件契约破坏 | 命中 3/3 | 命中 3/3 |
| 边界回归 | 命中 3/3 | 命中 3/3 |
| 调用方已保护 | 误报 3/3 | 误报 0/3 |
| 已有默认值保障 | 误报 3/3 | 误报 0/3 |
| 既有缺陷 | 误报 0/3 | 误报 0/3 |
| 合计 | 正例 9/9；反例误报 6/9 | 正例 9/9；反例误报 0/9 |

新方案 18/18 最终结构化结果通过本地 Schema 与证据校验；旧方案 18/18 结果满足旧版最小 JSON 契约。两个新方案 attempt 分别遇到证据范围错误和结构字段错误，均仅纠正一次后通过；其余无需纠正。已逐项核对九份正例结果确实描述预设回归，并离线复核全部 36 份留档的模型、版本及双侧 SHA。六组完整提交另存为 `repository.bundle`。

| 用量（OpenCode 原生字段合计） | 旧方案 18 次 | 新方案 18 次 |
| --- | ---: | ---: |
| 平均耗时 | 19.62 秒 | 69.01 秒 |
| inputTokens | 8,330 | 249,292 |
| outputTokens | 8,056 | 78,987 |
| reasoningTokens | 27,778 | 79,170 |
| cacheReadTokens | 14,848 | 647,296 |
| cacheWriteTokens | 0 | 0 |
| 报告费用（USD） | 0.0112413 | 0.0809973 |

完整 36 次对照的 OpenCode 报告费用合计约 **$0.092239**。连同已留存的烟测、协议测试和首次中断对照摘要，可取得费用的小计约 **$0.135478**；早期被清理的诊断与一次中断运行的用量不可取得，此小计不能作为实际总账单。

- [完整对照结果与质量门](../test-results/ai/quality-2026-09-06T12-09-52-985Z/summary.json)
- [逐项结果及用量](../test-results/ai/quality-2026-09-06T12-09-52-985Z/results.json)
- [提交、模型和结构校验复核](../test-results/ai/quality-2026-09-06T12-09-52-985Z/audit.json)
- [可取得的费用汇总](../test-results/ai/reported-costs.json)
- [工程检查与日志索引](../test-results/engineering/checks.json)

模型对照结果、原始旧方案事件、每轮请求/回复、固定 diff/manifest、行为断言、模型版本、耗时、Token 和 OpenCode 报告费用保存在 `test-results/ai/`。测试过程发现 E2E 默认清空共享输出目录，已改为 `test-results/e2e`，受影响的对照运行已重新执行；最终验收只使用完整留档的一组结果。费用为 OpenCode 提供的估算，不是供应商账单。

## PRD 逐条结果

| PRD 场景 | 结果 | 验收证据 |
| --- | --- | --- |
| 本机启动 | PASS | npm tarball 隔离安装后，无参数 `reviewx` 监听随机 `127.0.0.1` 端口，终端输出 URL 与绝对日志路径；浏览器启动失败注入后服务继续可访问。 |
| 重复启动 | PASS | 同一 `%LOCALAPPDATA%` 启动第二实例，进程正常退出并返回第一实例 URL；未创建第二 HTTP 服务。 |
| Project 管理 | PASS | 集成测试覆盖正整数校验、CodeHub 验证、添加顺序、重复添加、移除、不存在移除、重新添加及历史恢复。 |
| 手动刷新 | PASS | 集成测试验证按 Project/MR 返回顺序串行调用，Project 完整成功后替换；Git、OpenCode、评论调用数保持为零。 |
| 无自动化 | PASS | 等待后外部调用计数不变；无定时器、后台发现、自动 attempt 或自动评论入口。 |
| FIFO 队列 | PASS | 三个 MR 按点击顺序执行，Fake Reviewer 最大并发为 1，并在页面显示队列位置。 |
| 停止排队项 | PASS | 排队 attempt 立即移出 FIFO 并持久化为 `stopped`。 |
| 停止执行项 | PASS | AbortSignal 终止当前进程路径，工作区 cleanup 执行，不保留报告引用或 Findings，后续任务继续。 |
| 检视失败 | PASS | 当前 attempt 为 `review_failed`，其余排队项全部变为 `stopped`，队列清空且不自动继续。 |
| 应用重开 | PASS | 状态恢复单测覆盖 `queued/reviewing/stopping` 全部转为 `stopped`，活动队列引用清空。 |
| 重复检视 | PASS | 同一 MR 与同一 `updated_at` 可人工再次检视，生成不同 attempt ID 和不同报告 URL。 |
| 旧结果 | PASS | 新 attempt 创建后旧 attempt 归档；pending 变为 archived，published/dismissed 等既有决策保留。 |
| MR 中途变化 | PASS | 第二次 `mr view` 发现 `updated_at` 变化后失败；Reviewer 调用数为零且无报告引用。 |
| PASS | PASS | 空 Findings 保存独立报告并进入 `completed`，无确认入口和评论调用。 |
| Findings | PASS | 全部 Findings 与完整报告持久化后进入 `awaiting_confirmation`（界面“待处理”），评论调用数仍为零。 |
| 卡片级决策 | PASS | Playwright 验证 checkbox 和批量栏消失；每条 pending Finding 直接提供“不发送”和“发送到 CodeHub”。 |
| 跳过与撤销 | PASS | 集成与浏览器测试覆盖 dismissed 持久化、全部处理后 completed，以及从 completed 撤销后回到待处理。 |
| 逐条发送 | PASS | 单击只创建目标 Finding 评论；新 batch 仅含一个 ordinal，其他 pending Finding 不变。 |
| 发送并行 | PASS | 一条评论与另一 MR 的 Review 可同时活动；评论最大并发为 1，第二条发送被全局门禁拒绝。 |
| 无版本校验 | PASS | 发送前后 `mr view` 调用计数不变，旧版本 pending Finding 可由用户明确发送。 |
| 发送失败 | PASS | 明确失败或 unknown 只终结目标 Finding；其他 pending 项可继续，最终按是否残留失败项归并为 publish_failed。 |
| 发送与队列隔离 | PASS | 评论失败期间创建的独立 review 正常完成，失败不清空 review 队列。 |
| 项目移除 | PASS | 活动检视停止、同 Project 排队项取消、其他 Project 继续；发送中的 Project 移除被拒绝，历史仍可读取。 |
| 报告 | PASS | 报告使用 `wx` 创建且不可覆盖；默认收起、首次展开加载，收起再展开复用缓存；状态引用与 realpath 双重目录约束拒绝 traversal。 |
| MR 外链 | PASS | `mr view.web_url` 映射及无凭据 HTTPS 校验有测试；列表与详情链接的 href、`_blank` 和点击隔离由 Playwright 验证。 |
| 旧状态兼容 | PASS | 无 `webUrl` 的 v1 MR 快照可启动；dismissed 与 dismissedAt 可原样持久化和恢复。 |
| Markdown 安全 | PASS | Playwright 验证 script/form/iframe/object/embed/img 不进入 DOM，本机/私网/file URL 被拦截，公共图片仅显示为链接。 |
| 日志 | PASS | 每次启动独立日志；本地毫秒时间、英文自然语言、ANSI 清理、控制字符转义、Cause/Impact/Next step/Technical details 均有测试。 |
| 凭据 | PASS | 环境凭据过滤、完整 bundle/元数据扫描、私钥整块脱敏、无凭据 HTTPS URL、PowerShell JSON argv 信封均有单元或集成覆盖。 |

## 接口与恢复补充验收

- mutation 仅接受精确 loopback Host、同源 Origin 与 JSON；实际流式正文超过 1 MiB 时拒绝。
- CodeHub 四组 argv 由真实 PowerShell shim 捕获并逐项比对；评论 body 是单个 argv，换行为真实 CRLF。
- CodeHub `mr view` 返回 `opened` 时，手动刷新和检视前后两次状态校验均通过；`closed` 等终态仍在 Git 和 OpenCode 启动前拒绝。
- Git 使用真实临时仓库验证固定 SHA、完整三点 diff、源/merge-base 双侧快照、只读上下文与凭据阻断。64 KiB/256 KiB bundle 仅用于旧方案质量基线。
- OpenCode HTTP shim 验证随机端口、临时认证、每次请求关联、阶段权限、原生结构化结果、事件去重、超限、取消及进程退出；CodeHub/Git/GitHub/SSH 环境凭据不传给模型服务。
- 发送中断恢复验证当前 Finding 为 unknown；其他 pending 项继续可处理。旧版批次的后续项仍兼容为 not_attempted，且不补发。
- 运行期日志写入失败验证进入 fatal 状态，拒绝新刷新/检视/发布，但仍允许停止与移除。

## 质量门

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS：32 个单元测试、27 个集成测试 |
| `pnpm test:e2e` | PASS：1 个完整浏览器业务流程 |
| `pnpm build` | PASS：Next.js 生产构建与 tsup CLI 构建，无警告 |
| `pnpm test:package` | PASS：npm tarball 隔离安装与真实 CLI 生命周期 |
| `pnpm test:ai` | PASS：真实 Git + OpenCode 三轮检视返回 1 条有效权限 Finding |
| `pnpm test:ai:protocol` | PASS：五轮真实会话、结构化阶段后继续、正文原样输出及独立临时数据库 |
| `pnpm test:ai:quality` | PASS：36 次真实对照，新方案正例 9/9、反例零误报、最终结构化结果 18/18 合法 |

CodeHub 在本机未安装，因此所有 CodeHub 验收使用无网络、无真实评论的可控 CLI shim；真实 AI 烟测未调用 CodeHub。
