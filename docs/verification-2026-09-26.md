# 长时检视与部分结果验收记录

日期：2026-09-26。基线：`c69d0b4`，本次工作区改动尚未提交。
环境：Windows 10.0.26200 x64、Node.js v24.14.1、OpenCode 1.18.30。

| 验证 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过，最终改动后复验 |
| `pnpm lint` | 通过，包含导入边界与循环检查 |
| `pnpm test` | 20 个测试文件通过，163 项通过；五分钟测试默认跳过，单独执行 |
| 最后补充的定向回归 | HTTP 接入 15 项通过；运行时与传输 23 项通过；结果接收与 HTTP 接入 61 项通过。这些数量有重叠，不相加 |
| 长响应头回归 | 实际等待 305 秒响应头成功；该次传输测试 9 项通过，总耗时约 306 秒 |
| `pnpm build` | Next.js 与 tsup 构建通过；Turbopack 提示动态文件追踪范围警告，未阻断构建或安装验收 |
| `pnpm test:e2e` | 生产构建模式，29 项通过，包含有/无 Finding 的部分结果展示 |
| `pnpm test:package` | 打包、隔离安装、启动、第二实例、重启及安装包真实模型验收通过 |
| `pnpm test:ai` | 最终源码真实验收通过，完整结果、3 条 Finding |

## 真实模型证据

- 源码：`test-results/acceptance/2026-09-26T14-45-59-546Z/`。协议 `opencode-http/1.18.30`，112880 ms，39 次工具调用；执行记录包含 3 次 Finding 丢弃和 4 次候选替换，最终 `completion=complete`，3 条有效 Finding。
- 安装包：`test-results/acceptance/2026-09-26T14-44-39-119Z/`。43482 ms，26 次工具调用，`completion=complete`，3 条有效 Finding。
- 安装包：`artifacts/reviewx-1.0.0.tgz`，SHA-256 为 `b36bfe09c3424f6e7345d7dfef1e50163848005fcfd0ef103d9cdf63b2997081`；资源校验见 `artifacts/package-verification.json`。
- 正文与合成样例交叉核对：结果指出 C++、PyQt5、PySide2 三处秒到毫秒换算被删除，引用了变更自身及调用方。该核对仅适用于本次样例，不代表任意 MR 的意见质量保证。

## 验收边界与修复

- 超过五分钟的是本地 HTTP 延迟响应回归，不是真实模型持续运行五分钟；未进行 60 分钟真实检视压力测试。其他 OpenCode 版本由模拟健康检查覆盖，真实验收版本为 1.18.30。
- 首次安装包验收与浏览器测试同时运行，Playwright 默认清理 `test-results` 导致 AI 证据写入失败；已将浏览器输出隔离到 `test-results/e2e`，受影响的安装包及源码验收均已重跑通过。
- 新代码兼容旧 v1 数据；含 `result=partial` 的新状态不能直接交给不支持该枚举的旧程序读取。
- 用户提供的 `ReviewX 迭代文档.md` 保持原样；当前行为以 README、PRD 与 API 文档为准。
