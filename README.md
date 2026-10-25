# ReviewX

运行在本机的 CodeHub 辅助检视工具：AI 负责找问题，用户决定什么发出去。

- 手动获取关注项目的开放 MR，选中后发起 AI 检视（全局串行队列，进度实时可见，可停止、可取消排队）
- AI 只读检视：OpenCode 单会话，只放行 `read` / `glob` / `grep` 和 ReviewX 的两个提交工具，越权立即终止
- 每条意见含严重程度、位置、影响分析、解决方案、预防措施，由用户逐条「发送到 CodeHub」或「不发送」
- 发布结果如实显示：已发布 / 发布失败 / 结果未知；未知项核对后标记，失败项可手动重发，从不自动重试
- 报告和处理记录只追加、不覆盖，重启后仍在；重新检视生成新报告，旧报告归档只读
- 自定义检视规则（Markdown 文件），按项目启用，显示近 30 天命中数与采纳率，已发送的意见可沉淀为规则草稿

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| Windows | 目标平台（其他系统可运行，但不在支持范围内） |
| Node.js 22+ | 运行 ReviewX |
| [CodeHub CLI](https://github.com/BlackLotusAL/CodeHubX) | 已登录（`codehub auth login`），终端里能运行 `codehub` |
| Git | 已配置好访问代码仓库的凭据（凭据管理器或 SSH 密钥） |
| OpenCode 1.18+ | 已配置默认模型，终端里能运行 `opencode` |

ReviewX 不接收、不保存任何凭据：CodeHub 凭据由 CLI 保存在 Credential Helper，Git 凭据用本机已有配置，模型认证由 OpenCode 自己负责。

## 安装与启动

```bash
npm install -g .
```

```bash
reviewx
```

启动后终端会打印访问地址（默认 `http://127.0.0.1:17080/`）和当天的诊断日志路径，并用默认浏览器打开页面。关闭浏览器不影响服务和检视；在终端按 Ctrl+C 停止服务。同一台机器只运行一个 ReviewX，再次启动会直接打开已有页面。

## 配置文件

位置：`%APPDATA%\ReviewX\config.json`（首次启动自动生成；也可用 `reviewx --config <路径>` 指定）。只能通过配置文件修改，重启后生效；格式错误时拒绝启动并指出出错项。

| 配置项 | 含义 | 默认值 |
| --- | --- | --- |
| `port` | 端口（只监听 127.0.0.1；被占用时拒绝启动） | `17080` |
| `dataDir` | 数据目录（更改后不自动迁移旧数据） | `%LOCALAPPDATA%\ReviewX` |
| `concurrency` | 并发数：同时执行的 CodeHub CLI 调用上限 | `6` |
| `excludeFileTypes` | 排除文件类型：扩展名（`.png`）或完整文件名（`go.sum`），只匹配文件名 | 锁文件、压缩产物与映射、图片、字体 |
| `outputLanguage` | 意见的输出语言 | `中文` |
| `wrapUpMinutes` | 收尾时间：步骤 6 开始后第几分钟要求 AI 收尾 | `10` |
| `opencodeTimeoutMinutes` | OpenCode 超时：步骤 6 总时长上限 | `13` |
| `codehubCommand` / `opencodeCommand` / `gitCommand` | 命令名、路径或 `["node", "x.js"]` 形式的数组 | `codehub` / `opencode` / `git` |
| `gitProtocol` | 拉取代码用的克隆地址：`https` 或 `ssh` | `https` |

## 数据目录

```
meta.json                         数据格式版本（升级前自动备份到 backups/，保留 3 份）
projects.json                     关注列表（移除的项目保留标记，重新添加后恢复历史）
fetch/<pid>.json                  每个项目最近一次成功获取的 MR
mrs/<pid>/<iid>/attempts.jsonl    检视记录（只追加）
mrs/<pid>/<iid>/reports/*.json    报告（保存后不再修改）
mrs/<pid>/<iid>/records.jsonl     每条意见的决定与发布结果（只追加）
cache/<pid>.git                   代码缓存（部分克隆，可在页面上清除）
tmp/                              检视副本，检视结束即删除
rules/global/*.md                 全局规则
rules/projects/<pid>/*.md         项目规则
logs/YYYY-MM-DD.log               诊断日志（保留 30 天、总量 ≤ 100 MB，已去除凭据）
```

### 规则文件格式

```markdown
---
name: "SQL 拼接"
files: "src/db/**, *.sql"
enabled: true
---
## 检查要点
- 禁止字符串拼接 SQL，一律使用参数化查询

## 反例
## 正例
```

规则列表每次打开或刷新都会重新读取规则文件，检视开始时也会读取，所以用编辑器或 Git 修改后无需重启。格式错误的规则会标为「格式错误」并在检视时跳过（报告中注明）。

## 一次检视的 7 个步骤

1. 读取 MR 信息（`codehub mr view`）
2. 拉取源分支、3. 拉取目标分支（代码缓存里只拉这两个分支，允许非快进更新）
4. 校验 MR 未变化（再次读取 MR 更新时间）
5. 生成变更快照：三点差异、排除文件、导出检视副本、把每个文件的差异写入 `.reviewx-diff/`
6. OpenCode 检视：AI 读完全部差异文件，用 `report_finding` 逐条提交意见，最后调用 `finish_review`
7. 保存报告与意见

排除后没有可检视的文件时跳过步骤 6，结论为「无可检视的变更」。失败时报告页说明影响、原因、失败步骤和下一步；环境级错误（CLI 未登录、Git 认证失败、网络不可用、OpenCode 版本过低）和步骤 6–7 的失败会停止整个队列。

## 开发

```bash
npm test
```

```bash
npm run dev
```

`npm run dev` 会在 `dev/.mock/` 下建一个沙箱：几个本地 Git 仓库、一个模拟的 CodeHub CLI（`dev/mock-codehub.js`）和一份指向它们的配置，然后在 `http://127.0.0.1:17081/` 启动 ReviewX（使用本机真实的 Git 和 OpenCode）。可添加的项目：`101`（review-engine，3 个 MR）、`202`（task-console，获取会失败）、`512`；`999` 模拟项目不存在。加 `--reset` 重建沙箱。模拟 CLI 的状态在 `dev/.mock/state.json`，可以改 `auth: false` 模拟未登录，或设置 `commentResults: ["unknown", "network"]` 模拟发送结果未知和网络失败。

### 代码结构

| 文件 | 内容 |
| --- | --- |
| `bin/reviewx.js` | 启动、单实例、端口检查、Ctrl+C 清理 |
| `src/server.js` | HTTP 接口、SSE 推送、来源校验、CSP |
| `src/app.js` | 关注项目、获取 MR、发送评论、意见决定、规则统计、页面数据 |
| `src/review.js` | 检视队列与 7 个步骤 |
| `src/opencode.js` | OpenCode 会话：只读权限、越权监控、收尾与超时 |
| `src/mcp.js` | 提供 `report_finding` / `finish_review` 的本地 MCP 服务 |
| `src/finding.js` | 意见字段校验、排序和评论模板 |
| `src/git.js` / `src/codehub.js` | Git 与 CodeHub CLI 调用 |
| `src/rules.js` / `src/store.js` / `src/logger.js` / `src/config.js` | 规则、数据目录、诊断日志、配置 |
| `public/` | 网页（按设计稿实现，无第三方依赖） |
