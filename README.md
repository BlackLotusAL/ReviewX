# ReviewX

ReviewX 是仅面向 Windows 10/11 的本地 CodeHub Merge Request 代码检视工具。它把 open MR 放入一个全局 FIFO 队列，每次只运行一个只读 OpenCode 检视；每条 Finding 只有在用户明确点击“发送到 CodeHub”后，才会写入 CodeHub。

ReviewX 不会定时刷新、自动检视、自动评论，也不提供远程访问、数据库或发布重试。

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本
- pnpm 11.19（源码开发）
- Git，可在 `PATH` 中找到 `git.exe`
- CodeHub CLI，可在 `PATH` 中找到 `codehub.exe` 或安全的 `codehub.ps1` npm shim
- OpenCode CLI，可在 `PATH` 中找到 `opencode.exe` 或安全的 `opencode.ps1` npm shim，并已配置默认模型及其认证

CodeHub 必须返回不含用户信息、查询参数或片段的 HTTPS clone URL，并在 `mr view` JSON 中返回不含凭据的 HTTPS `web_url`。缺少该字段表示 CLI 版本不兼容，刷新会失败并提示升级。ReviewX 不接收或保存 CodeHub、Git、SSH、GitHub 或模型供应商凭据。

## 安装与启动

从发布 tarball 安装：

```powershell
npm install --global .\reviewx-1.0.0.tgz
reviewx
```

唯一启动入口是无参数 `reviewx`。启动成功后，终端会显示随机 loopback 地址和本次日志路径，并尝试用 Windows 默认浏览器打开页面。浏览器打开失败时服务仍会继续运行，可手动访问终端中的地址。

如果已有实例运行，第二次执行只会提示现有地址，不会再创建服务。旧命令或任何额外参数都会被拒绝；`reviewx --help` 只显示无参数用法。

服务只监听 `127.0.0.1`，不启用 CORS。所有状态变更接口同时校验精确 Host、同源 Origin 和 JSON Content-Type。

网页会每 1 秒调用一次 `GET /api/state` 同步本地队列和任务进度。该请求只读取 ReviewX 本地状态，不会刷新 CodeHub MR，也不会触发 Git、OpenCode 或评论操作。全部接口与请求/响应契约见 [Web API 接口说明](docs/API.md)。

左栏“查看当前会话日志”在新标签页打开 `/logs`，按 INFO / ERROR 着色并保留完整诊断文本。页面可见时每 2 秒自动读取当前会话日志，翻阅历史内容时保持位置，位于底部时跟随新增记录；原始纯文本仍可通过 `GET /api/logs/current` 读取。

## 使用流程

1. 输入正整数 Project ID；ReviewX 会先调用 CodeHub 验证 Project。
2. 点击“刷新 MR”手动获取各 Project 当前 open MR。
3. 点击“开始检视”或“重新检视”；任务按点击顺序进入全局 FIFO。
4. 按需展开“完整报告”；报告首次展开时加载，收起后保留缓存。PASS 直接完成；有 Findings 时进入待处理。
5. 在每张 Finding 卡片上直接选择“发送到 CodeHub”或“不发送”；已跳过项可在新 attempt 创建前撤销。

详情抽屉优先展示 Findings，完整报告位于其后并默认收起。发送或跳过后，问题全文与位置保持不变。可用键盘打开 MR、通过方向键切换检视历史，用 Escape 关闭详情并返回原入口；页面遵循系统的“减少动态效果”设置。

Finding 头部统一为浅灰色，严重等级气泡按 Fatal、Major、Minor、Suggestion 使用红、橙、黄、蓝色区分，处理状态和操作按钮统一放在头部，不再显示底部操作区；版本与检视标识合入两列概览并始终显示。正文和报告中标注了支持语言的代码块使用本地语法高亮，未标注及未知语言保留纯文本。展示样式不会改变发送到 CodeHub 的正文。

停止活动检视会终止 Windows 子进程树并清理临时工作区；单次检视失败会停止其余排队项。评论发送与检视队列彼此独立，但任一时刻只允许发送一条评论。MR 卡片和详情标题中的 `!IID ↗` 可直接在新标签页打开 CodeHub MR。

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

`/preview` 提供 MR 样式预览：2 个虚拟项目、14 条固定样例，覆盖全部 11 类状态、三种检视阶段，以及有问题和无问题的完成结果。它与主页共用卡片、详情抽屉和 CSS；详情、历史切换和完整报告可正常浏览，数据操作按钮不提交请求，示例 CodeHub 链接不跳转。数据仅保存在内存，刷新或重新打开后样例与排序不变；日志入口仍查看当前本地会话。

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
- 页面操作被拒绝或服务进入致命状态：查看页面中的“原因、影响、下一步”和折叠的“技术详情”，或打开左栏“查看当前会话日志”排查。
- MR 被误判为非开放状态：ReviewX 同时接受 `mr view` 返回的 `open` 和 `opened`；如果仍报错，请在日志中确认 CodeHub 实际返回的 `state` 值。
- 意外退出后：排队中、检视中和停止中的 attempt 会恢复为已停止；中断评论的当前 Finding 会标为 unknown，其他 pending Finding 仍可继续处理，ReviewX 不会自动补发。旧版多条批次中的后续项仍兼容恢复为 not_attempted。

报告与 Finding Markdown 均按不可信输入处理：原始 HTML、危险 scheme、表单和嵌入内容会被丢弃，图片只展示为经过公共 HTTP(S) allowlist 校验的链接，不会自动加载。
