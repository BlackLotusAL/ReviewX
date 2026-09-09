# UI 分支来源与适配

基线：a595cf43148a23720f5a95ea9e04a758fc7ff4dd。分支：codex/ui-only。

| 来源 | 处理 |
| --- | --- |
| 2028590 | 完整 cherry-pick：逐条发送、不发送、撤销与 MR 链接 |
| 6e49d1c | cherry-pick 后适配：Kimi UI、字体、交互和无障碍 |
| 68fddfd | cherry-pick 后适配：预览、日志、Markdown 高亮与耗时 |

排除 5cd3ccd、eeaace7、16416f8、694d622、ba4a955、c115387、6b09266。

UI 页面、样例和测试移除多轮阶段、置信度、核实依据、证据、baseSha 和 limitations 依赖；预览使用基线阶段和源/目标提交。保留逐条处理接口和可选展示时间，未引入 OpenCode 协议、提示词或输出契约变更。

冲突涉及页面/CSS、README、API/验收文档及 E2E、runtime、state-store 测试。解决时保留基线检视行为，将 UI 测试适配到基线数据，保留耗时持久化和决策后不变的断言。

## 验证结果

- `pnpm lint`、`pnpm typecheck`：通过。
- `pnpm test`：45 项单元测试、17 项集成测试通过；补充失败耗时断言后再次运行集成测试通过。
- `REVIEWX_E2E_PRODUCTION=1 pnpm test:e2e`：24 项浏览器测试通过。
- `pnpm build`：生产页面和 CLI 构建通过。
- `pnpm test:package`：tarball、独立安装、本地字体、随机端口、浏览器失败降级与单实例验收通过。
- `git diff --check a595cf4`：通过。OpenCode、Git 准备和 report-store 文件与基线无差异；schemas 相对 2028590 无变化。

构建最初受沙箱父目录读取权限限制，使用正常权限重试后通过。未运行真实模型测试，未发送真实 CodeHub 评论，未推送分支。
