# ReviewX 产品要求：原生检视 v2

## 产品边界

Windows 10/11 本地单实例工具；Node.js 22+。依赖 Git、CodeHub CLI 和已经配置认证及默认模型的 OpenCode。仅监听随机 loopback 端口。没有定时刷新、自动评论或外部写入重试。

ReviewX 管理项目、MR 快照、FIFO、取消、报告和人工发送。OpenCode 管理工具调用、子代理和上下文。不得重新实现材料页账本、工具收据、上下文复制、投票或逐代理重试。

## 检视工作流

固定 source、target、merge-base 后创建 source/base 隔离工作区，并提供 changes.diff、scope.json、review-context.json。
主代理整理意图和规则，调用两个规则检视子代理、两个新增缺陷检视子代理；去重后，每个候选交给新上下文的验证子代理。只发布复核确认的问题。
包含有代码依据的条件、边界、异常、并发缺陷；过滤既有问题、风格建议、猜测和重复问题。用户发起检视不因已有评论或改动简单而跳过。

主代理和子代理沿用 OpenCode 默认模型，无模型品牌与版本白名单。依赖原生 HTTP 会话、代理、任务工具及权限功能；不能使用必要能力时给出具体错误，不保证任意版本或不具备工具能力的模型都兼容。

权限只允许工作区读取、搜索和宿主列出的固定只读 Git 命令，以及主代理调用指定检视子代理。禁止编辑、构建、测试、项目脚本、网络研究和自动评论。仓库内容和规则不能改变权限。

## 规则

全局补充来自安装包 resources/rules 直属 Markdown 文件，入队时冻结并持久化，合计最多 1 MiB。规则内容不做凭据正则拒绝；日志仍脱敏。
仓库规则来自固定 source 修订的根目录及变更路径祖先目录 AGENTS.md/CLAUDE.md，source 缺失时回看 base；不跟随规则链接。
较近目录覆盖祖先；明确适用的全局补充覆盖仓库要求；无法解决的同级冲突记为限制。表达偏好只影响内容详略、术语，不改变固定章节和 JSON 合同。

## 输出合同

共享 ReviewDocument 与 StructuredFinding 是唯一内容合同。顶层 schemaVersion=1、summary、completion、limitations、findings。
Finding 包括 severity、title、tags、description、locations、impact、solutions、preventions。位置包含 path/revision/startLine/endLine 和可选 snippet；impact 包括 direct/scope/trigger；方案包含 description 和可选 example。片段包含 language/code。
severity 为 fatal/major/minor/suggestion。位置、方案、预防措施至少一项；tags 可空。文本为纯文本，代码片段可选。
脚本固定生成中文 Markdown 标题、严重级别、标签、问题描述、问题位置、影响分析、解决方案、预防措施。普通文本转义，代码围栏长度适应片段；入库后正文冻结，展示与发送共用，不在发送时调用模型。

只对完整 JSON 或单个完整 JSON 代码块解析，不从聊天截取 JSON 碎片。结构错误最多在无工具的新会话中修复一次；已有有效意见不交给修复器改写。无效项隔离、原文保留并标 PARTIAL。complete 且零问题才为 PASS。复核未完成不能标 PASS。

## 状态与失败

普通检视失败仅结束当前任务，其余 FIFO 继续。SSE 仅提供进度，断流不终止生成。生成 POST 响应丢失后查询原会话，不重复发送。只读恢复查询连续失败三次则退出，不做事件重放。

结果先保存，再删除工作区；目录清理失败显示警告，不推翻结果。无法确认 OpenCode 进程退出则保存结果并暂停队列，提供“重试清理并继续”。状态或报告存储失败暂停队列；日志故障只警告。
进度只显示活动说明、耗时及限制，不显示理解百分比或材料计数。

整轮预算 60 分钟，控制请求 30 秒，进程收尾确认 10 秒。停止会取消原生会话并终止进程树，不追加格式修复。
重启后活动检视标为停止，排队任务保留；先检查持久化进程记录，不会自动杀死可能复用的 PID。无法确认退出时暂停，用户关闭旧进程后恢复。

新数据位于 %LOCALAPPDATA%/ReviewX/native-v2，state.json version=2。不读取、不迁移、不删除旧数据。新 attempt 仍归档该 MR 的旧 attempt；移除项目保留本代历史。

## 发布及界面

仅最新可处理 attempt 的 pending Finding 可人工发送；所有评论全局串行。发送与检视队列相互独立。发送未知结果不自动重试，防止重复评论。
原页面的项目导航、MR 卡片、抽屉、历史、日志、键盘、滚动和原始 Markdown 展示保留。增加队列暂停原因、恢复按钮、任务警告。JSON 结构可在详情 API 查看。

报告目录包含 report.md、submission.v1.json、execution.v1.json、raw-output.txt 和可选 repair-output.txt。execution.version=2，记录实际模型、会话、修订、规则快照、工作流版本、耗时、警告；不再保存材料收据。

## 验收

确定性测试覆盖结构与渲染、局部修复、HTTP 断流、原生权限、任务隔离、暂停恢复、清理失败、取消和重启。
真实模型用合成仓库覆盖新增缺陷、条件缺陷、规则违反、跨文件调用及干净对照。需检查实际输出依据；不把脚本通过等同质量保证。
完整检查为 build、lint、typecheck、test、test:coverage、test:e2e，最后串行 test:ai、test:package。记录实际版本、模型、通过/失败/未执行与证据，不外推其他模型或版本。

## 本次改造验收记录（2026-10-03）

环境：Windows 10.0.26300 x64、Node.js 24.14.1、OpenCode 1.18.30；实际模型标识 deepseek/deepseek-flash。验收对应当前未提交工作区，而非仅 HEAD 提交。

- build、lint（含依赖边界）、typecheck、test、test:coverage 均已执行通过。最终覆盖率运行：119 通过，1 跳过；跳过的是默认关闭的 300 秒 HTTP 延迟测试。行覆盖率 63.18%，不包含浏览器和真实模型覆盖。
- 浏览器端 30 项通过，包含部分完成与 PASS 区分、暂停队列恢复后保留意见及原有发布/导航交互。
- 最终源码真实模型验收：test-results/acceptance/2026-10-02T18-50-48-300Z。三处单位换算回归合并为一条意见；四个检视任务加一个独立复核任务，约 77 秒。
- 无缺陷对照：test-results/acceptance/2026-10-02T18-46-08-375Z；仅注释改动得到 complete、零问题。
- 补充规则：test-results/guidance 下 2026-10-02T18-47-20-103Z、18-48-22-909Z、18-49-11-920Z 三组分别验证超过 25 条、恰好 25 条及无该规则的对照，均通过。已人工核对条件触发和调用路径。
- test:package 在最终 test:ai 后串行通过：构建、tarball、隔离安装、随机端口、浏览器失败降级、单实例、重启，以及已安装引擎真实调用。模型证据：test-results/acceptance/2026-10-02T18-53-23-308Z；四个检视任务加一个独立复核任务，约 80 秒。产物：artifacts/reviewx-1.0.0.tgz。

验收期间发现并修复了“说明性限制被宿主强制判为 partial”和“意见路径误带工作区前缀”问题，均有确定性回归测试。结构修复在真实输出中实际触发并成功；有效结果未因前置说明文本被整体丢弃。已人工核对源码与安装包结果的代码位置、缺陷依据、解决方案和固定章节。

这些结果支持新流程可以正常工作、异常隔离和容错符合设计；尚未进行长期生产错误率对照或不同模型/版本兼容矩阵，不能据此承诺零异常或具体稳定性提升百分比。真实 CodeHub 评论发布未在此次合成验收中执行。