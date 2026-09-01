# ReviewX Windows v1 验收记录

验收日期：2026-09-02（Asia/Hong_Kong）

环境：Windows、Node.js 24.14.1（产品最低要求 22）、pnpm 11.19、Next.js 16.2.9、React 19.2.8、OpenCode 1.18.25。

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
| 旧结果 | PASS | 新 attempt 创建后旧 attempt 归档；pending 变为 archived，published 记录保持 published。 |
| MR 中途变化 | PASS | 第二次 `mr view` 发现 `updated_at` 变化后失败；Reviewer 调用数为零且无报告引用。 |
| PASS | PASS | 空 Findings 保存独立报告并进入 `completed`，无确认入口和评论调用。 |
| Findings | PASS | 全部 Findings 与完整报告持久化后进入 `awaiting_confirmation`，评论调用数仍为零。 |
| 默认选择 | PASS | Playwright 验证全部 checkbox 默认未选，无选择时发布按钮禁用，正文无编辑控件。 |
| 分批发布 | PASS | 第一批只发布选中项，未选项继续 pending；第二批完成后 attempt 才进入 completed。 |
| 发布顺序 | PASS | 即使请求序号为 `[3,1]`，评论仍按 Reviewer 原顺序 1、3 串行创建。 |
| 发布并行 | PASS | 一个评论批次与另一 MR 的 Review 同时处于活动状态；评论最大并发为 1，第二批被全局门禁拒绝。 |
| 无版本校验 | PASS | 发布前后 `mr view` 调用计数不变，旧版本 Finding 可由用户明确发布。 |
| 发布失败 | PASS | 覆盖明确失败和 unknown；已成功、当前失败/未知、后续 not_attempted 均逐条保留，attempt 封存且不可重试。 |
| 发布与队列隔离 | PASS | 评论失败期间创建的独立 review 正常完成，发布失败不清空 review 队列。 |
| 项目移除 | PASS | 活动检视停止、同 Project 排队项取消、其他 Project 继续；发布中的 Project 移除被拒绝，历史仍可读取。 |
| 报告 | PASS | 报告使用 `wx` 创建且不可覆盖；发布/归档不改原文；状态引用与 realpath 双重目录约束拒绝 traversal。 |
| Markdown 安全 | PASS | Playwright 验证 script/form/iframe/object/embed/img 不进入 DOM，本机/私网/file URL 被拦截，公共图片仅显示为链接。 |
| 日志 | PASS | 每次启动独立日志；本地毫秒时间、英文自然语言、ANSI 清理、控制字符转义、Cause/Impact/Next step/Technical details 均有测试。 |
| 凭据 | PASS | 环境凭据过滤、完整 bundle/元数据扫描、私钥整块脱敏、无凭据 HTTPS URL、PowerShell JSON argv 信封均有单元或集成覆盖。 |

## 接口与恢复补充验收

- mutation 仅接受精确 loopback Host、同源 Origin 与 JSON；实际流式正文超过 1 MiB 时拒绝。
- CodeHub 四组 argv 由真实 PowerShell shim 捕获并逐项比对；评论 body 是单个 argv，换行为真实 CRLF。
- Git 使用真实临时仓库验证两次固定 SHA、完整 `target...source` binary diff、路径排序、64 KiB/256 KiB 快照边界、UTF-8/普通文件限制及凭据阻断。
- OpenCode 假 CLI 验证仅调用一次、prompt 走 stdin、bundle 走 `--file`、工具全部 deny、插件关闭且 CodeHub/Git/GitHub/SSH 环境变量为空。
- 发布中断恢复验证当前 Finding 为 unknown、后续选中项为 not_attempted、attempt 为 publish_failed，且不补发。
- 运行期日志写入失败验证进入 fatal 状态，拒绝新刷新/检视/发布，但仍允许停止与移除。

## 质量门

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS：14 个单元测试、15 个集成测试 |
| `pnpm test:e2e` | PASS：1 个完整浏览器业务流程 |
| `pnpm build` | PASS：Next.js 生产构建与 tsup CLI 构建，无警告 |
| `pnpm test:package` | PASS：npm tarball 隔离安装与真实 CLI 生命周期 |
| `pnpm test:ai` | PASS：一次真实 Git + OpenCode 调用返回 1 条有效权限 Finding |

CodeHub 在本机未安装，因此所有 CodeHub 验收使用无网络、无真实评论的可控 CLI shim；真实 AI 烟测未调用 CodeHub。
