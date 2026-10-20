import copy
import threading
import time
from reviewx.store import uid, now
from reviewx.security import AppError


def finding(**changes):
    return {**dict(id=uid(), severity="major", title="空输入未处理", summary="空列表时访问第一项会失败。",
                   location={"path": "src/parser.ts", "start_line": 18, "end_line": 22},
                   impact={"consequence": "任务中断", "scope": "解析入口", "trigger": "输入为空"},
                   solutions=[{"description": "先检查列表长度。", "code": {"language": "ts", "code": "if (!items.length) return [];"} }],
                   prevention=["增加空输入测试"], rule="正确性"), **changes}


def report(pid="101", iid="1", findings=None, **changes):
    return {**dict(id=uid(), project_id=pid, iid=iid, project_name="team/service", mr_title="完善请求处理",
                   mr_updated_at="2026-10-20T10:00:00Z", source_commit="a" * 40, target_commit="b" * 40,
                   model="test/model", created_at=now(), rules=[], invalid_rules=[], excluded=[],
                   conclusion="发现问题", findings=findings if findings is not None else [finding()]), **changes}


def project(pid="101"):
    return dict(id=pid, full_name="team/service" if pid == "101" else "team/api",
                clone_urls={"https": "https://example.test/team/service.git"}, web_url="https://example.test/team/service")


def mr(pid="101", iid="1", **changes):
    return {**dict(iid=iid, project_id=pid, title="完善请求处理", source_branch="feature", target_branch="main",
                   updated_at="2026-10-20T10:00:00Z", web_url=f"https://example.test/team/service/merge_requests/{iid}"), **changes}


class FakeHub:
    def __init__(self):
        self.calls = []
        self.error = None
        self.publish_gate = None
        self.fetch_gate = None
        self.rows = {"101": [mr()], "102": [mr("102")]}
        self.fail_projects = set()

    def project(self, pid):
        self.calls.append(("project", pid))
        return project(pid)

    def list_mrs(self, pid):
        self.calls.append(("list", pid))
        if self.fetch_gate:
            self.fetch_gate.wait(2)
        if pid in self.fail_projects:
            raise AppError("网络不可用", "NETWORK_ERROR", environment=True)
        return self.rows.get(pid, [])

    def mr(self, pid, iid, **kwargs):
        self.calls.append(("mr", pid, iid))
        return next(copy.deepcopy(m) for m in self.rows[pid] if m["iid"] == iid)

    def publish(self, pid, iid, finding, body):
        self.calls.append(("publish", pid, iid, body))
        if self.publish_gate:
            self.publish_gate.wait(2)
        if self.error:
            raise self.error
        return {"comment_id": "991"}


class FakeAI:
    def close(self):
        pass

    def review(self, *args):
        return [], "test/model"


def wait_for(check, seconds=3):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(.01)
    raise AssertionError("condition timed out")
