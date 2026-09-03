# ReviewX 产品需求文档

## 1. 产品定义

ReviewX 是一个面向 CodeHub Merge Request 的本机单用户代码检视网页。用户登记 Project ID 并手动刷新 open MR，按需将 MR 加入检视队列。ReviewX 通过 HTTPS 准备代码、调用一次 OpenCode 检视、保存本地 Markdown 报告，并在网页中等待用户逐条处理。只有用户在某条 Finding 上主动点击“发送到 CodeHub”后，ReviewX 才调用 CodeHub CLI 创建该条 MR 评论。

ReviewX 不定时扫描、不自动开始检视、不自动发布评论。网页只提供完成核心流程所需的项目管理、MR 发现、任务控制、意见处理和错误查看能力。

### 1.1 产品原则

- **本机运行**：服务只监听 loopback 地址，继续使用本机已认证的 CodeHub、Git 和 OpenCode CLI。
- **人工控制**：MR 由用户手动发现、手动开始，检视任务可停止或重新执行。
- **检视串行**：MR 检视任务进入全局 FIFO 队列，同一时间只执行一个。
- **发送有门禁**：检视结果先保存并展示，每条评论只能由用户在对应卡片上明确发送。
- **结果可追溯**：每次成功检视形成独立 attempt 和不可变报告，历史不因重新检视或移除 Project 而删除。
- **失败不自动恢复**：任何操作只尝试一次，不自动重试、补发或恢复。

### 1.2 核心功能

- 在网页中添加、查看和移除 Project ID。
- 手动刷新已登记 Project 的 open MR。
- 将单个 MR 加入检视队列，查看队列位置与执行进度。
- 停止排队中或执行中的检视任务，并重新执行任意非活动任务。
- 查看每次检视的 Markdown 报告和结构化 Findings。
- 对每条 Finding 直接选择发送或不发送，并允许撤销尚属最新 attempt 的跳过决定。
- 永久记录检视 attempt、发布结果、纯文本日志和错误诊断。

### 1.3 非目标

ReviewX 不提供：

- 远程部署、局域网访问、多用户、登录或权限系统。
- 定时或后台自动发现 MR、自动开始检视、自动发布评论。
- Finding 正文编辑、自动修复、Judge、多 Agent 或语义去重。
- 发布前 MR 版本校验、过时意见拦截或强制警告。
- 自动重试、评论补发、失败恢复或网页内发布重试。
- 多个 MR 检视任务并行执行。
- “结束处理”、批量舍弃或自动清理长期待处理意见。
- 数据库、统计看板、通知中心或与核心流程无关的设置页。

## 2. 产品入口与网页界面

### 2.1 启动方式

ReviewX 只有一个用户入口：

```text
reviewx
```

启动行为：

1. 创建本次服务会话的永久日志。
2. 获取单实例锁。
3. 仅在 loopback 地址上选择一个可用端口并启动 HTTP 服务。
4. 向终端输出访问地址和日志文件绝对路径。
5. 自动使用系统默认浏览器打开网页。

浏览器打开失败时，服务继续运行，终端显示可手动访问的地址和明确错误。HTTP 服务、状态目录或日志无法创建时，启动失败并退出。

已经有 ReviewX 实例运行时，第二次启动不得创建新实例；它应提示实例已经运行并提供现有访问地址。网页不提供远程访问和身份认证。

原有 `reviewx project ...` 和 `reviewx run ...` 不再是产品接口。

### 2.2 单页布局

网页采用单页布局，只包含三个区域：

1. **Project 区**：Project ID 输入框、添加按钮和已登记 Project 列表；每项提供移除按钮。
2. **MR 区**：全局“刷新 MR”按钮，以及按 Project 分组的 open MR 列表。
3. **MR 详情抽屉**：展示当前状态、执行阶段、错误、attempt 历史、完整报告、Findings 和发布结果。

MR 列表每项至少展示：

- Project 名称和 ID。
- MR 标题和可点击的 IID 外链；外链在新标签页打开对应 CodeHub MR，且不得触发本地详情抽屉。
- 最近一次手动刷新取得的 `updated_at`。
- 当前状态；排队时同时展示队列位置。
- 当前可执行的一个主操作，例如“开始检视”“停止”或“重新检视”。

任务状态和进度应自动更新，不要求用户刷新整个网页。网页不增加统计卡片、图表或多级导航。

详情抽屉标题区同步提供 CodeHub MR 外链。“完整报告”使用默认收起的原生折叠区：首次展开时读取报告，收起时保留已加载内容，再次展开不得重复请求；切换 attempt 后新报告仍默认收起。

### 2.3 用户可见状态

| 状态 | 含义 | 主要操作 |
| --- | --- | --- |
| 未检视 | 当前发现的 MR 尚无活动 attempt | 开始检视 |
| 排队中 | attempt 已进入 FIFO 队列 | 停止 |
| 检视中 | 正在准备代码、调用 OpenCode 或保存结果 | 停止 |
| 停止中 | 已收到停止请求，正在终止子进程并清理 | 无 |
| 已停止 | attempt 未完成且不会自动恢复 | 重新检视 |
| 检视失败 | attempt 因错误终止 | 重新检视 |
| 待处理 | 最新 attempt 仍有一个或多个 `pending` Finding | 逐条发送或不发送、重新检视 |
| 发送中 | 正在创建一条用户指定的评论 | 无 |
| 已完成 | PASS，或全部 Findings 均为已发送/已跳过 | 重新检视；最新 attempt 的已跳过项可撤销 |
| 发布失败 | 已无待处理项，且存在失败、未知或旧版未执行项 | 重新检视 |
| 已归档 | 新 attempt 已取代该 attempt，其未发布意见不可再操作 | 查看历史 |

“重新检视”是用户对“相同 `updated_at` 默认不重复检视”的显式覆盖。它可以再次检视同一 MR 版本并产生新的 attempt。

### 2.4 浏览器状态同步

网页加载后立即请求一次 `GET /api/state`，之后每 1 秒轮询一次，用于自动同步 Project、MR、队列位置、检视阶段、发布进度和错误状态。客户端不得并发发起重叠的状态请求；响应中的 `revision` 发生变化时，客户端同时重新读取当前打开的 MR 详情。

`GET /api/state` 只读取 ReviewX 进程内和本地持久化状态，不调用 CodeHub、Git、OpenCode 或评论接口，也不等同于用户点击“刷新 MR”。只有用户明确触发 `POST /api/mrs/refresh` 时才允许重新调用 CodeHub 获取 MR 列表和详情。完整本地 Web API 契约见 [API 接口说明](API.md)。

## 3. 对外依赖接口

### 3.1 CodeHub CLI

ReviewX 只依赖以下 CodeHub CLI 能力：

```text
codehub repo view <project-id> --output json
codehub mr list --project-id <project-id> --state open --output json
codehub mr view <mr-iid> --project-id <project-id> --output json
codehub mr comment create <mr-iid> --project-id <project-id> --body <markdown> --severity <severity> --output json
```

- `repo view` 用于添加 Project 时验证其存在，并取得唯一、不含凭据的 HTTPS clone URL。网页显示名取 URL 中的完整仓库路径。
- `mr list` 只在用户点击“刷新 MR”后调用，用于发现命令实际返回的 open MR；每项必须提供 IID 和非空标题。
- `mr view` 是 MR 详情、`updated_at`、源分支、目标分支和网页地址 `web_url` 的唯一来源。刷新时对每个 MR 调用一次；检视开始和 Git 准备完成后按核心流程再次调用。
- `mr list` 的筛选参数固定使用 `--state open`；`mr view` JSON 中的 `state` 允许使用 `open` 或 `opened` 表示开放状态。ReviewX 对这两个值做大小写不敏感的等价判断，其他状态均视为非开放状态。
- `mr view` JSON 中的 `web_url` 必须存在，且为不含用户名、密码的 HTTPS URL。缺失或非法值属于 CLI 兼容性错误，本次刷新失败并提示升级 CodeHub CLI；既有 v1 状态仍可启动。
- `mr comment create` 只能由用户在单条 Finding 上点击“发送到 CodeHub”触发，不得由 MR 刷新或 OpenCode 检视完成自动触发。
- ReviewX 接受 `mr list` 当前可能不是全量结果的限制，只处理命令实际返回的 MR。

`--body` 的参数值在调用前将所有换行统一为真实的 CRLF，完整 Markdown 作为单个 argv 值传入。Windows PowerShell 适配层通过 JSON 参数信封恢复参数数组，因此换行、制表符、引号和反斜杠不会拆分参数。日志或 JSON 中显示的 `\r\n` 只是 CRLF 的序列化表示；实际 CLI 参数不得包含反斜杠加 `r`、反斜杠加 `n` 的字面序列。

### 3.2 Git 与 OpenCode

- 代码只通过经验证、不含凭据的 HTTPS clone URL 准备。
- 源分支和目标分支各 fetch 一次并固定到 commit SHA，使用 `target...source` 三点差异。
- Git 准备完成后必须再次读取 MR 详情。若 `updated_at`、源分支或目标分支变化，本次 attempt 失败且不调用 OpenCode。
- OpenCode 在独立的只读审查副本中运行一次；输入包含完整三点 diff 和有界的变更文件快照。
- CodeHub、Git、GitHub 和 SSH 凭据不得进入 OpenCode 输入或环境。OpenCode 的模型供应商认证继续由 OpenCode 自身配置提供。
- 当前 CodeHub 契约没有源 Project 信息，因此只支持源分支和目标分支位于同一 Project 的 MR。
- 不初始化 submodule；Git LFS 保持 Git 默认 checkout 行为。

## 4. 本地状态与数据模型

ReviewX 继续使用本地文件持久化，不引入数据库。状态写入必须使用短时文件锁和原子替换。

本地状态至少保存：

- 按添加顺序排列的 Project ID、Project 名称和 HTTPS clone URL 引用。
- 每个 Project 最近一次成功刷新的 open MR 快照，包括可选的 CodeHub `webUrl`；可选性仅用于读取没有该字段的旧 v1 状态。
- 全局检视 FIFO 队列及其顺序。
- 每个 MR 的全部 review attempt。
- 每个 attempt 的唯一 ID、`updated_at`、源/目标分支、状态、时间和报告引用。
- 每个 Finding 的固定顺序、severity、Markdown body、处理状态及可选 `dismissedAt`。
- 每次发送的兼容批次记录；新记录固定只包含一个 Finding ordinal，旧版多条批次仍可读取和恢复。

Finding 的持久化发布状态至少包括：

- `pending`：尚未处理，最新 attempt 中可发送或标记为不发送。
- `published`：CodeHub 已明确确认创建成功。
- `dismissed`：用户明确选择不发送；仅在仍是最新 attempt 时允许撤销为 `pending`。
- `failed`：CodeHub 明确返回失败。
- `unknown`：进程中断或 CodeHub 无法确认写入结果。
- `not_attempted`：旧版多条批次在前序失败后未执行；新单条记录不会产生该状态。
- `archived`：被新 attempt 取代，不可再发布。

每次成功检视必须生成独立报告；即使 Project、MR IID 和 `updated_at` 完全相同，也不得覆盖历史报告。移除 Project 只移除登记项和主列表入口，不删除 MR 快照、attempt、报告、发布记录或日志；重新添加后恢复可见。

服务启动时，持久化为“排队中”“检视中”“停止中”的 attempt 一律恢复为“已停止”，不得自动继续。待处理、已完成、发布失败和已归档状态保持不变。

## 5. 核心流程

### 5.1 Project 管理

添加 Project：

1. Project ID 必须是正整数。
2. 重复添加立即失败。
3. 调用 `codehub repo view` 验证 Project 并取得 HTTPS clone URL。
4. 验证成功后持久化，并按添加顺序展示。

移除 Project：

1. 如果该 Project 正在发送评论，移除按钮暂时禁用；已经开始的评论发送不可中断。
2. 如果该 Project 有执行中的检视，进入“停止中”，立即终止当前 Git/OpenCode 子进程并清理临时目录。
3. 该 Project 的排队 attempt 全部转为“已停止”并移出队列。
4. 停止和清理完成后移除登记项，并从主列表隐藏该 Project。
5. 历史数据永久保留。

移除不存在的 Project 必须失败。

### 5.2 手动刷新 MR

用户点击“刷新 MR”后：

1. 按 Project 添加顺序串行处理全部已登记 Project。
2. 调用 `mr list` 取得 open MR。
3. 按返回顺序对每个 MR 调用 `mr view`，取得 `updated_at` 和分支信息。
4. 一个 Project 的全部数据成功取得后，原子替换该 Project 的当前 MR 列表。
5. 已关闭或不再返回的 MR 从当前列表移除，但其历史 attempt 和报告保留。

刷新只更新列表，不创建 attempt、不加入队列、不调用 Git 或 OpenCode。

某个 Project 刷新失败时，本次刷新停止：该 Project 和尚未处理 Project 保留上次成功结果，已经完整刷新的 Project 保留本次新结果。错误在网页和会话日志中显示。ReviewX 不自动重试。

刷新发现新的 `updated_at` 时，MR 主列表显示新版本，但旧 attempt 不自动重检。由于本产品明确不做发送前版本校验，在新的成功 attempt 产生前，旧的最新 attempt 仍可由用户发送其 pending Findings。

### 5.3 检视队列与任务控制

点击“开始检视”或“重新检视”会创建一个新 attempt，并追加到全局 FIFO 队列尾部。每个 MR 同一时间最多存在一个排队中或检视中的 attempt；按钮在该期间禁用。

创建新 attempt 时：

- 该 MR 旧的可操作 attempt 立即转为“已归档”。
- 旧 attempt 中已发布的记录保持不变。
- 旧 attempt 中仍为 `pending` 的 Findings 转为 `archived`；已发送、已跳过、失败、未知和旧版未执行记录保持原状态，全部只读。
- 新 attempt 即使使用相同 `updated_at`，仍作为一次新的人工检视执行。

队列严格按点击顺序执行，同一时间只运行一个检视 attempt。

停止规则：

- 排队中的 attempt 点击“停止”后立即移出队列并转为“已停止”。
- 检视中的 attempt 点击“停止”后先转为“停止中”，立即向当前 Git 或 OpenCode 子进程发送取消信号，等待子进程退出并清理临时目录，再转为“已停止”。
- 已停止 attempt 不保存不完整报告，不记录为成功检视版本，不创建评论。
- attempt 已完成报告持久化并进入“待处理”或“已完成”后，不再显示“停止”。

失败规则：

- 当前 attempt 转为“检视失败”。
- 全部尚未开始的排队 attempt 转为“已停止”并清空队列。
- 与检视队列独立运行的评论发布不受影响。
- 用户可以逐个点击“重新检视”，重新建立队列。

### 5.4 单个 MR 检视

每个 attempt 的处理顺序固定为：

1. 调用 `codehub mr view` 取得本次 attempt 的当前 `updated_at` 和分支。
2. 通过 HTTPS clone/fetch 准备源分支和目标分支代码。
3. 再次调用 `mr view` 验证 `updated_at`、源分支和目标分支没有变化。
4. 调用一次 OpenCode 检视最终整体变化。
5. 解析第 6.1 节定义的 Reviewer 输出。
6. 保存本次 attempt 的独立 Markdown 报告。
7. 持久化 attempt、报告引用和全部 Findings。
8. 清理临时工作区。
9. 根据结果进入“已完成”或“待处理”。

第 7 步成功前不得把本次 attempt 展示为可处理。任何 Finding 存在时，结果进入“待处理”；`findings` 为空表示 PASS，直接进入“已完成”。两种结果都必须保存报告。

检视流程不得调用 `mr comment create`。

如果 MR 在 Git 准备期间变化，第 3 步失败，不调用 OpenCode、不保存报告。若 MR 在第 3 步之后再次提交代码，ReviewX 仍保存当前 attempt 的结果；只有用户再次刷新并主动重新检视，才会处理新版本。

### 5.5 意见处理与发送

待处理 attempt 在详情抽屉中按 Reviewer 返回顺序展示全部 Findings。每项显示 severity、完整 Markdown、处理状态和卡片级动作；Finding 正文不可编辑，不显示复选框、全选或底部批量发布栏。

最新 attempt 的每条 `pending` Finding 直接提供：

- 次操作“不发送”：立即持久化为 `dismissed` 并记录 `dismissedAt`。
- 主操作“发送到 CodeHub”：单击立即执行，不弹确认框。

`dismissed` Finding 显示“已跳过 · 撤销”。只要该 attempt 仍是该 MR 的最新 attempt，即使它已进入“已完成”或“发布失败”，用户仍可撤销为 `pending`；新 attempt 创建后，历史 attempt 全部只读。

用户点击“发送到 CodeHub”后：

1. 当前 attempt 进入“发送中”，目标卡片显示“发送中…”。
2. 全部 Finding 决策操作暂时禁用，保证全局同一时间最多一条评论命令。
3. 对目标 Finding 调用一次 `mr comment create`。
4. 命令成功后立即把该 Finding 持久化为 `published`。
5. 兼容发布记录仍使用既有 batch 结构，但新 batch 的 `selectedOrdinals` 固定只含该 ordinal。
6. 若仍有 `pending` Finding，attempt 回到“待处理”；否则按 5.6 节统一归并为“已完成”或“发布失败”。

发送通道与检视队列独立：一条评论可以与一个 Git/OpenCode 检视 attempt 并行运行。其他 Finding 的发送与决策操作在全局发送通道占用期间禁用。

发送前不得调用 `mr view` 或比较 `updated_at`。用户可通过 MR 外链和手动刷新判断结果是否仍适用；ReviewX 接受旧版本意见被发送到已更新 MR 的风险。

已经开始的评论发送不可停止。停止检视任务、检视失败或检视队列清空都不得中断它。

### 5.6 发布失败

单条评论创建失败或结果未知时：

1. 只终结目标 Finding，根据证据记录为 `failed` 或 `unknown`，且不提供重发操作。
2. 其他 `pending` Findings 保持可处理，不自动重试或补发目标 Finding。
3. 不影响正在执行或排队的检视任务。

每次 Finding 决策后集中归并 attempt 状态：

- 只要存在 `pending` Finding，attempt 为“待处理”，即使已有 `failed` 或 `unknown`。
- 无 `pending` 且全部 Findings 均为 `published` 或 `dismissed` 时，attempt 为“已完成”。
- 无 `pending` 且存在 `failed`、`unknown` 或旧版 `not_attempted` 时，attempt 为“发布失败”。

网页不为失败、未知或旧版未执行 Finding 提供重发。用户应通过 MR 外链在 CodeHub 核对结果，再处理其他 pending 项或主动“重新检视”。

如果服务在评论命令执行期间退出，无法确认结果的当前 Finding 在下次启动时恢复为 `unknown`；其他 `pending` Findings 保持可处理。旧版多条批次中已选但未执行的后续项仍恢复为 `not_attempted`。恢复后同样按上述集中规则归并，且不得自动补发。

## 6. 输出契约

### 6.1 Reviewer 最小输出

OpenCode 最终正文必须是一个 JSON 对象：

```json
{
  "findings": [
    {
      "severity": "major",
      "body": "Markdown review comment"
    }
  ]
}
```

规则：

- `findings` 必须是数组。
- 空数组表示 PASS。
- 每个 Finding 必须包含 `severity` 和非空 Markdown `body`。
- `severity` 只允许 `fatal`、`major`、`minor` 或 `suggestion`。
- 任一 Finding 非法时拒绝整个结果。
- ReviewX 不纠正输出，也不再次调用 OpenCode。

### 6.2 Markdown 报告

每个成功 attempt 保存一份独立、不可变的 Markdown 报告。报告至少包含：

- attempt ID、Project ID、MR IID 和 `updated_at`。
- 源分支、目标分支及固定的 source/target commit SHA。
- PASS 或 FINDINGS 结果。
- 按原顺序排列的全部 Findings。
- 每个 Finding 的 severity 和完整 Markdown body。

报告记录 OpenCode 的原始成功结果，不因用户发送、跳过、失败或重新检视而修改。Finding 处理状态单独保存在本地状态中并由网页展示。

报告路径必须位于 ReviewX 数据目录内；网页只能读取状态中已登记且解析后仍位于该目录内的文件。

### 6.3 MR 评论规范

每个 Finding 的 `body` 应保留以下 Markdown 骨架。该骨架用于指导 OpenCode 生成可读、可执行的意见；ReviewX 不解析或校验其中的章节数量、标签、代码块或解决方案数量。

参考来源：[ReviewX MR 评论规范](https://github.com/BlackLotusAL/ReviewX/blob/main/docs/product-requirements.md#5-mr-%E8%AF%84%E8%AE%BA%E8%A7%84%E8%8C%83)。

````markdown
### 🟠 Major: <问题标题>

**问题描述**：

- 严重级别：Major
- 标签：`#tag`
- 简述：<问题说明>

**问题位置**：`path/to/file:line-range`

```language
<相关代码>
```

**影响分析**：

- **直接后果**：<直接后果>
- **影响范围**：<影响范围>
- **触发条件**：<触发条件>

**解决方案**：

<可执行的解决方案；数量按问题实际需要，不要求两个>

```language
<必要时提供示例代码>
```

**预防措施**：

- <预防同类问题的措施>
````

评论要求：

- 标题中的信号灯、展示等级和 JSON `severity` 应保持一致。
- 问题位置使用仓库相对路径，并尽量给出行号或明确代码范围。
- 影响分析说明直接后果、影响范围和触发条件。
- 解决方案数量由问题决定，不要求固定为两个。
- 代码示例仅在有助于说明问题或方案时提供。
- 预防措施应与当前问题直接相关。

Severity 展示：

| severity | 展示 |
| --- | --- |
| `fatal` | 🔴 Fatal |
| `major` | 🟠 Major |
| `minor` | 🟡 Minor |
| `suggestion` | 🟢 Suggestion |

### 6.4 网页 Markdown 展示

报告和 Finding Markdown 均视为不可信输入。网页渲染必须：

- 禁止原始 HTML、脚本、内联事件和危险 URL scheme。
- 对链接和图片地址执行 allowlist 校验；不得自动加载本机文件或带凭据资源。
- 保留标题、列表、代码块和普通链接等阅读所需格式。
- 不执行 Markdown 中的命令、表单或嵌入内容。

## 7. 日志与错误处理

### 7.1 日志

- 每次 `reviewx` 服务启动创建一份独立纯文本日志并永久保留。
- 终端只在启动时打印本次日志路径和网页地址；运行进度写入日志并以简化状态同步到网页。
- 日志使用英文自然语言，包含 Project、MR、attempt、队列或评论上下文，不显示内部事件名或 `key=value` 字段。
- 时间使用运行机器的本地时间，格式为 `YYYY-MM-DD HH:mm:ss.SSS`，不附加时区后缀。
- CodeHub 和 Git 凭据不得出现在日志、报告、状态响应、网页或 OpenCode 输入中。
- 网页提供当前会话日志入口；历史日志永久保存在本地数据目录。

动态标题、路径、stderr 和 stack 中的换行、制表符、控制字符及凭据必须转义或脱敏，不能伪造额外日志行。

### 7.2 故障诊断

同一个错误只在最具体的失败阶段记录一次。诊断至少说明：

- 失败的 Project、MR、attempt、Finding 或操作。
- Cause：直接原因。
- Impact：已保存、已发布、未执行和受影响队列的状态。
- Next step：用户下一步应执行的人工操作。
- Technical details：错误码、进程退出码和可用 stderr。

非空 stderr 经凭据脱敏并移除 ANSI 控制码后附在诊断末尾。非预期内部错误额外附脱敏后的 stack；已分类业务错误不输出 stack。

### 7.3 统一错误原则

- 当前操作只尝试一次。
- 不自动重试、修正、补发或恢复。
- Project 添加失败只影响本次添加。
- MR 刷新失败停止本次刷新，不改变未完整刷新的 Project 数据。
- 检视失败停止整个检视队列，并把剩余项转为“已停止”。
- 评论发送失败只终结当前 Finding，不停止检视队列或阻塞其他 pending Finding。
- 报告保存失败时，不持久化可发布 attempt。
- attempt 状态保存失败时，报告可以保留在磁盘，但不得在网页中提供发布入口。
- 日志无法创建时服务不得启动；运行期间日志不可写时，ReviewX 进入致命错误状态，不再启动新的刷新、检视或发布操作。

用户主动停止属于正常任务结果，不作为失败重试或错误诊断处理；日志仍需记录停止阶段和清理结果。

## 8. 安全与访问边界

- HTTP 服务只监听 loopback 地址，不监听 `0.0.0.0`、局域网或公网接口。
- 不启用 CORS；状态变更请求只接受同源网页，并校验 Host 与 Origin。
- 网页不得接收、显示或保存 CodeHub、Git、SSH 或模型供应商凭据。
- 所有子进程继续使用参数数组且禁止 shell 拼接。
- 所有本地报告和日志访问都必须限制在 ReviewX 数据目录内，拒绝路径穿越和任意文件读取。
- MR 标题、仓库路径、OpenCode 输出、CLI stdout/stderr 和 Markdown 均按不可信数据处理。
- 浏览器关闭不停止服务或活动任务；终端进程退出才停止服务。

## 9. 验收标准

| 场景 | 必须结果 |
| --- | --- |
| 本机启动 | 无参数 `reviewx` 只监听 loopback，输出地址和日志路径，并自动打开默认浏览器 |
| 重复启动 | 不创建第二实例，明确提示已有实例及访问地址 |
| Project 管理 | 支持添加、查看、移除和重新添加；验证 Project，历史不删除 |
| 手动刷新 | 只更新 open MR 列表，不调用 Git、OpenCode 或评论接口 |
| 无自动化 | 不定时刷新，不自动创建检视任务，不自动发布 |
| FIFO 队列 | 多个 MR 严格按点击顺序执行，同一时间只检视一个 |
| 停止排队项 | 立即移出队列并转为已停止 |
| 停止执行项 | 终止当前子进程、清理工作区，不保存不完整结果 |
| 检视失败 | 当前 attempt 失败，全部排队项转为已停止，不自动继续 |
| 应用重开 | 原排队中、检视中和停止中 attempt 全部恢复为已停止 |
| 重复检视 | 非活动 MR 可人工重新检视；同一 `updated_at` 生成独立 attempt 和报告 |
| 旧结果 | 新 attempt 创建后，旧 pending 意见归档，其他 Finding 决策保留且全部只读 |
| MR 中途变化 | Git 准备后校验失败，不调用 OpenCode、不保存报告 |
| PASS | 保存报告并进入已完成，不进入待处理、不创建评论 |
| Findings | 保存完整报告和 Findings 后进入待处理，绝不自动评论 |
| 卡片级决策 | 无复选框或批量栏；每条 pending Finding 直接提供“不发送”和“发送到 CodeHub” |
| 跳过与撤销 | 不发送持久化为 dismissed；最新 attempt 可撤销，历史 attempt 只读 |
| 逐条发送 | 一次只发送目标 Finding；内部 batch 新记录只含一个 ordinal，其他 pending 项不变 |
| 发送并行 | 一条评论可与一个检视 attempt 并行；评论发送之间全局串行 |
| 无版本校验 | 发送前不调用 `mr view`，不拦截旧版本意见 |
| 发送失败 | 目标项记录 failed/unknown 且不可重发；其他 pending 项仍可处理；无 pending 后统一归并状态 |
| 发送与队列隔离 | 发送失败或发送进行中不停止独立检视队列 |
| 项目移除 | 停止该项目检视、取消排队；发送中暂不可移除；历史保留 |
| 报告 | 默认收起、首次展开加载、收起保留缓存；每个成功 attempt 独立且不可变 |
| MR 外链 | 列表 IID 和详情标题均使用经验证的 `web_url`，新标签页打开且点击不触发详情 |
| CLI 兼容 | 新 `mr view` 缺少或返回非法 `web_url` 时刷新失败并提示升级；旧 v1 状态仍可启动 |
| Markdown 安全 | 危险 HTML、脚本、URL 和嵌入内容不能执行或访问本机资源 |
| 日志 | 每次服务一份永久日志，网页可查看简化进度和完整诊断 |
| 凭据 | 不出现在网页、状态响应、日志、报告或 OpenCode 输入中 |
