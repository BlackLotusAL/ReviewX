# 长会话消息校验验证

## 远端报告与证据边界

用户在另一台机器使用 OpenCode 1.18.30、DeepSeek V4 Flash，遇到 `INVALID_OPENCODE_RESPONSE`，提示消息未完成、重复或无关联。最后的 `service_exited` 在第 3 轮、运行 2481429ms 后记录 `cleanupRequested=true`、`reviewAborted=false`、`stopReason=cleanup`。

该记录说明 ReviewX 主动执行了清理，不能说明 OpenCode 自行退出；41 分钟运行也不是之前 300 秒响应头超时的证据。目前无法取得该机器的原始响应及完整 Attempt 日志，所以尚未确认其具体失败分支。

先前两次 8–11 分钟真实检视通过，仅证明那两次调用完成，没有覆盖原生压缩、续接及重放的所有边界。

## 已独立复现的缺陷

OpenCode 1.18.30 的 [compaction.ts](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/compaction.ts) 会在压缩后创建新的续接用户消息，溢出重放路径也会创建新的用户 ID；[prompt.ts](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/prompt.ts) 使用最新用户 ID 作为后续助手消息的 parentID。旧代码要求 parentID 严格等于原提交请求 ID，因此可能误拒绝已完成的合法续接。

本机使用真实 OpenCode 1.18.30 和纯本地确定性模型，模拟超大 Token 用量以触发原生压缩，不需要等待 41 分钟，也不调用 DeepSeek：

- 修复前：`test-results/compaction-probe/1789060485434/`。压缩与续接事件均发生，返回助手消息完成时间有效、非重复，但被 `parent_mismatch` 拒绝。
- 修复后：`test-results/compaction-probe/1789060890098/`。同一原生续接分支通过，随后第三轮原生 StructuredOutput 和本地 checkpoint 校验通过。
- 此受控实验在第二轮触发压缩，并非远端第 3 轮失败的精确复现。另一次强制结构化请求上下文溢出实验得到 OpenCode HTTP 500，没有将它归为远端故障，也没有宣称该上游路径已修复。

## 修复与保护条件

- 以 SSE 中已观测到的原提交用户消息确定所属轮次。仅将同一轮原生压缩后的合成续接关联到原请求；重放还须匹配原提示文本及用户配置，包括模型、agent 和输出格式。
- HTTP/SSE 是不同连接；仅当父 ID 尚未关联时，最多等待 1 秒补齐事件证据，受原停止信号约束，不重发提示或读取历史对话作为替代结果。
- 保留会话、角色、模型、重复 ID、完成时间、结构化结果及证据校验。压缩摘要不能充当检视结果；压缩与续接沿用原轮步骤预算。
- 新增 `message_received` 元数据和 `message_rejected.failedChecks`。缺失完成时间、父级未证实、重复、模型不符等不再混成不可区分的诊断。失败时保留既有脱敏进程输出诊断。
- 压缩标记和重放事件不足时仍拒绝，不能仅凭“发生过压缩”放行任意父 ID；旧轮次迟到事件不授权新轮次。

## 验证方式

```powershell
pnpm test:ai:compaction
# 等价入口
node node_modules/tsx/dist/cli.mjs tests/ai/local-compaction-probe.ts
```

产物位于被 Git 忽略的 `test-results/compaction-probe/`；`calls.json` 只记录本地模型调用的协议元数据，`events.json` 记录 OpenCode 事件。该测试通过表示协议兼容性条件满足，不是检视质量分数。

回归覆盖：未知父 ID、跨会话、重复、缺失/非数字完成时间、错误角色/模型、压缩摘要、可证明和无法证明的续接、重放格式不符、旧轮次事件、步骤上限、事件等待超时及取消。

本轮验证结果：18 个测试文件、142 项单元和集成测试全部通过；TypeScript、ESLint、Next.js 生产构建及 tsup CLI 构建通过。真实 OpenCode + 本地模型协议探针通过；没有把它称为对远端 DeepSeek 长会话的端到端复现，也没有重跑先前两次项目检视来替代压缩分支测试。

如果远端再次失败，应保留同轮 `message_received`、`message_rejected`、压缩事件和 `http_failed`。本次不要求再次提供无法取得的历史日志，也不宣称所有 `INVALID_OPENCODE_RESPONSE` 都由上下文压缩导致。
