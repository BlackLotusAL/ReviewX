# ReviewX

ReviewX 是仅面向 Windows 10/11 的本地 CodeHub Merge Request 代码检视工具。它把 open MR 放入一个全局 FIFO 队列，每次只运行一个只读 OpenCode 检视；Finding 只有在用户明确勾选并点击发布后，才会逐条写入 CodeHub。

ReviewX 不会定时刷新、自动检视、自动评论，也不提供远程访问、数据库或发布重试。

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本
- pnpm 11.19（源码开发）
- Git，可在 `PATH` 中找到 `git.exe`
- CodeHub CLI，可在 `PATH` 中找到 `codehub.exe` 或安全的 `codehub.ps1` npm shim
- OpenCode CLI，可在 `PATH` 中找到 `opencode.exe` 或安全的 `opencode.ps1` npm shim，并已配置默认模型及其认证

CodeHub 必须返回不含用户信息、查询参数或片段的 HTTPS clone URL。ReviewX 不接收或保存 CodeHub、Git、SSH、GitHub 或模型供应商凭据。

## 安装与启动

从发布 tarball 安装：

```powershell
npm install --global .\reviewx-1.0.0.tgz
reviewx
```

唯一启动入口是无参数 `reviewx`。启动成功后，终端会显示随机 loopback 地址和本次日志路径，并尝试用 Windows 默认浏览器打开页面。浏览器打开失败时服务仍会继续运行，可手动访问终端中的地址。

如果已有实例运行，第二次执行只会提示现有地址，不会再创建服务。旧命令或任何额外参数都会被拒绝；`reviewx --help` 只显示无参数用法。

服务只监听 `127.0.0.1`，不启用 CORS。所有状态变更接口同时校验精确 Host、同源 Origin 和 JSON Content-Type。

## 使用流程

1. 输入正整数 Project ID；ReviewX 会先调用 CodeHub 验证 Project。
2. 点击“刷新 MR”手动获取各 Project 当前 open MR。
3. 点击“开始检视”或“重新检视”；任务按点击顺序进入全局 FIFO。
4. 查看独立 Markdown 报告。PASS 直接完成；有 Findings 时进入待确认。
5. 勾选本批需要发布的 Findings，再点击“发布选中意见”。未选项继续待确认。

停止活动检视会终止 Windows 子进程树并清理临时工作区；单次检视失败会停止其余排队项。发布批次与检视队列彼此独立，但任一时刻只允许一个评论批次。

## 本地数据

永久数据位于 `%LOCALAPPDATA%\ReviewX`：

- `state.json`：版本化原子状态文件
- `reports\<attempt-id>\report.md`：每次成功 attempt 的不可变报告
- `logs\reviewx-*.log`：每次启动独立保存的英文诊断日志
- `workspaces\`：检视期间使用、完成后清理的临时 Git 副本

移除 Project 只移除登记项，不删除快照、attempt、报告、发布记录或日志；重新添加后历史会恢复可见。不要手工编辑运行中实例的状态文件。

## 源码开发

```powershell
pnpm install
pnpm dev
```

`pnpm dev` 只用于开发页面；正式入口仍是构建后的无参数 `reviewx`。质量检查命令：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm test:package
pnpm test:ai
```

`pnpm test:package` 会创建 npm tarball、安装到独立临时目录并实际验收随机端口、浏览器失败降级和单实例行为。`pnpm test:ai` 会创建临时真实 Git 仓库，并调用一次当前 OpenCode 默认模型；它会消耗真实模型额度，可能产生费用，但不会调用真实 CodeHub 或创建评论。

## 故障排查

- 找不到 CodeHub/Git/OpenCode：确认对应 `.exe` 或 npm `.ps1` shim 已加入当前用户 `PATH`；不支持仅有 `.cmd` 的不安全启动器。
- OpenCode 结果被拒绝：默认模型最终正文必须是一个 JSON 对象，包含 `findings` 数组，不能带代码围栏或说明文字。
- Git 输入被拦截：完整 diff 或源文件快照命中了凭据模式；先移除并轮换仓库内凭据，再重新检视。
- 无法自动打开浏览器：从终端复制 `http://127.0.0.1:<port>` 地址；服务通常仍在运行。
- 页面操作被拒绝或服务进入致命状态：打开左栏“查看当前会话日志”，按 Cause、Impact、Next step 和 Technical details 排查。
- 意外退出后：排队中、检视中和停止中的 attempt 会恢复为已停止；中断评论的当前 Finding 会标为 unknown，后续选中项标为 not_attempted，ReviewX 不会自动补发。

报告与 Finding Markdown 均按不可信输入处理：原始 HTML、危险 scheme、表单和嵌入内容会被丢弃，图片只展示为经过公共 HTTP(S) allowlist 校验的链接，不会自动加载。
