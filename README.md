# ReviewX

ReviewX 是一个可私有化部署、由命令接入的 Merge Request 自动检视 CLI。它持续扫描已登记的 CodeHub 仓库，以只读 OpenCode 专家分析 MR 的最终整体净变化，并在确认 MR 未变化后最多发布一条最高价值问题评论。

## 环境要求

- Node.js 22 或更高版本
- Git，以及目标仓库所需的 SSH 或 Git Credential 配置
- 已安装并登录的 `codehub` CLI
- 已安装、完成模型认证的 `opencode` CLI

CodeHub 凭据只由 CodeHub CLI 的 Credential Helper 管理。ReviewX 不将其放入 Agent 输入；Agent 也没有执行 `codehub`、访问网络、修改代码或运行项目脚本的权限。

## 安装与构建

```bash
pnpm install
pnpm build
npm install --global ./reviewx-0.1.0.tgz
```

开发期间可通过 `node dist/cli.js` 使用构建后的命令。`pnpm pack` 可生成用于全局安装的 tarball。

## 使用

登记 CodeHub Project ID：

```bash
reviewx repo add 123456
reviewx repo add 123456 --state /srv/reviewx/state.json
```

启动前台扫描进程：

```bash
reviewx run
reviewx run --interval 10m --agent-timeout 20m --max-consecutive-failures 3
reviewx run --interval 2h
reviewx run --interval 1d
reviewx run --state /srv/reviewx/state.json --log /var/log/reviewx.log
```

`--interval` 只接受正整数加分钟 `m`、小时 `h` 或天 `d`；`--agent-timeout` 接受正整数加 `ms`、`s` 或 `m`。自定义 `--state` 时，其父目录即 runtime 根目录；未指定 `--log` 时，日志也写入该目录。自定义日志路径必须使用 `.log` 后缀（大小写不敏感）。

## Runtime

```text
runtime/
├── state.json
├── state.lock
├── reviewx.run.lock
├── reviewx.log
├── repos/<repo-id>/
├── worktrees/<repo-id>/<mr-iid>/
├── runs/<run-id>/
└── agent-output/<run-id>/
    ├── review.md
    └── <sequence>-<agent>/
        ├── inputs/
        ├── input-manifest.json
        ├── report.md
        └── metadata.json
```

`state.json` 只保存仓库、MR 的 `last_processed_updated_at` 和历史评论 Markdown；旧版问题摘要仍可直接读取。每次 Agent 都是独立进程和会话；服务重启不会恢复中间阶段，未完成的 MR 会在后续扫描从头运行。

三个专家各自生成自由 Markdown 报告，Judge 读取这些报告后输出一个独立行的隐藏 `reviewx-decision` JSON 控制头。Judge verdict 固定为 `PASS`、`DUPLICATE` 或 `NEW`；前两者的 canonical 产物只保留控制头，`NEW` 的正文会原样发送到 CodeHub。ReviewX 忽略控制头前的临时模型旁白，且不对 `NEW` 正文做字段级解析。

每次 Agent 调用的原始 stdout/stderr、完整 Markdown、可重放输入、附件清单和元数据都会永久保存在 `agent-output/`。元数据同时汇总启动、步骤、工具和 token/cache 指标。Judge 首次控制头无效时只重试一次，并分别保留两个 attempt。产生新检视意见时，发送给 CodeHub 的 Markdown 原文同时保存为对应 `<run-id>/review.md`。其中可能包含未脱敏的源码和模型分析；请限制目录权限并自行清理历史产物。

日志同时写入 stdout 和文本 `.log` 文件，每行使用 `[YYYY-MM-DD HH:mm:ss.SSS] [LEVEL] [event] 英文详情`，时间取系统本地墙钟时间且不附带时区后缀。四个 Agent 默认实时记录进程就绪、模型步骤、脱敏工具动作、分步耗时、token 和汇总；连续 60 秒没有 OpenCode 事件时写入 `agent_waiting` 心跳。每个 Review Run 内部使用完整 UUID，日志只显示去掉连字符后的前 8 位短引用；Judge 进度额外显示 attempt，终态 `result` 为 `pass`、`duplicate_of`、`new`、`publication_unknown`、`updated`、`closed` 或 `failed`。

```text
[2026-08-15 18:20:30.123] [INFO] [agent_started] Agent design-reviewer started for review run 550e8400 on repository 123, MR 45.
[2026-08-15 18:20:31.123] [INFO] [agent_step_started] Agent design-reviewer, step 1 for review run 550e8400 on repository 123, MR 45 started.
[2026-08-15 18:20:33.123] [INFO] [agent_tool_finished] Agent design-reviewer, step 1 for review run 550e8400 on repository 123, MR 45 finished tool read (path=src/service.ts) with status completed in 12ms.
```

运行日志记录扫描、worktree、commit、Agent、评论发布、状态保存和清理等关键阶段及耗时。Agent 动作最多 300 字符，只包含脱敏命令、搜索模式和 worktree 相对路径；日志不记录工具输出、源码、提示词、Agent 原始文本或评论正文。完整 Agent 产物只保存在访问受限的 `agent-output/`。

## 可靠性与故障恢复

- `reviewx.run.lock` 保证单机只有一个扫描进程；死亡 PID 的遗留锁会自动清理。
- 状态在锁内重新读取并以同目录临时文件原子替换；损坏状态不会被覆盖。
- Judge 返回 `PASS`、`DUPLICATE`，以及 `NEW` 成功或发布结果未知时会推进游标；仅当 CodeHub 返回严格更新的 `updated_at` 时才再次检视，等价时间格式或暂时回退的列表数据会被忽略。
- 连续 3 轮扫描存在错误后服务会终止并返回失败；可用 `--max-consecutive-failures` 调整阈值，无错误的一轮会重置计数。失败、MR 更新或关闭不会推进游标。
- 已确认评论和结果未知的评论都会进入语义去重历史。
- worktree 与 run 输入目录在成功、失败和信号中断后清理；仓库缓存保留供后续 fetch。

## 开发与验收

```bash
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm pack:check
pnpm test:smoke
pnpm simulate:review
pnpm simulate:judge
```

自动化测试使用真实本地 Git 仓库和可编程伪 CodeHub/OpenCode CLI，不需要真实凭据。真实冒烟测试通过 `codehub --help` 探测 CLI，并检查 `auth status` 的 `configured` 状态；只有在 `codehub` 可用、已登录且设置 `REVIEWX_SMOKE_REPO_ID` 时继续执行读取类命令，绝不发布评论。

`pnpm simulate:review` 创建本地 Git remote 和模拟 MR，使用真实 OpenCode 依次运行三个 Reviewer 与 Judge，但 CodeHub 调用全部由本地模拟器接收，不会发布外部评论。默认模型为 `deepseek/deepseek-chat`，可通过 `REVIEWX_SIMULATION_MODEL` 覆盖；产物保存在 `runtime/simulations/`。

`pnpm simulate:judge` 不创建 CodeHub 客户端，只使用本地 Git fixture 和真实 OpenCode，依次验证 Judge 的 `PASS`、`NEW`、`DUPLICATE` 三条路径；产物保存在 `runtime/judge-simulations/`。

## 首版边界

首版不包含 Web UI、Webhook、数据库、队列、多实例协调、inline 评论、知识库、报告、逐 commit 检视或阶段恢复。完整规范见 [产品需求](docs/product-requirements.md) 与 [技术架构](docs/technical-architecture.md)。
