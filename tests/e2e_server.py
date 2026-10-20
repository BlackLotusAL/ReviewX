"""Browser test fixture only. Never used by the production entry point."""
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reviewx.config import load_config
from reviewx.server import Server
from reviewx.service import Service
from reviewx.store import uid, now
from helpers import FakeHub, FakeAI, finding, report, mr, project

root = Path(__file__).resolve().parents[1] / ".reviewx-tests"
root.mkdir(exist_ok=True)
temp = tempfile.TemporaryDirectory(dir=root)
hub = FakeHub()
service = Service(load_config(overrides={"data_dir": temp.name, "port": 17081}), hub, FakeAI())
service.store.follow(project())
rows = [
    mr(iid="404", title="完善检视报告的读取校验与错误处理"),
    mr(iid="402", title="为检视队列增加取消信号，确保停止后清理临时工作区"),
    mr(iid="406", title="优化代码快照的生成流程"),
    mr(iid="409", title="补充请求参数的边界校验"),
    mr(iid="410", title="更新项目文档与静态资源"),
]
hub.rows["101"] = rows
service.store.replace_mrs("101", rows)
for iid in ("404", "410"):
    attempt = dict(id=uid(), project_id="101", iid=iid, status="completed", step=7, message="检视完成", steps=[], created_at=now(), ended_at=now())
    service.store.attempt(attempt)
    if iid == "404":
        old = report(iid=iid, findings=[finding(title="历史意见")])
        service.store.save_report(old, attempt)
        findings = [
            finding(severity="fatal", title="报告读取缺少项目范围校验", summary="报告读取接口未校验资源归属，跨项目请求可能读取其他项目报告。",
                    related_code={"code": 'export async function readReport(id: string) {\n  const report = await store.get(id);\n  return report.body;\n}', "language": "typescript"}),
            finding(title="空配置会中断后续任务", summary='<script>window.bad = 1</script>\n![test](https://evil.example/tracker.png)'),
            finding(severity="minor", title="错误日志缺少调用上下文"),
            finding(severity="suggestion", title="补充解析器的空输入测试"),
        ]
        current = report(iid=iid, findings=findings, rules=service.rules.list()[0])
        service.store.save_report(current, attempt)
        service.store.event(current["id"], findings[2]["id"], "unknown", decision="send", message="发送中断，无法确认结果")
        service.store.event(current["id"], findings[3]["id"], "dismissed", decision="dismiss")
    else:
        service.store.save_report(report(iid=iid, findings=[], conclusion="无可检视的变更"), attempt)
attempt = dict(id=uid(), project_id="101", iid="406", status="failed", step=6, message="OpenCode 检视未完成，未生成报告",
               steps=[dict(number=i, seconds=1.2) for i in range(1, 6)], created_at=now(), started_at=now(), ended_at=now(), queue_stopped=True)
service.store.attempt(attempt)
service.log.log("ERROR", "OpenCode 检视未完成", project_id="101", iid="406", step=6)
service.log.log("WARN", "发送结果未知，请到 CodeHub 核对", project_id="101", iid="404")
server = Server(service)
print("Test fixture at http://127.0.0.1:17081", flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    service.close()
    service.store.db.close()
    temp.cleanup()
