# ReviewX

ReviewX 是仅面向 Windows 10/11 的本地 CodeHub Merge Request 代码检视工具。它把 open MR 放入一个全局 FIFO 队列，每次只运行一个只读 OpenCode 检视；每条 Finding 只有在用户明确点击“发送到 CodeHub”后，才会写入 CodeHub。

点击一次“开始检视”，后台自动理解改动、核实问题、整理结果；默认只呈现置信度 ≥90 且有变更证据的已复核意见。ReviewX 不会定时发现 MR 或自动发表评论。

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本
- pnpm 11.19（源码开发）
- Git，可在 `PATH` 中找到 `git.exe`
- CodeHub CLI，可在 `PATH` 中找到 `codehub.exe` 或安全的 `codehub.ps1` npm shim
- OpenCode CLI（已验证 1.18.25，需支持 `info.structured`），可在 `PATH` 中找到 `opencode.exe` 或安全的 `opencode.ps1` npm shim，并已配置默认模型及其认证

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

## 使用流程

1. 输入正整数 Project ID；ReviewX 会先调用 CodeHub 验证 Project。
2. 点击“刷新 MR”手动获取各 Project 当前 open MR。
3. 点击“开始检视”或“重新检视”；任务按点击顺序进入全局 FIFO。
4. 运行中显示“理解改动 → 核实问题 → 整理结果”，可随时停止。完成后查看 Finding 的置信度和核实依据；置信度为模型自评分，不代表统计正确率。
5. 在每张 Finding 卡片上直接选择“发送到 CodeHub”或“不发送”；已跳过项可在新 attempt 创建前撤销。

停止活动检视会终止 Windows 子进程树并清理临时工作区；单次检视失败会停止其余排队项。评论发送与检视队列彼此独立，但任一时刻只允许发送一条评论。MR 卡片和详情标题中的 `!IID ↗` 可直接在新标签页打开 CodeHub MR。

未发现合格意见时显示“未发现证据充分的问题”；必要查证未完成时显示“检视未完成”，不生成 PASS。完整报告默认收起，记录固定提交、证据与检视局限。旧意见显示“未评估”，原报告保持不变。

每次 attempt 使用独立的本机 OpenCode 服务、随机端口、临时认证和同一模型会话。一次初检后至少做一次反证复核，最多三轮查证；每轮最多 20 个模型步骤，全程共用 60 分钟。模型可搜索和读取经过凭据检查的 source / merge-base 副本；不允许执行命令、改文件或访问副本外目录。Git 元数据、符号链接、代理指令及插件配置不进入可读取快照，缺失上下文记录为局限。

结果整理单独使用 `StructuredOutput`；DeepSeek V4 仅在此阶段关闭 thinking。只读取原生结构化字段并进行本地 Schema / 证据范围校验，不从对话猜测 JSON。ReviewX 最多纠正一次格式，认证、网络、取消和查证超限直接失败。轮数、工具与模型用量保存在诊断日志。

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
pnpm test:ai:protocol
pnpm test:ai:quality
```

`pnpm test:package` 创建 npm tarball、隔离安装并验收 CLI 生命周期。`test:ai` 使用真实 Git 和默认 OpenCode 模型做多轮检视；`test:ai:protocol` 验证五轮会话与正文原样输出；`test:ai:quality` 对六类样例分别执行旧、新方案各三次（共 36 次），默认固定 `deepseek/deepseek-v4-flash`，可用 `REVIEWX_AI_MODEL=provider/model` 指定同一对照模型。真实测试会产生模型费用，不调用 CodeHub 或创建评论。

测试结果保存在 `test-results/ai/`，包含输入、提交、模型版本、输出、耗时、Token 和可取得的费用。OpenCode 报告的费用不是账单；零值可能表示供应商未提供定价。质量门为新方案反例零误报、正例至少 8/9 命中且不低于旧方案、新方案 18/18 结果通过本地校验。

## 故障排查

- 找不到 CodeHub/Git/OpenCode：确认对应 `.exe` 或 npm `.ps1` shim 已加入当前用户 `PATH`；不支持仅有 `.cmd` 的不安全启动器。
- OpenCode 结果被拒绝：查看诊断中的结构化输出、请求关联或证据范围错误。服务必须支持原生 `StructuredOutput`；DeepSeek V4 的整理阶段需关闭 thinking。原生正文不能替代结构化结果。
- Git 输入被拦截：完整 diff 或源文件快照命中了凭据模式；先移除并轮换仓库内凭据，再重新检视。
- 无法自动打开浏览器：从终端复制 `http://127.0.0.1:<port>` 地址；服务通常仍在运行。
- 页面操作被拒绝或服务进入致命状态：打开左栏“查看当前会话日志”，按 Cause、Impact、Next step 和 Technical details 排查。
- MR 被误判为非开放状态：ReviewX 同时接受 `mr view` 返回的 `open` 和 `opened`；如果仍报错，请在日志中确认 CodeHub 实际返回的 `state` 值。
- 意外退出后：排队中、检视中和停止中的 attempt 会恢复为已停止；中断评论的当前 Finding 会标为 unknown，其他 pending Finding 仍可继续处理，ReviewX 不会自动补发。旧版多条批次中的后续项仍兼容恢复为 not_attempted。

报告与 Finding Markdown 均按不可信输入处理：原始 HTML、危险 scheme、表单和嵌入内容会被丢弃，图片只展示为经过公共 HTTP(S) allowlist 校验的链接，不会自动加载。
