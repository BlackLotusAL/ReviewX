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
reviewx run --interval 10m --agent-timeout 20m
reviewx run --state /srv/reviewx/state.json --log /var/log/reviewx.jsonl
```

时长只接受正整数加 `ms`、`s` 或 `m`。自定义 `--state` 时，其父目录即 runtime 根目录；未指定 `--log` 时，日志也写入该目录。

## Runtime

```text
runtime/
├── state.json
├── state.lock
├── reviewx.run.lock
├── reviewx.jsonl
├── repos/<repo-id>/
├── worktrees/<repo-id>/<mr-iid>/
└── runs/<run-id>/
```

`state.json` 只保存仓库、MR 的 `last_processed_updated_at` 和历史问题摘要。每次 Agent 都是独立进程和会话；服务重启不会恢复中间阶段，未完成的 MR 会在后续扫描从头运行。

日志同时写入 stdout 和 JSONL 文件。每个 Review Run 使用稳定 `run_id`，终态 `result` 为 `pass`、`duplicate_of`、`new`、`publication_unknown`、`updated`、`closed` 或 `failed`。

## 可靠性与故障恢复

- `reviewx.run.lock` 保证单机只有一个扫描进程；死亡 PID 的遗留锁会自动清理。
- 状态在锁内重新读取并以同目录临时文件原子替换；损坏状态不会被覆盖。
- `pass`、`duplicate_of` 和成功/未知发布会推进游标；失败、MR 更新或关闭不会推进。
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
```

自动化测试使用真实本地 Git 仓库和可编程伪 CodeHub/OpenCode CLI，不需要真实凭据。真实冒烟测试通过 `codehub --help` 探测 CLI，并检查 `auth status` 的 `configured` 状态；只有在 `codehub` 可用、已登录且设置 `REVIEWX_SMOKE_REPO_ID` 时继续执行读取类命令，绝不发布评论。

## 首版边界

首版不包含 Web UI、Webhook、数据库、队列、多实例协调、inline 评论、知识库、报告、逐 commit 检视或阶段恢复。完整规范见 [产品需求](docs/product-requirements.md) 与 [技术架构](docs/technical-architecture.md)。
