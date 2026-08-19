# ReviewX 产品需求文档

- 文档状态：Draft
- 版本：0.5
- 更新日期：2026-08-12
- 配套文档：[技术架构设计](./technical-architecture.md)

> 技术架构设计尚未按本版本同步；存在冲突时以本文为准，后续再按本文对齐。

## 1. 产品定位与范围

ReviewX 是一个可私有化部署、由命令接入的 MR 自动检视系统。确定性的 workflow 负责发现 MR、准备工作区、调用 Agent 和发布评论；专家 Agent 负责理解代码、发现问题和生成意见。运行过程通过日志文件观测。

### 1.1 核心目标

1. 通过命令添加需要持续跟踪的 CodeHub 仓库 ID。
2. 自动检视首次发现、此前失败或 `updated_at` 严格变新的 Open MR。
3. 由设计、业务和代码专家独立检视 MR 的最终整体净变化。
4. 由裁判 Agent 选择一个最高价值问题或返回 `PASS`，并避免重复发布历史问题。
5. 每次 MR 更新最多发布一条新问题评论；不同更新发现的不同问题可以分别评论。
6. 通过结构化日志记录每次检视的结果和错误。

## 2. Workflow 与 Agent 分工

| 参与者 | 职责 | 不负责 |
| --- | --- | --- |
| Workflow | 登记仓库；发现 Open MR；clone/fetch；创建工作区并切换 source 分支；读取 commit 列表；调用 Agent；校验输出结构；保存最小状态；发布评论和写日志 | 整理、裁剪、摘要或解释 diff；按单个 commit 拆分检视；替代 Agent 做语义判断 |
| 设计规范专家 | 检查模块边界、依赖方向、架构模式和 API/数据兼容性 | 调度流程、修改代码、运行项目命令、发布评论 |
| 业务规则专家 | 检查领域不变量、状态流转、金额、权限、库存、配额和接口契约 | 在证据不足时推测业务规则 |
| 代码正确性专家 | 检查边界、错误处理、并发、事务、安全、性能、资源释放和测试覆盖 | 调度流程、修改代码、运行项目命令、发布评论 |
| 裁判 Agent | 验证候选证据、合并重复问题、排序并输出一个问题或 `PASS`；与历史问题做语义比较；生成最终评论 | 修改专家候选或绕过 workflow 直接发布 |

Workflow 向 Agent 提供 MR 元数据、工作区路径、source/target 分支信息和 commit 提交列表。Agent 直接在工作区中使用读取、搜索和只读 Git 操作获取代码与整体差异，不执行构建、测试或项目脚本。

Commit 列表只用于理解变更目的和演进过程。检视对象是 source 分支相对 target 分支的最终整体净变化；早期 commit 引入、但已被后续 commit 修复的问题不得输出。

## 3. 核心流程

1. 管理员通过命令添加仓库 ID；workflow 验证仓库存在性和读取权限，拒绝无效或重复 ID，并持久化有效记录。
2. Workflow 定时查询已登记仓库的 Open MR，仅为首次发现、此前失败或 `updated_at` 严格变新的 MR 创建 Review Run；等价时间格式或暂时返回的旧时间不触发重复检视。
3. Workflow clone 或 fetch 仓库，创建隔离工作区并切换到 MR source 分支，然后读取 source/target 分支信息和 commit 列表。
4. 设计、业务和代码专家直接读取工作区，基于 MR 的最终整体净变化独立输出 Markdown 评审报告。
5. 裁判 Agent 结合候选问题、工作区和该 MR 的历史 ReviewX 问题，输出 `PASS`、`duplicate_of` 或一个 `new` 问题。
6. `new` 问题仅在 MR 仍为 Open 且 `updated_at` 与检视开始时一致时发布为普通 MR 评论；`PASS`、`duplicate_of`、已更新或已关闭的 MR 不发布评论。
7. Workflow 保存处理结果并写日志：成功处理后更新 `last_processed_updated_at`；发布评论后刷新 MR 最新 `updated_at` 并保存评论 ID；失败或中断时不更新时间，下一次扫描从头重试。

同一个 MR 同时最多运行一个 Review Run。Agent 只能生成评论内容，不能获得 CodeHub 评论凭据；评论统一由 workflow 发布。

## 4. 功能需求

### 4.1 仓库跟踪

| 编号 | 需求 |
| --- | --- |
| PR-REP-001 | 系统支持通过命令添加 CodeHub 仓库 ID，并验证仓库存在性、读取权限和重复状态 |
| PR-REP-002 | 有效仓库 ID 被持久化并自动进入 Open MR 定时扫描 |

### 4.2 Workflow

| 编号 | 需求 |
| --- | --- |
| PR-WF-001 | 仅为首次发现、此前失败或 `updated_at` 严格变新的 Open MR 创建 Review Run；等价或暂时回退的时间不重复检视 |
| PR-WF-002 | 检视前完成仓库 clone/fetch、隔离工作区创建、source 分支切换和 commit 列表读取 |
| PR-WF-003 | Workflow 不得预先整理或摘要 diff，也不得按单个 commit 拆分检视任务 |
| PR-WF-004 | Workflow 调用三个专家和裁判 Agent，并校验其结构化输出；语义判断由 Agent 完成 |
| PR-WF-005 | 同一个 MR 同时最多运行一个 Review Run |
| PR-WF-006 | 发布前确认 MR 仍为 Open 且 `updated_at` 未变化；发布后刷新并保存最新 `updated_at` |
| PR-WF-007 | 失败或中断的运行不更新 `last_processed_updated_at`，后续扫描从头重新检视 |
| PR-WF-008 | 扫描连续存在错误并达到配置阈值时终止服务，默认阈值为 3 轮；无错误的一轮重置计数 |

### 4.3 Agent 检视与裁判

| 编号 | 需求 |
| --- | --- |
| PR-AI-001 | 每个 Review Run 由设计规范、业务规则和代码正确性专家独立分析 |
| PR-AI-002 | 专家直接读取工作区，自主获取整体差异和完成判断所需的代码上下文 |
| PR-AI-003 | 专家必须综合所有 commit 形成的最终整体净变化，不得输出已被后续 commit 修复的问题 |
| PR-AI-004 | 各专家输出独立 Markdown 评审报告；证据不足时明确说明证据不足而不是推测 |
| PR-AI-005 | 裁判 Agent 读取三个专家报告，验证证据、合并重复问题并排序，每次选择至多一个有效问题 |
| PR-AI-006 | 裁判 Agent 将选中的问题与历史 ReviewX Markdown 或旧版摘要做语义比较，并标记为 `new` 或 `duplicate_of` |
| PR-AI-007 | 裁判 Agent 以隐藏 JSON 控制头表达 `pass`、`new` 或 `duplicate_of`，并为 `new` 生成符合第 5 章规范的自由 Markdown 评论正文 |

### 4.4 评论与日志

| 编号 | 需求 |
| --- | --- |
| PR-OUT-001 | 每次 Review Run 最多向对应 MR 发布一条 `new` 问题的普通评论，不提供草稿或 inline 评论模式 |
| PR-OUT-002 | 不同更新发现的不同问题允许分别评论；`PASS`、`duplicate_of`、已更新、已关闭或失败的运行不得发布评论 |
| PR-OUT-003 | 评论必须包含待修改文件和行号或明确代码范围 |
| PR-OUT-004 | `new` 问题发送给 CodeHub 的 Markdown 原文保存到对应 Agent 结果目录的 `review.md` |
| PR-LOG-001 | 每个 Review Run 使用稳定 UUID；文本日志使用其前 8 位短引用，并以 `[带系统本地 UTC 偏移的 ISO-8601 时间] [LEVEL] [event]` 作为固定前缀；系统时区或夏令时变化后，后续日志使用新的偏移 |
| PR-LOG-002 | 日志详情记录仓库 ID、MR ID、`updated_at`、结果或错误、`new`/`duplicate_of` 判断和评论 ID |
| PR-LOG-003 | 日志记录扫描、worktree、commit、每个 Agent、评论发布、状态保存和清理的关键步骤、结果与耗时，不记录 Agent 原始输出或评论正文 |
| PR-LOG-004 | 四个 Agent 默认实时记录进程就绪、步骤、脱敏工具动作、步骤耗时和 token/cache 汇总；Judge 事件必须标记 attempt |
| PR-LOG-005 | Agent 连续 60 秒没有 OpenCode 事件时记录等待心跳；日志不得包含工具输出、源码、提示词或 Assistant 文本，动作最多 300 字符且路径相对 worktree |

## 5. MR 评论规范

最终评论必须包含：

- 标题和不带数字前缀的严重等级。
- 一个或多个受控 Tag。
- 待修改代码的文件和行号或明确代码范围。
- 问题说明以及具体触发条件或失败场景。
- 对业务或系统的影响。
- 可操作的修改建议，以及与目标代码语言一致的最小替换代码块。
- 置信度。
- 命中的规则 ID；没有匹配规则时允许为空。

示例：

````markdown
### [Critical][correctness][transaction] 事务提交前提前发送成功事件

**位置**：`src/payment/PaymentService.java:184-189`

**问题**：事务确认提交前已经发送成功事件；如果事务随后回滚，下游会收到与真实状态不一致的通知。

**修改建议**：将事件发送移动到事务提交后的回调中，并补充事务回滚时不发送事件的测试。例如：

```java
@Transactional
public void completePayment(Payment payment) {
    payment.markSucceeded();

    TransactionSynchronizationManager.registerSynchronization(
        new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                publishSuccess(payment.getId());
            }
        }
    );
}
```

**置信度**：94%

**规则**：`JAVA-TX-004`
````

严重等级：

| 等级 | 含义 |
| --- | --- |
| Blocker | 明确的安全事故、数据损坏或大面积不可用风险 |
| Critical | 高概率严重错误，需要合入前处理 |
| Major | 真实的功能、性能或维护风险，建议合入前处理 |
| Minor | 局部低风险问题 |

标准 Tag：

```text
security
correctness
business-rule
concurrency
transaction
performance
resource-leak
compatibility
api-contract
architecture
maintainability
test-coverage
observability
```

允许增加 `domain:<name>` 形式的仓库级业务标签。

## 6. 非功能需求

### 6.1 执行边界

- Agent 只能读取和搜索文件、执行只读 Git 操作，不得修改代码或运行构建、测试和项目脚本。
- Agent 不持有 CodeHub 评论凭据；评论只能由 workflow 发布。

### 6.2 最小可靠性

- 必须持久化仓库 ID、每个 MR 的 `last_processed_updated_at`、历史评论 Markdown 和评论 ID；旧版问题摘要保持读取兼容。
- 服务重启后不恢复中间阶段；未完成运行由后续扫描从头重新执行。
- MR 更新检查、单 MR 单运行和历史问题比较必须确保不会发布旧结果或重复问题。

## 7. 验收标准

| 场景 | 预期结果 |
| --- | --- |
| 添加仓库 ID | 有效 ID 被持久化并进入扫描；无效或重复 ID 被拒绝并记录原因 |
| 扫描 Open MR | 仅首次发现、此前失败或 `updated_at` 变化的 MR 创建 Review Run；其他状态或未变化 MR 被忽略 |
| Workflow 准备环境 | 完成 clone/fetch、工作区创建、source 分支切换和 commit 列表读取，不生成 diff 摘要或逐 commit 任务 |
| 检视多 commit MR | Agent 基于最终整体净变化检视，前序 commit 中已被后续修复的问题不输出 |
| 裁判与评论 | `new` 问题发布一条包含全部必填字段和代码示例的普通 MR 评论；`PASS` 和 `duplicate_of` 不评论 |
| 本地意见文档 | `new` 问题的 CodeHub 评论 Markdown 原文保存到对应 Agent 结果目录的 `review.md` |
| MR 在检视期间变化 | MR 更新或关闭时不发布当前结果；不同更新发现的不同新问题允许分别评论 |
| 失败、重启或自身评论 | 失败和中断任务在后续扫描从头执行；连续错误达到阈值时服务终止；相同问题不重复发布；ReviewX 评论造成的 `updated_at` 变化不触发循环 |
