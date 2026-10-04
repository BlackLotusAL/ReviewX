# 检视性能与质量验收

## 运行方式

默认 `REVIEWX_WORKFLOW=legacy`，保留四路检视作为回退。以下 PowerShell 命令在启动 ReviewX 的同一窗口执行：

```powershell
$env:REVIEWX_WORKFLOW = 'balanced'
pnpm start
```

`balanced` 使用一次综合发现（同时覆盖代码缺陷和适用规则），只对完全相同的候选进行主机去重，然后以每批最多 4 个候选、并发最多 2 批独立复核。候选不按数量截断。缺失、重复 ID 或无效结论会单独补查一次，再无有效结论则标记 incomplete；绝不当成 PASS。最终意见必须经过独立复核，主机按原候选顺序汇总。批内语义重复必须显式引用已确认且非重复的候选。跨批未证明相同根因的意见不会仅凭位置合并。

五分钟是整轮检视的软目标：页面提示当前阶段及复核剩余候选，但继续执行。保留整轮 60 分钟硬超时和用户停止行为。没有按文件数或行数定义的“复杂 MR”例外。

规则正文拆到工作区独立文件，review-context.json 提供规则 ID、hash 和文件索引。完整 diff、source/base 和调用方仍可按需读取；提示词要求覆盖完整 diff。复核输入去掉代码片段和方案示例，保留候选事实和定位，不传发现者的推理记录。无法证明上下文覆盖时必须标为 incomplete。

## 指标与证据

每个 attempt 的独立 trace 位于 `%LOCALAPPDATA%\ReviewX\logs\review-<attemptId>.jsonl`，成功、失败、停止和超时均保留。排队记录与执行记录在同一文件中；重启恢复可能开始新的 sequence 段，分析时以事件时间和 attemptId 为准。

事件包括排队、开始、固定 SHA 和规则 hash、Git 子命令、服务启动、生成、候选去重与来源映射、复核、格式修复、报告保存与可见、工作区和进程清理。`spanId` 关联起止，`sessionID/messageID/partID/toolCallID` 关联模型和工具。默认只写元数据、读取路径/区间、返回字节数及内容 hash，不复制源码、推理、凭据或候选全文。

成功报告的 execution.v1.json 增加可选 performance 字段；历史报告仍可读取。API 的 attempt.execution 同样提供此摘要。报告内指标截至 OpenCode 返回；保存和最终工作区清理的完整耗时以 trace 的 review.finished 和 span.end 为准，不回写不可变报告。

- `httpRequests`：应用到本机 OpenCode 的 HTTP 请求，包括状态轮询、SSE、消息补读和清理。
- `generationRequests`：应用发出的生成 POST；一个 POST 内可有多次模型生成。
- `observedModelSteps`：按 step-finish 稳定 ID 去重的已观测生成步数；SSE 和会话补读不会重复累计。
- `providerAttempts`：当前接口无法准确获得，固定为 null，不能由会话数或 step 数推算。
- `tokens`：分别保留 input、output、reasoning、cacheRead、cacheWrite；缺失为 null。使用 provider 对应计费口径，不能直接相加当作费用。
- `toolCalls/repeatedReads`：已完成/失败工具调用数、相同路径/区间/内容的重复 read 数，不等同于所有语义重复上下文。
- `eventStreamInterrupted/reconciliationFailed/traceWriteFailed`：观测完整性标记。结果有效不代表观测完整，缺失的事件或 usage 不可当作零。

SSE 中断不重发生成；生成响应丢失只查询原会话。结束前在独立 5 秒预算内补读会话树和消息，失败只影响观测。trace 写入失败不会改变检视结果。现有 `nativeSubagents` 保留为兼容计数，不作为模型调用数。

## 对照实验

```powershell
# 先执行普通回归，不调用模型
pnpm typecheck
pnpm lint
pnpm test

# 单个真实模型合成样本
$env:REVIEWX_WORKFLOW = 'balanced'
$env:REVIEWX_ACCEPTANCE_CASE = 'defects'
pnpm test:ai

# 三组、十二场景、每组每场景三次，共 108 次真实检视
pnpm build
pnpm test:ai:performance
```

三组为 oneshot、legacy、balanced，轮换顺序。oneshot 仅在测试工具中重建旧架构：禁止工具，完整 diff，加每文件 64 KiB／总计 256 KiB 源码快照；采用现有 JSON 契约和规则，因此不是历史 commit 提示词的逐字重放，也不会用于发布意见。模型实际身份无法由 CLI 事件确认时记录 unknown，必须另外核实模型及推理配置一致。

测试覆盖正反样本、跨文件单位错误、生命周期、await、异常处理、并发丢失更新和目录规则覆盖。运行器冻结构建后的引擎和规则，记录引擎/脚本 hash；固定 Git commit 时间并校验 fixture hash、规则和实际模型一致性，未知模型不能判定实验通过。推理配置需人工保持一致。产物包含每组耗时中位数、p95、超过五分钟次数、失败/超时、token 和调用指标。失败不从总样本数消失，成功样本分位数不代表全量服务 SLO。外层超时 62 分钟，高于引擎 60 分钟预算。

现有 generic-rules-benchmark 也改为 62 分钟外层预算，缺 execution/submission 判失败。smoke 启动时已有 Acceptance artifacts 路径标记，结束时另有 Production acceptance；两种标记均可识别。

真实 MR 的四个样本代码及人工标注未包含在仓库。上线前需在固定 SHA、规则、模型/推理配置下至少重复三次真实样本，并人工区分代码缺陷和规则意见：常规样本完成时间中位数 ≤5 分钟，公布 p95 和超时占比；严重缺陷无新增漏报，总体召回与精确率下降各不超过 2 个百分点。合成样本的关键词检查不能替代这些质量结论；数据不足时不能宣称质量达标。验收通过后再修改默认值，否则继续 legacy。

Git 缓存尚不启用：仅当实测 Git 准备中位数超过 30 秒时再实施，仍需每次 fetch、固定 SHA 和独立工作区。没有实际观测前，不把旧版 checkout+copy 与新版双 worktree 的差异当作已证实的性能回退。
