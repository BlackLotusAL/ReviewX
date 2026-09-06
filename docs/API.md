# ReviewX Web API 接口说明

ReviewX Web API 是本机单实例网页与 Node.js 服务之间的内部接口。服务只监听启动时选择的 `127.0.0.1` 随机端口，不提供远程访问、身份认证、CORS 或兼容性承诺。

## 状态轮询

页面加载后立即请求一次 `GET /api/state`，之后每 1 秒请求一次。该接口返回当前 Project、MR、队列、检视、发布和致命错误状态，供页面在无需整体刷新的情况下更新显示。

轮询具备以下边界：

- 同一页面只允许一个在途状态请求，前一次未结束时跳过本轮。
- 所有响应均使用 `Cache-Control: no-store`。
- 客户端保存最近一次 `revision`；值变化时才重新读取当前打开的 MR 详情。
- 页面关闭或组件卸载后停止轮询，服务和活动任务继续运行。
- `GET /api/state` 和 `GET /api/mrs/...` 只读取 ReviewX 本地状态，不调用 CodeHub、Git、OpenCode 或评论接口。
- 轮询不是 MR 刷新。只有用户点击“刷新 MR”触发 `POST /api/mrs/refresh` 时才调用 CodeHub。

`GET /api/state` 返回的主要字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `revision` | 非负整数 | 当前页面视图版本；本地可见状态变化时递增 |
| `refreshOperation` | 对象 | MR 刷新的 `idle / refreshing / failed` 状态、时间、当前 Project 和错误 |
| `publicationBusy` | 布尔值 | 是否已有一条评论正在全局发送 |
| `publicationProjectId` | 字符串，可选 | 当前评论发送所属 Project |
| `fatalError` | 错误对象或 `null` | 日志等致命运行错误 |
| `projects` | 数组 | 按登记顺序返回的 Project、最近成功 MR 快照、状态、阶段和队列位置 |
| `currentLogUrl` | 字符串 | 当前会话日志读取地址，固定为 `/api/logs/current` |

## 通用约定

- 所有 JSON 响应和文本资源均禁止缓存。
- Project ID 和 MR IID 必须是以 `1-9` 开头的十进制正整数字符串。
- JSON 请求体采用严格字段校验，未声明的额外字段会被拒绝。
- 所有 mutation 必须同时满足：请求 `Host` 精确等于当前 loopback 地址、`Origin` 精确等于当前页面源、`Content-Type` 以 `application/json` 开头、正文不超过 1 MiB。
- 空参数 mutation 仍必须发送 JSON 对象 `{}`。
- mutation 成功后通常返回最新 `AppStateView`；创建检视返回 HTTP `202 Accepted`，其余成功 JSON 操作返回 HTTP `200 OK`。
- 错误统一返回 `{ "error": SafeErrorView }`，其中包含 `code`、`message`、`cause`、`impact`、`nextStep` 和 `technicalDetails`，必要时包含已脱敏的 `stderr` 或未分类错误堆栈。

常见错误状态为：参数或 JSON 无效 `400/422`、非同源 `403`、资源不存在 `404`、状态冲突 `409`、正文过大 `413`、Content-Type 不支持 `415`、运行时或外部 CLI 错误 `500/502`、致命状态拒绝新工作 `503`。

## 接口列表

| 方法与路径 | 请求 JSON | 成功响应 | 行为 |
| --- | --- | --- | --- |
| `GET /api/state` | 无 | `AppStateView` | 读取本地页面状态快照；不执行任何外部命令 |
| `POST /api/projects` | `{ "projectId": "101" }` | `AppStateView` | 调用 `codehub repo view` 验证并登记 Project |
| `DELETE /api/projects/{projectId}` | `{}` | `AppStateView` | 移除登记，保留历史快照、attempt、报告、发布记录和日志 |
| `POST /api/mrs/refresh` | `{}` | `AppStateView` | 按登记顺序手动调用 CodeHub，逐 Project 更新完整 open MR 快照 |
| `POST /api/reviews` | `{ "projectId": "101", "mrIid": "7" }` | `202` 与 `AppStateView` | 创建独立 attempt 并加入全局 FIFO |
| `POST /api/attempts/{attemptId}/stop` | `{}` | `AppStateView` | 停止排队或执行中的检视 attempt |
| `POST /api/attempts/{attemptId}/findings/{ordinal}/publish` | `{}` | `AppStateView` | 发送一条最新 attempt 的 pending Finding；内部兼容批次固定只记录该 ordinal |
| `PATCH /api/attempts/{attemptId}/findings/{ordinal}` | `{ "decision": "dismissed" }` 或 `{ "decision": "pending" }` | `AppStateView` | 将 pending Finding 标为不发送，或撤销最新 attempt 中的 dismissed 决策 |
| `GET /api/mrs/{projectId}/{mrIid}` | 无 | `MrDetailView` | 读取 Project 登记状态、MR 快照和按新到旧排列的 attempt 历史 |
| `GET /api/reports/{attemptId}` | 无 | `text/markdown; charset=utf-8` | 读取该成功 attempt 引用的不可变报告 |
| `GET /api/logs/current` | 无 | `text/plain; charset=utf-8` | 读取当前服务会话日志 |

## 关键响应结构

`MrDetailView` 包含：

- `project`：`id`、显示名称 `name` 和当前是否登记的 `registered`。
- `mergeRequest`：Project ID、IID、标题、CodeHub 原始状态、`updatedAt`、源分支、目标分支和可选 `webUrl`。旧 v1 状态可无该字段；下一次成功刷新后补齐。
- `attempts`：完整 attempt 历史；报告路径只以受控 `reportUrl` 暴露，不返回磁盘路径。

MR 列表项除 MR 快照外，还会包含页面状态 `status`、可选执行阶段 `phase`、可选队列位置 `queuePosition`、最近 attempt 引用、主操作 `primaryAction` 和已脱敏错误。

检视阶段沿用状态轮询，无新增前端会话或聊天接口：

| `phase` | 界面文字 |
| --- | --- |
| `understanding_changes` | 理解改动 |
| `verifying_findings` | 核实问题 |
| `finalizing_review` | 整理结果 |

准备、校验、保存和清理阶段继续使用已有字段；`running_opencode` 仅保留历史兼容。运行中的主操作为停止。`review_failed` 的界面状态为“检视未完成”，失败 attempt 无可处理 Finding 或 PASS 结果。

新 attempt 保存可选的 `baseSha` 和 `limitations: string[]`。新 Finding 的 `confidence`（0–100 整数）、`verificationSummary`（非空文字）、`evidence` 为必填输出字段；持久化 schema 中这些字段可缺省，以兼容旧 v1 状态。历史缺省分数显示“未评估”，不得补写历史字段或报告。

`evidence` 为非空数组，每项是 `{ side: "source" | "base", path: string, startLine: number, endLine: number }`。路径相对仓库且位于过滤后的固定提交快照中，行号从 1 开始、包含起止行，至少一项关联本次新增/删除行。正式结果只包含置信度 ≥90 且通过复核及本地证据校验的意见。分数为模型自评分，不代表统计正确率。

## 内部 OpenCode 协议

`ReviewerPort.review(projectId, details, prepared, signal, observer?)` 增加 `observer.phase(phase)` 异步回调及诊断回调。运行时先持久化 phase，再由已有轮询更新页面；查证轮数与工具调用只进入日志。

每个 attempt 拥有随机端口、临时 Basic 认证的 `127.0.0.1` OpenCode 服务及独立 session。`POST /session/{id}/message` 用预分配的唯一 `messageID` 关联请求；返回 assistant 的 `sessionID`、`parentID`、完成标记、模型和错误必须通过校验。正式结构化数据只读取 `info.structured`，允许成功 `finish: "tool-calls"`，拒绝正文猜测与历史结果复用。

查证 agent 只允许 `read/glob/grep`，每轮 20 个模型步骤。整理 agent 只允许 `StructuredOutput`，DeepSeek V4 关闭 thinking；原生 `format.retryCount: 0`，最多一次由 ReviewX 发起的格式纠正。固定源提交与 merge-base 快照作为上下文；服务数据库位于副本之外，停止或完成后清理整个工作区。原生 SSE 事件提供轮数、工具和用量诊断，并阻断步骤超限及供应商重试。已验证 OpenCode 1.18.25；该版本对带 `OutputFormatJsonSchema` 的 user 历史消息编码有缺陷，不能依赖完整历史 GET 进行关联校验。

内部整理返回严格对象 `{ status, nextChecks, findings, limitations }`。`needs_context` 必须有待查证事项并且 `findings: []`，继续下一轮；`complete` 必须有 `nextChecks: []`。一次初检后至少一次反证复核，最多三次查证，每次后单独整理；包含代码准备的整个 attempt 共用 60 分钟。耗尽查证轮次、格式纠正或时限时失败，不保存正式报告。认证、网络和取消错误直接沿用失败/停止流程。

典型错误码：`REVIEW_INCOMPLETE`（必要上下文未解决）、`REVIEW_TIMEOUT`（整个 attempt 超时）、`OPENCODE_STEP_LIMIT`、`INVALID_REVIEWER_OUTPUT`、`INVALID_REVIEW_EVIDENCE`、`INVALID_OPENCODE_RESPONSE`、`OPENCODE_HTTP_ERROR`、`OPENCODE_CONNECTION_FAILED`、`OPENCODE_INCOMPATIBLE`。它们不会触发自动重试或评论发送。

报告和日志接口会同时校验状态引用、规范路径和真实路径均位于 `%LOCALAPPDATA%\ReviewX` 数据目录；不能通过 URL 参数读取任意本地文件。

## CodeHub 状态约定

ReviewX 调用 MR 列表时固定传递 `--state open`，这是 CodeHub CLI 的筛选参数。`codehub mr view` JSON 返回值使用独立的数据词汇：`state` 为 `open` 或 `opened` 时均视为开放状态，比较时忽略首尾空白和大小写。其他状态不会被推断或纠正，并在 Git、OpenCode 启动前终止当前刷新或 attempt。

每次新的 `mr view` 响应还必须包含 `web_url`，且值必须是无用户名、密码的 HTTPS URL。缺失或非法值以 `CODEHUB_INVALID_RESPONSE` 终止本次刷新，并提示升级兼容的 CodeHub CLI；既有旧状态仍可启动和读取。
