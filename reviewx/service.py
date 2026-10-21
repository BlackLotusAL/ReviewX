import json
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from .diagnostics import Diagnostics
from .findings import comment_body
from .git import Git
from .opencode import OpenCode, METHOD
from .processes import Processes, CodeHub
from .rules import Rules
from .security import AppError, positive_id, redact, web_url
from .store import Store, dump, now, uid

STEPS = ["读取 MR 信息", "拉取源分支", "拉取目标分支", "校验 MR 未变化", "生成变更快照", "OpenCode 检视", "保存报告与意见"]
ACTIVE = ("queued", "running", "stopping")


class Service:
    def __init__(self, config, hub=None, ai=None):
        self.config = config
        self.store = Store(config["data_dir"])
        self.log = Diagnostics(self.store.root)
        self.rules = Rules(self.store)
        self.processes = Processes()
        self.hub = hub or CodeHub(config, self.processes)
        self.git = Git(config, self.processes, self.store.root)
        self.ai = ai or OpenCode(config, self.processes, self.log)
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.publish_lock = threading.Lock()
        self.fetch_semaphore = threading.Semaphore(config["concurrency"])
        self.queue, self.cancellations, self.removing = [], {}, set()
        self.closed, self.fetching, self.sending = False, False, None
        self.fetch_progress = dict(total=0, done=0, failed=0)
        self.threads = []
        self.store.recover()
        for path in (self.store.root / "tmp").iterdir():
            self.git.clean(path)
        self.worker = threading.Thread(target=self._worker, daemon=True)
        self.worker.start()
        self.log.log("INFO", "ReviewX 已启动")

    def background(self, target):
        thread = threading.Thread(target=target, daemon=True)
        self.threads.append(thread)
        thread.start()

    def add_project(self, value):
        pid = positive_id(value)
        with self.lock:
            prior = self.store.project(pid)
            if prior:
                raise AppError(f"该项目已在关注列表中：{prior['full_name']}（{pid}）", "DUPLICATE", 409)
        data = self.hub.project(pid)
        # Only persist documented fields, never raw API envelopes or credentials.
        project = redact(dict(id=pid, full_name=data["full_name"], clone_urls=data.get("clone_urls", {}),
                              web_url=web_url(data.get("web_url")), default_branch=data.get("default_branch")))
        # Reject credential-bearing clone URLs before they can enter storage.
        self.git.clone_url({**project, "clone_urls": data.get("clone_urls")})
        with self.lock:
            restored = self.store.follow(project)
        self.log.log("INFO", "添加关注项目", project_id=pid)
        return {"restored": restored, "project": project}

    def normalize_mr(self, pid, data):
        if not isinstance(data, dict):
            raise AppError("MR 详情格式无效", "CLI_ERROR")
        iid = positive_id(data.get("iid", ""))
        for key in ("title", "source_branch", "target_branch", "updated_at"):
            if not isinstance(data.get(key), str) or not data[key]:
                raise AppError(f"MR !{iid} 缺少 {key}", "CLI_ERROR")
        return redact({**{key: data.get(key) for key in ("title", "source_branch", "target_branch", "updated_at", "author", "is_draft")},
                       "iid": iid, "project_id": pid, "web_url": web_url(data.get("web_url"))})

    def fetch(self, pid=None):
        with self.lock:
            if self.fetching:
                raise AppError("正在获取 MR，请稍候", "BUSY", 409)
            projects = [p for p in self.store.projects() if pid is None or p["id"] == pid]
            if not projects:
                raise AppError("请先添加关注项目")
            self.fetching = True
            self.fetch_progress = dict(total=len(projects), done=0, failed=0)
        def fetch_one(project):
            project_id = project["id"]
            try:
                self.store.write("UPDATE projects SET fetch_status='fetching',error=NULL WHERE id=?", (project_id,))
                with self.fetch_semaphore:
                    mrs = self.hub.list_mrs(project_id)
                if not isinstance(mrs, list):
                    raise AppError("MR 列表格式无效", "CLI_ERROR")
                normalized = []
                for mr in mrs:
                    with self.fetch_semaphore:
                        detail = self.hub.mr(project_id, positive_id(mr.get("iid", "")))
                    normalized.append(self.normalize_mr(project_id, detail))
                with self.lock:
                    if self.store.project(project_id):
                        self.store.replace_mrs(project_id, normalized)
                self.log.log("INFO", "项目 MR 已更新", project_id=project_id, count=len(normalized))
            except Exception as exc:
                message = str(exc) if isinstance(exc, AppError) else "获取 MR 失败，请查看环境配置"
                self.store.write("UPDATE projects SET fetch_status='failed',error=? WHERE id=?", (message, project_id))
                with self.lock:
                    self.fetch_progress["failed"] += 1
                self.log.log("ERROR", message, project_id=project_id)
            finally:
                with self.lock:
                    self.fetch_progress["done"] += 1
        def fetch_all():
            try:
                fetch_one(projects[0])
                with ThreadPoolExecutor(max_workers=self.config["concurrency"]) as pool:
                    list(pool.map(fetch_one, projects[1:]))
            finally:
                with self.lock:
                    self.fetching = False
        self.background(fetch_all)

    def snapshot(self):
        with self.lock:
            attempts = self.store.attempts()
            projects = self.store.projects()
            for project in projects:
                project.pop("clone_urls", None)
                mrs = []
                for row in self.store.rows("SELECT data FROM mrs WHERE project_id=? AND visible=1 ORDER BY rowid", (project["id"],)):
                    mr = json.loads(row["data"])
                    history = self.store.reports(project["id"], mr["iid"])
                    report = self.store.decorate(history[0]) if history else None
                    runs = [a for a in attempts if a["project_id"] == project["id"] and a["iid"] == mr["iid"]]
                    mr["attempt"] = runs[-1] if runs else None
                    mr["report_id"] = report["id"] if report else None
                    mr["conclusion"] = report["conclusion"] if report else None
                    mr["pending"] = sum(f["handling"]["state"] == "pending" for f in report["findings"]) if report else 0
                    mr["check"] = sum(f["handling"]["state"] in ("failed", "unknown") for f in report["findings"]) if report else 0
                    mr["stale"] = bool(report and report["mr_updated_at"] != mr["updated_at"])
                    mr["report_at"] = report["created_at"] if report else None
                    mrs.append(mr)
                project["mrs"] = mrs
            return dict(projects=projects, queue=[a for a in attempts if a["status"] in ACTIVE],
                        fetching=self.fetching, fetch_progress=self.fetch_progress.copy(),
                        sending=self.sending, steps=STEPS, timeout=self.config["opencode_timeout"])

    def detail(self, pid, iid):
        self.store.mr(pid, iid)
        return {"reports": [self.store.decorate(r) for r in self.store.reports(pid, iid)],
                "attempts": [a for a in reversed(self.store.attempts()) if a["project_id"] == pid and a["iid"] == iid]}

    def enqueue(self, pid, iid):
        with self.condition:
            self.store.mr(pid, iid)
            if self.closed or pid in self.removing:
                raise AppError("服务停止或项目移除中", "BUSY", 409)
            if any(a["project_id"] == pid and a["iid"] == iid and a["status"] in ACTIVE for a in self.store.attempts()):
                raise AppError("该 MR 已在检视队列中", "BUSY", 409)
            attempt = dict(id=uid(), project_id=pid, iid=iid, status="queued", step=0,
                           created_at=now(), message="排队中", steps=[])
            self.store.attempt(attempt)
            self.queue.append(attempt["id"])
            self.cancellations[attempt["id"]] = threading.Event()
            self.condition.notify()
            return attempt

    def stop(self, aid):
        with self.condition:
            attempt = next((a for a in self.store.attempts() if a["id"] == aid), None)
            if not attempt or attempt["status"] not in ACTIVE:
                raise AppError("该检视已经结束", "CONFLICT", 409)
            self.cancellations[aid].set()
            if attempt["status"] == "queued":
                self.queue.remove(aid)
                attempt.update(status="stopped", message="已取消排队", ended_at=now())
                self.cancellations.pop(aid, None)
            else:
                attempt.update(status="stopping", message="正在停止 · 终止子进程")
            self.store.attempt(attempt)
        self.processes.cancel(aid)

    def _worker(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.queue or self.closed)
                if self.closed:
                    return
                aid = self.queue.pop(0)
                attempt = next(a for a in self.store.attempts() if a["id"] == aid)
                attempt.update(status="running", started_at=now())
                self.store.attempt(attempt)
            self._review(attempt)

    def _review(self, attempt):
        aid, pid, iid = attempt["id"], attempt["project_id"], attempt["iid"]
        cancel = self.cancellations[aid]
        step_started = time.monotonic()
        copy = self.store.root / "tmp" / aid
        def update(**changes):
            with self.lock:
                attempt.update(changes)
                if cancel.is_set() and attempt["status"] == "running":
                    attempt.update(status="stopping", message="正在停止 · 清理临时目录")
                self.store.attempt(attempt)
        def step(n):
            nonlocal step_started
            if cancel.is_set():
                raise AppError("主动停止", "CANCELLED")
            if attempt["step"]:
                attempt["steps"].append(dict(number=attempt["step"], seconds=round(time.monotonic() - step_started, 1)))
            step_started = time.monotonic()
            update(step=n, message=STEPS[n - 1], step_started_at=now())
            self.log.log("INFO", f"步骤 {n}/7 · {STEPS[n-1]}", owner=aid, project_id=pid, iid=iid)
        try:
            rule_snapshot = self.rules.list()[0]
            step(1)
            mr = self.normalize_mr(pid, self.hub.mr(pid, iid, owner=aid, cancel=cancel))
            project = self.store.project(pid)
            step(2)
            source = self.git.fetch(project, mr["source_branch"], "source", aid, cancel)
            step(3)
            target = self.git.fetch(project, mr["target_branch"], "target", aid, cancel)
            step(4)
            fresh = self.normalize_mr(pid, self.hub.mr(pid, iid, owner=aid, cancel=cancel))
            if any(fresh[k] != mr[k] for k in ("updated_at", "source_branch", "target_branch")):
                raise AppError("MR 在拉取期间已变化，请重新获取并检视", "MR_CHANGED")
            step(5)
            diffs, skipped, commits, copy = self.git.snapshot(project, source, target, aid, cancel,
                                                            lambda m, n: update(message=f"文件 {m}/{n}", current=m, total=n))
            rules, invalid = self.rules.applicable(pid, list(diffs), rule_snapshot)
            metadata = dump(redact(dict(title=mr["title"], commits=commits)))
            prompt_chars = len(METHOD) + len(metadata) + len(dump(rules)) + len(dump(diffs)) + 128
            # Conservative one-character-per-token estimate, including Chinese text.
            if diffs and prompt_chars > self.config["context_limit"] * .25:
                raise AppError("变更超出模型上下文，请拆分 MR 或改为人工检视", "CONTEXT_PREFLIGHT")
            findings, model = [], "未调用 OpenCode"
            if diffs:
                step(6)
                def progress(stage, m, n, candidates, started):
                    label = {"search": "查找", "verify": "验证", "search-wrap": "查找收尾中", "verify-wrap": "验证收尾中"}[stage]
                    update(message=f"{label} {m}/{n} · 候选 {candidates} 个",
                           current=m, total=n, ai_started_at=attempt.get("ai_started_at", now()))
                findings, model = self.ai.review(copy, diffs, metadata, rules, aid, cancel, progress)
            step(7)
            update(message=f"意见 {len(findings)}/{len(findings)}")
            conclusion = "发现问题" if findings else "未发现问题" if diffs else "无可检视的变更"
            report = dict(id=uid(), project_id=pid, iid=iid, project_name=project["full_name"], mr_title=mr["title"],
                          mr_updated_at=mr["updated_at"], source_commit=source, target_commit=target, model=model,
                          created_at=now(), rules=rules, invalid_rules=invalid, excluded=skipped, conclusion=conclusion, findings=findings)
            # A terminal success is visible only after its temporary source copy is gone.
            self.git.clean(copy)
            # Serialize publication and archiving: no CLI send can race a report becoming historical.
            with self.publish_lock, self.lock:
                if cancel.is_set():
                    raise AppError("主动停止", "CANCELLED")
                attempt["steps"].append(dict(number=7, seconds=round(time.monotonic() - step_started, 1)))
                attempt.update(status="completed", message=conclusion, ended_at=now())
                self.store.save_report(report, attempt)
            self.log.log("INFO", "检视完成", owner=aid, conclusion=conclusion, findings=len(findings))
        except Exception as exc:
            stopped = cancel.is_set() or isinstance(exc, AppError) and exc.code == "CANCELLED"
            code = exc.code if isinstance(exc, AppError) else "INTERNAL_ERROR"
            message = str(exc) if isinstance(exc, AppError) else f"本地操作失败（{type(exc).__name__}），请检查数据目录权限与剩余空间"
            halt = not stopped and ((isinstance(exc, AppError) and exc.environment) or (attempt["step"] >= 6 and code != "CONTEXT_OVERFLOW"))
            with self.lock:
                attempt.update(status="stopping" if stopped else "failed", message="正在停止 · 清理临时目录" if stopped else message,
                               error_code=code, queue_stopped=halt, ended_at=now())
                self.store.attempt(attempt)
                if halt:
                    for queued in self.store.attempts():
                        if queued["id"] in self.queue:
                            queued.update(status="stopped", message="前序检视失败，队列已停止；请修复后手动发起", ended_at=now())
                            self.store.attempt(queued)
                            self.cancellations.pop(queued["id"], None)
                    self.queue.clear()
            self.log.log("INFO" if stopped else "ERROR", attempt["message"], owner=aid, step=attempt["step"], queue_stopped=halt)
        finally:
            try:
                self.git.clean(copy)
            except OSError:
                self.log.log("WARN", "检视副本清理失败，重启后会再次清理", owner=aid)
            if attempt["status"] == "stopping":
                # Shutdown interrupts are not user stops (R13).
                message = "ReviewX 关闭时中断" if self.closed else "主动停止不计为故障，没有生成可发布的意见"
                attempt.update(status="stopped", message=message, ended_at=now())
                self.store.attempt(attempt)
            self.cancellations.pop(aid, None)

    def finding(self, rid, fid):
        report = self.store.report(rid)
        self.store.mr(report["project_id"], report["iid"])
        if report["project_id"] in self.removing:
            raise AppError("项目正在移除", "BUSY", 409)
        if self.store.reports(report["project_id"], report["iid"])[0]["id"] != rid:
            raise AppError("历史报告只读，不能处理意见", "ARCHIVED", 409)
        finding = next((f for f in report["findings"] if f["id"] == fid), None)
        if not finding:
            raise AppError("意见不存在", "NOT_FOUND", 404)
        return report, finding, self.store.states(rid).get(fid, {"state": "pending"})["state"]

    def decide(self, rid, fid, action):
        allowed = {"dismiss": ("pending",), "undo": ("dismissed",), "confirm-published": ("unknown",),
                   "confirm-unpublished": ("unknown",), "send": ("pending", "failed")}
        if action not in allowed:
            raise AppError("当前意见状态不允许此操作", "CONFLICT", 409)
        if action != "send":
            # Local-only decisions never wait on a CLI send (R03 only serializes sends).
            # self.lock is also held while a new report is saved, so archiving cannot race this.
            with self.lock:
                _, _, state = self.finding(rid, fid)
                if state not in allowed[action]:
                    raise AppError("当前意见状态不允许此操作", "CONFLICT", 409)
                new_state = {"dismiss": "dismissed", "undo": "pending", "confirm-published": "manual", "confirm-unpublished": "failed"}[action]
                self.store.event(rid, fid, new_state, manual=action.startswith("confirm"),
                                 decision="dismiss" if action == "dismiss" else "send" if action.startswith("confirm") else None)
            self.log.log("INFO", "意见处理记录已追加", report_id=rid, finding_id=fid, action=action)
            return
        # Fail immediately on overlapping sends, never enqueue sends silently.
        if not self.publish_lock.acquire(blocking=False):
            raise AppError("已有意见发送中，请等待结果", "BUSY", 409)
        try:
            with self.lock:
                report, finding, state = self.finding(rid, fid)
                if state not in allowed[action]:
                    raise AppError("当前意见状态不允许此操作", "CONFLICT", 409)
                self.store.event(rid, fid, "sending", decision="send")
                self.sending = {"report_id": rid, "finding_id": fid, "project_id": report["project_id"]}
            try:
                result = self.hub.publish(report["project_id"], report["iid"], finding, comment_body(finding))
                self.store.event(rid, fid, "published", decision="send", **result)
                self.log.log("INFO", "意见已发布", report_id=rid, finding_id=fid)
            except Exception as exc:
                unknown = not isinstance(exc, AppError) or exc.code == "WRITE_RESULT_UNKNOWN"
                message = str(exc) if isinstance(exc, AppError) else "发送结果无法确认，请到 CodeHub 核对"
                self.store.event(rid, fid, "unknown" if unknown else "failed", decision="send", message=message)
                self.log.log("WARN", message, report_id=rid, finding_id=fid)
        finally:
            self.sending = None
            self.publish_lock.release()

    def dismiss_remaining(self, rid, confirmed):
        if confirmed is not True:
            raise AppError("请确认其余全部不发送")
        with self.lock, self.store.lock, self.store.db:
            report = self.store.report(rid)
            states = self.store.states(rid)
            for finding in report["findings"]:
                self.finding(rid, finding["id"])
                if states.get(finding["id"], {}).get("state", "pending") == "pending":
                    self.store.db.execute("INSERT INTO events(report_id,finding_id,state,created_at,data) VALUES(?,?,?,?,?)",
                                          (rid, finding["id"], "dismissed", now(), dump({"decision": "dismiss", "bulk": True})))

    def clear_cache(self, pid):
        with self.lock:
            if any(a["project_id"] == pid and a["status"] in ACTIVE for a in self.store.attempts()):
                raise AppError("项目有活动检视，结束后可清除代码缓存", "BUSY", 409)
            self.git.clean(self.git.cache(positive_id(pid)))
        self.log.log("INFO", "代码缓存已清除", project_id=pid)

    def remove_project(self, pid, confirmed):
        if confirmed is not True:
            raise AppError("请确认移除项目")
        with self.lock:
            if self.sending and self.sending["project_id"] == pid:
                raise AppError("评论发送中，暂不能移除项目", "BUSY", 409)
            self.removing.add(pid)
            active = [a for a in self.store.attempts() if a["project_id"] == pid and a["status"] in ACTIVE]
        try:
            for attempt in active:
                self.stop(attempt["id"])
            while any(a["project_id"] == pid and a["status"] in ACTIVE for a in self.store.attempts()):
                time.sleep(.1)
            # Wait for worker cleanup as well as its terminal state.
            while any(a["id"] in self.cancellations for a in active):
                time.sleep(.1)
            with self.lock:
                self.clear_cache(pid)
                self.store.write("UPDATE projects SET active=0 WHERE id=?", (pid,))
            self.log.log("INFO", "已移除关注项目，历史报告保留", project_id=pid)
        finally:
            self.removing.discard(pid)

    def close(self):
        with self.condition:
            self.closed = True
            self.processes.closed = True
            for event in self.cancellations.values():
                event.set()
            self.condition.notify_all()
        self.processes.cancel()
        self.worker.join(timeout=30)
        for thread in self.threads:
            thread.join(timeout=5)
        with self.publish_lock:
            self.store.recover()
        self.ai.close()
        self.log.log("INFO", "ReviewX 已停止")
