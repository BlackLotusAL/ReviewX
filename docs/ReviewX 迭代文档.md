# ReviewX 迭代文档

## 1. 概述

本次迭代围绕「让长时多轮检视能稳定跑完、让部分结果能被正确接受、让失败诊断更可读」三个目标，重构了两大模块：

1. **OpenCode 接入层**（`src/server/integrations/opencode.ts`）：把与原生 OpenCode 的 HTTP 通信从全局 `fetch` 换成 Node 原生 `http.request`，撤销 serve 进程输出上限误杀，并等待 agent 真正结束本轮后再收尾。
2. **检视结果边界**（`src/server/review/result-receiver.ts`）：把「要么整份通过、要么整份失败」的强校验，改成「无效 finding 逐个丢弃、无效提交返回 REJECTED、不完全提交作为部分结果接受」的宽松但可核实的边界。

同时清理了 `process.ts` 中已不需用的 `tail` 输出模式，调整了 AGENTS.md 的信任边界，移除了报告中的 limitations 节，并大幅重写了相关单测/集成测试。



## 2. 背景与根因

### 2.1 全局 `fetch` 有 300s 响应头超时，长时检视被中断

undici 的全局 `fetch` 对 `responsesTimeout` / `headersTimeout` 硬编码为 300s（5 分钟）。真实多分钟检视中，OpenCode 会话长时间不返回响应头会触发 `UND_ERR_HEADERS_TIMEOUT`，导致 fetch 在约 5 分钟时被终止。

- 影响：长于 5 分钟的检视中断，多轮会话拿不到成功终态。
- 决策：改用 Node 原生 `http.request`，它没有该响应头超时上限。生命周期改由调用方传入的 `AbortSignal`（即 io 预算：`AbortSignal.timeout` + 调用方取消）约束。

### 2.2 serve 进程 16KiB 滚动缓冲被误判为输出上限而杀进程

旧实现把 serve 的 `maxOutputBytes` 设为 16 KiB 并启用 `tail` 模式，代码把「输出超上限」当成进程异常处理，会终止 serve 进程。真实检视时 serve 会打印 >1 MiB 日志，于是服务中途被杀，后续请求得到 "fetch failed"。

- 决策：`maxOutputBytes` 提到 256 MiB，且仅用于约束内存（上限只是内存护栏，不影响服务生命周期）；日志滚动 tail 改由 `opencode.ts` 自行维护（保留最近 16 KiB 的 `startup` 文本用于诊断）。

### 2.3 等待 agent 轮次的时间窗口不足 / 行为不一致

旧实现用 100ms 轮询等待 `idle/error/disconnected`；轮询节奏太密且未真正反映「本轮结束」的语义。

- 决策：改 500ms 轮询，循环迭代由 `io` 信号（总时间预算 + 调用方取消）兜底，允许自然跑完真正需要数分钟的一整轮。

### 2.4 结果边界过于苛刻，一点瑕疵整份拒绝

旧逻辑下：

- 提交唯一，重复/再次提交即 `REVIEW_CONFLICT` 整体失败；
- 任意单个 finding 无效会导致整份提交被拒；
- `completion` 必须为 `complete` 且无 blockers、无未读必需材料，否则整份失败；
- `reviewx_read` 遇到无法分页的文件直接抛错（fatal），阻断整轮；
- schema 校验失败直接抛错中断。

对 LLM 产出的真实场景过于脆弱，常常「一票否决」导致整次检视失败/无结果。

- 决策：改为「逐个 finding 核实、无效项丢弃保留有效项；提交不符合则返回 REJECTED 响应而非中断；incomplete + blockers 可作为部分结果接受；不可分页文件优雅跳过」。

### 2.5 诊断信息不可读

失败时用 JSON 串拼接堆栈，难以直接阅读。

- 决策：`reviewError()` 不再接收 `details` 参数；`opencode.ts` 出错时直接构造带结构化字段的 `AppError`（reason/impact/nextStep/technical/cause 等），并把 oldCode 输出 tail、进程状态、终端状态整理成多行可读文本。

## 3. 设计决策与逐文件实现要点

### 3.1 `src/server/integrations/opencode.ts` — 原生 HTTP 接入重构

**新增 `httpJson()`（L55）**：用 `node:http.request` 封装 JSON 调用。

- 依据 method（是否有 body）自动选 GET/POST，设置 `headers`；
- 支持 `limit`（默认 128 MiB），响应累积超限则 `req.destroy(reviewError("REVIEW_INCOMPLETE", ...))`；
- `req.setTimeout(0)` 关闭 Node 默认空闲超时；
- 绑定 `AbortSignal`：已 abort 直接 `destroy(new DOMException("Aborted","AbortError"))`，否则 `addEventListener("abort", ...)`；
- 状态码 ≥400 视为 `OPENCODE_PROTOCOL_ERROR`。

**`request()` 封装（L115）**：调用 `httpJson` 并对错误归一化——`AppError` 原样抛出，其余包装为 `OPENCODE_NETWORK_ERROR`，附 route 与 cause 信息。

**serve 进程参数（L180）**：`maxOutputBytes: 256 * 1024 * 1024`；`onStdout`/`onStderr` 都走 `tail` 回调，维护 `startup`（最近 16 KiB）并从其中正则提取 `baseUrl`。

**版本校验与记录（L187、L251）**：

- `/global/health` 要求 `healthy` 且 `version` 为非空字符串，否则 `OPENCODE_PROTOCOL_UNSUPPORTED`；
- `execution.protocol` 由常量 `"opencode-http"` 改为 `opencode-http/${health.version}`，`opencodeVersion` 仍记录实际版本；
- 新增 `other-version` 集成用例验证 `protocol` 随版本变化。

**等待/轮询（L233）**：`while (!terminal.idle && !terminal.error && !terminal.disconnected)` 内 `io.throwIfAborted()` + `setTimeout(500)`。

**错误处理（L236 起）**：

- 检查 bridgeError、protocolStop、io.aborted 分支后，对非 `AppError`（无 `.code`）统一构造 `AppError(OPENCODE_FAILED)`；
- 进程状态用 `Promise.race([server.then(...), 500ms])` 探测（已退出则给 exitCode/aborted/timedOut/outputLimitExceeded，否则说明仍在运行）；
- 拼接 `cause.message + 进程状态 + 终端状态 + 服务输出尾部` 为多行 `technical`，`stderr` 存放 `startup`。

### 3.2 `src/server/platform/process.ts` — 移除 `tail` 模式

- 删除 `ProcessOptions.outputMode` 字段及 `tail` 分支逻辑（滚动裁剪、`tailBytes`、跨流合并等）；
- `runProcess` 只保留 full 缓冲路径，`stdout`/`stderr` 直接来自累积 chunks；
- `maxOutputBytes` 校验与默认值（64 MiB）保留；相关 `tail` 单测全部删除；
- 二进制缓冲 / stdoutFile 的适配逻辑不回归。

### 3.3 `src/server/review/result-receiver.ts` — 结果边界重构（核心）

**提交语义：可重复提交（L18、L74–L77）**：

- 新增私有 `submitSignature`（`stable(input)` 签名）；
- 已有 `candidate` 时：签名相同 → 视为重复提交，记 limitation 并返回 `SUBMITTED（duplicate，ignore）`；签名不同 → 采纳最新一份，记 limitation「采纳最新」；
- 不再对多次提交抛 `REVIEW_CONFLICT`。

**无效 finding 逐个丢弃（L159、L165 `invalidReason()`）**：

- `validate()` 改为遍历 findings，`invalidReason()` 返回原因（引用不支持文件/无效 changeId/未引用自身变更证据/证据行未完整交付）；
- 有原因的 finding 记入 limitation 后丢弃，保留有效项继续；不再整份拒绝。
- 原「整份拒收」用例改为「无效 finding 被丢弃、其余被接受」。

**schema/大小校验失败不中断（L63–L86）**：

- `reviewx_submit` 中校验失败（大小超限、schema 不通过）时，不抛错，记 limitation「提交被拒绝且不发布」，向 agent 返回 `{ status: "REJECTED", accepted: false, error }`，`candidate` 不设置；
- 其它工具调用参数/材料无法满足时，记 limitation 并返回 `{ error }`，不再 fatal。

**支持 incomplete 部分结果（validate）**：

- `completion === "complete"`：有 blockers 或未读必需材料才拒绝；
- 否则（incomplete）：把 blockers 和缺失材料分别记入 limitations，作为部分结果接受；
- 新增对应单测：incomplete+blockers 被接受、complete 缺材料仍被拒。

**`reviewx_read` 不可分页优雅跳过（L109–L125）**：

- `read` 抛 `REVIEW_INCOMPLETE` 时捕获，记 limitation 并返回带 `note: Skipped` 的响应（不设置 delivered），不设 fatal；
- 新增单测「读取不可分页文件被优雅跳过」。

**错误信息具体化**：`accept()`、消息归属校验、终态校验等错误均附带实际状态值，便于定位。

### 3.4 `src/server/review/materials.ts` — `reviewError()` 简化

- 移除 `details` 参数（technical/stderr/cause/classified）；
- `reviewError(code, reason)` 现在只负责构造带固定模板的 `AppError`，复杂诊断由 `opencode.ts` 直接构造 `AppError` 完成；
- `textPages` 的单行超上限报错补充实际字节数。

### 3.5 `src/server/storage/report-store.ts` — 报告写入幂等 + 移除 limitations 节

- 移除 `## Review limitations` 小节（limitations 仅保留在 `execution.v1.json` 的 progress 中）；
- 写入前若 `report.md` 的目标目录已存在（报告已发布/已保存），直接返回相对路径，避免覆盖已发布报告（配合原有「不可变报告」原则）；
- 路径逃逸校验（`relative` 到 root）提前到 staging 创建之前。

### 3.6 `productionPrompt` — evidence 强约束（opencode.ts 内 `productionPrompt` 常量）

- 明确：对每个 Finding 的每个 changeId，至少一条 evidence 必须指向该变更自身文件（`newPath`+`source` 或 `oldPath`+`base`），且限于实际读过的行；不能仅基于未修改调用者或其它文件；
- 细化 unsupported 变更从可审范围排除的表述。

### 3.7 AGENTS.md 信任边界（L145、L189–L192）

- 允许唯一「用户级全局 AGENTS.md」（`$XDG_CONFIG_HOME/opencode/AGENTS.md` 或 `~/.config/opencode/AGENTS.md`）随会话加载，视为开发者本人可信配置；
- 仓库及所有父目录中的 AGENTS.md 通过逐层 `lstat` 直接拒绝；
- `/config` 返回的 `instructions` 中，仅允许等于该用户全局文件的那一项，其余视为「未纳入受控环境」拒绝。
## 4. 协议 / 行为变化清单

| 维度                 | 旧行为                        | 新行为                                            |
| -------------------- | ----------------------------- | ------------------------------------------------- |
| OpenCode 通信        | 全局 fetch（300s 响应头超时） | Node 原生 `http.request`（无响应头超时上限）      |
| `execution.protocol` | `"opencode-http"`             | `opencode-http/<actual version>`                  |
| serve 输出上限       | 16 KiB，超限杀进程            | 256 MiB 内存护栏，不杀进程；16 KiB 滚动 tail 诊断 |
| agent 轮询间隔       | 100ms                         | 500ms，由 io 预算兜底                             |
| 多次提交             | `REVIEW_CONFLICT` 整体失败    | 重复提交忽略；不同提交采纳最新                    |
| 无效 finding         | 整份拒绝                      | 逐个丢弃，保留有效项                              |
| 提交校验失败         | 抛错中断整轮                  | 返回 `REJECTED`，不发布，记 limitation            |
| incomplete+blockers  | 整份拒绝                      | 作为部分结果接受                                  |
| 不可分页读取         | fatal 中断                    | note: Skipped 跳过                                |
| 报告 limitations 节  | 写入 report.md                | 移除（仅存 execution.v1.json）                    |

---

## 5. 测试与验证
### 5.1 测试变更

| 文件                                      | 变更                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `tests/unit/review-receiver.test.ts`      | 大量新增：无效 finding 丢弃、schema 无效 REJECTED、incomplete 接受、complete 缺材料仍拒、重复提交采纳最新、identical 重复忽略、unsupported 跳过且不可引用、不可分页读取跳过；移除旧「整份拒绝」断言 |
| `tests/integration/opencode-http.test.ts` | 从 mock `fetch`/`ReadableStream` 改为真实 `node:http` 的 `createServer` 模拟原生 OpenCode；参数化重写（normal/other-version/user-instructions/post-submit-error/disconnect/tool-conflict/native-instructions） |
| `tests/unit/process.test.ts`              | 删除全部 `tail` 相关用例（模式已移除）                       |
| `tests/unit/logger-report.test.ts`        | 删除报告 limitations 相关断言                                |
| `tests/ai/real-opencode-smoke.ts`         | 辅助函数 `checkoutCommit` → `headCommit`（非 git 目录友好）  |

---

## 6. 风险与约束

- **提交语义变化**：多次提交从「冲突失败」变为「采纳最新/忽略重复」，消费端需接受 `candidate` 可能被替换，最终以 `accept()` 返回值 / 落盘结果为准。
- **报告 limitations 节移除**：`report.md` 不再出现 limitations，仅保留在 `execution.v1.json`；依赖报告文本的消费方需调整。
- **`reviewError()` 签名变化**：是内部 API，影响面限 `src/server`，但外部依赖方需同步。
- **版本记录依赖 `/global/health` 返回非空 version**：极老版本若不返回将报 `OPENCODE_PROTOCOL_UNSUPPORTED`，属有意的「能力校验」行为。
- **未验证项**：`test:ai`、`test:e2e`、打包发布（`pnpm build` / `prepack`）在本设备未运行，复现时需在实际环境补齐。