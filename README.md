# ReviewX

运行在 Windows 本机的个人 CodeHub 代码检视工作台。AI 负责发现问题，用户逐条决定是否发布。业务以 [PRD](docs/PRD.md) 为准，界面使用 [DESIGN](docs/DESIGN.md) 的布局和设计令牌。

## 启动

需要 Python 3.11+、Node.js 22+、Git、已登录的 [CodeHub CLI](https://github.com/BlackLotusAL/CodeHubX)，以及已配置默认模型的 **OpenCode 1.18.x**。

```powershell
npm ci
npm run build
python -m reviewx
```

默认在 `http://127.0.0.1:17080` 打开浏览器。关闭浏览器不会停止服务；在终端按 `Ctrl+C` 停止并清理子进程。

需要全局 `reviewx` 命令时，在完成前端构建后安装 Python 包：

```powershell
python -m pip install .
reviewx
```

发布 wheel 时也必须先运行 `npm run build`。前端构建结果位于 `reviewx/web`，会随 Python 包打包，无需运行 Node.js 服务。

初次启动没有示例项目或伪造报告。输入数字 Project ID，通过 CLI 校验后添加关注；点击「获取 MR」，再主动发起检视。启动本身不会读取远端仓库、调用模型或发布评论。

## 配置

配置文件默认是 `%APPDATA%\ReviewX\config.json`，可参考 [reviewx.example.json](reviewx.example.json)。文件不存在时使用默认值。

```powershell
reviewx --config "D:\我的配置\reviewx.json"
reviewx --no-browser
```

网页不提供设置页。修改配置后重启生效；未知配置项、错误类型或不合理的时间和上下文比例会阻止启动。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `port` | `17080` | 固定端口，仅监听 IPv4 回环地址 |
| `data_dir` | `%LOCALAPPDATA%\ReviewX` | 数据目录，更换目录不自动迁移 |
| `concurrency` | `6` | 获取 MR 的全局 CLI 并发上限 |
| `excluded_files` | PRD 默认清单 | 仅匹配文件名或扩展名 |
| `context_limit` | `262144` | 模型上下文 token 上限 |
| `output_language` | `中文` | AI 输出语言 |
| `focus_areas` | 逻辑与状态、边界与错误处理、接口与一致性、测试与体验 | 查找方向 |
| `shard_ratio` | `0.2` | 分片阈值占上下文上限的比例 |
| `search_parallel` / `verify_parallel` | `8` / `4` | 会话并发上限 |
| `search_wrap_seconds` / `verify_wrap_seconds` | `300` / `600` | 相对步骤 6 开始的收尾时间 |
| `opencode_timeout` | `720` | 步骤 6 的总时限 |
| `reading_ratio` / `safety_ratio` | `0.25` / `0.75` | 查阅额度与安全上限 |
| `codehub_command` / `opencode_command` / `git_command` | 相应命令名的单元素数组 | 可选的本机命令路径及固定前置参数 |

上下文预检保守采用每字符 1 token 的估算，包括差异、标题、提交说明和规则。实际会话收尾使用 OpenCode 事件中的 token 计数。不会指定或替换用户的默认模型。

Windows 命令通过参数数组调用，不经过 shell。标准 npm shim 会解析到实际 Node.js 或原生程序；自定义 `.cmd`/`.bat` 包装器应改为配置可执行文件及参数数组。例如：

```json
{
  "codehub_command": ["C:\\Program Files\\nodejs\\node.exe", "D:\\tools\\codehub\\dist\\cli.js"]
}
```

凭据由 CodeHub CLI、Git、OpenCode 各自管理。ReviewX 不接收 CodeHub/Git 密码或 token。CodeHub CLI 的 `AUTH_ERROR` 会提示在终端重新登录。

## 日常流程

- **项目与 MR**：校验项目后关注；手动获取；第一个项目串行完成，后续项目并行；单项目全部详情成功后原子更新。失败保留上次结果，可单独重取。
- **检视**：全局 FIFO 串行队列；同一 MR 互斥；可取消排队、停止运行、重新检视。报告记录版本、实际模型、规则快照和排除文件。
- **报告**：按严重程度、路径、行号排序。仅成功保存的报告进入历史栏。新检视失败、停止或排队中时，旧报告仍可处理。
- **意见**：逐条发送或不发送；批量不发送需要确认；不发送可逐条撤销。发送期间全局互斥。发布失败可手动重发，结果未知必须先核对。没有自动发布或自动重试。
- **规则**：全局及项目规则，支持新建、编辑、复制、启停、删除；显示近 30 天效果。已发布意见可预填为未启用的规则草稿。
- **日志**：按级别、日期和文本查看诊断记录，导出脱敏后的 JSONL。

设计文档中与 PRD 有冲突的两点按 PRD 实现：意见按严重程度排序，不按处理状态重排；已发布意见不可撤销，只有「不发送」决定可以撤销。

## 数据与安全

```text
数据目录/
  reviewx.sqlite3       项目、MR 快照、检视状态、不可变报告、追加式处理事件
  rules/*.md           可直接编辑的规则文件
  logs/YYYY-MM-DD.jsonl
  cache/<project>.git/  无工作区的项目缓存
  tmp/                 检视副本和会话附件，结束后清理
  backups/             数据升级备份
```

SQLite 使用 WAL 与 FULL 同步，报告和处理事件有禁止 UPDATE/DELETE 的触发器。重启时中断检视变为已停止，发送中意见变为结果未知，不恢复执行。数据格式当前为 v1；高于程序版本的数据会拒绝打开。备份支持保留最近三份；未来增加数据版本时必须提供对应迁移，未支持的旧版本不会被猜测性转换。

HTTP 校验 Host、Origin、Referer、Fetch Metadata；写操作必须带页面获取的随机 CSRF token。静态文件仅从已构建前端目录提供，没有本机文件读取 API。所有外部内容通过 React 文本节点渲染；意见中的 Markdown、HTML、链接和图片都不执行、不加载。

OpenCode 使用 `run --pure --format json`，关闭标准输入，禁用自动压缩，默认拒绝工具。会话只获准使用本地 MCP 的受控 `read/glob/grep` 和所属阶段的提交工具；这些查阅工具在服务端统一执行路径、排除文件、二进制和凭据文件限制，避免原生 grep 跨文件搜索绕过读取限制。MCP 独立绑定随机回环端口，以每会话随机 bearer token 认证，并拒绝浏览器 Origin。收尾关闭全部查阅工具。事件流出现非白名单工具时终止整个检视进程树。

检视副本来自固定源提交，不含 `.git`、Git 凭据配置或链接文件。OpenCode 不继承 CodeHub/Git 认证环境变量，不加载项目 OpenCode 配置或外部插件。源文件、日志和报告中的常见凭据字段会被脱敏。

规则文件采用 **TOML 元信息 + Markdown 正文**；文件名是稳定规则 ID：

```markdown
+++
name = "事务一致性"
scope = "global"
enabled = true
files = ["src/db/**", "*.java"]
builtin = false
+++

## 检查要点
检查多次数据写入是否具有一致的事务边界。

## 正例
在一个事务内提交完整业务状态。

## 反例
部分写入成功后吞掉异常。
```

`scope` 也可以是数字 Project ID 字符串。刷新规则页或开始一次检视会重新读取文件；格式错误的规则跳过并在报告注明。规则名称须唯一。

## 开发与验证

前后端开发：

```powershell
python -m reviewx --dev --no-browser
npm run dev
```

开发页面位于 `http://127.0.0.1:5173`，Vite 将 `/api` 转发到 17080。生产运行不用 `--dev`，只允许服务自身来源。

```powershell
npm run build
npm test
npm run test:ui
```

浏览器测试在 Windows 使用已安装的 Edge；其他平台需安装 Playwright Chromium。测试服务使用 17081 和隔离临时数据，CodeHub/AI 使用固定测试适配器，**不会向真实 MR 发评论或消耗模型额度**。测试截图输出到忽略的 `artifacts/`。

模块分工：

- `reviewx/service.py`：应用用例、队列、发布互斥与错误策略。
- `reviewx/git.py`：部分克隆、固定提交、三点差异、完整函数上下文与副本清理。
- `reviewx/opencode.py`：MCP、结构化校验、分片、候选合并、验证、收尾和超时。
- `reviewx/store.py`：不可变报告与追加式处理事件。
- `reviewx/server.py`：本机 HTTP API 与来源校验。
- `src/`：React 页面、抽屉、规则编辑器和设计样式。

当前验证覆盖本机业务、真实 Git 操作、子进程/MCP 协议和浏览器流程。真实 CodeHub 网络鉴权、真实模型行为和「15 分钟内完成」性能目标仍需在安装并登录 CodeHub CLI 后，用实际 MR 验收；不应把固定测试适配器的成功视为远端集成验收。
