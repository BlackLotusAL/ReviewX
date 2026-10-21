import json
import shutil
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from reviewx.config import load_config
from reviewx.findings import comment_body, merge_candidates, validate_finding
from reviewx.opencode import Submission, split_diffs
from reviewx.security import AppError, excluded, inside, redact
from reviewx.service import Service
from reviewx.store import Store, uid, now
from helpers import FakeHub, FakeAI, finding, report, mr, project, wait_for

TEST_ROOT = Path(__file__).resolve().parent.parent / ".reviewx-tests"


class ServiceCase(unittest.TestCase):
    def setUp(self):
        TEST_ROOT.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.hub = FakeHub()
        self.s = Service(load_config(overrides={"data_dir": self.temp.name}), self.hub, FakeAI())
        self.s.store.follow(project())
        self.s.store.replace_mrs("101", [mr()])

    def tearDown(self):
        self.s.close()
        self.s.store.db.close()
        self.temp.cleanup()

    def save(self, value=None):
        value = value or report()
        a = dict(id=uid(), project_id=value["project_id"], iid=value["iid"], status="completed", step=7, steps=[], message="检视完成")
        self.s.store.attempt(a)
        self.s.store.save_report(value, a)
        return value

    def test_publish_is_explicit_single_and_preserves_template(self):
        r = self.save()
        self.assertFalse(any(c[0] == "publish" for c in self.hub.calls))
        self.s.decide(r["id"], r["findings"][0]["id"], "send")
        calls = [c for c in self.hub.calls if c[0] == "publish"]
        self.assertEqual(len(calls), 1)
        self.assertIn("### 🟠 Major", calls[0][3])
        self.assertIn("src/parser.ts:18-22", calls[0][3])
        with self.assertRaises(AppError):
            self.s.decide(r["id"], r["findings"][0]["id"], "send")
        self.assertEqual(len([c for c in self.hub.calls if c[0] == "publish"]), 1)

    def test_unknown_manual_confirmation_never_calls_cli(self):
        r = self.save()
        fid = r["findings"][0]["id"]
        self.hub.error = AppError("结果未知", "WRITE_RESULT_UNKNOWN")
        self.s.decide(r["id"], fid, "send")
        self.assertEqual(self.s.store.states(r["id"])[fid]["state"], "unknown")
        with self.assertRaises(AppError):
            self.s.decide(r["id"], fid, "send")
        self.s.decide(r["id"], fid, "confirm-published")
        self.assertEqual(self.s.store.states(r["id"])[fid]["state"], "manual")
        self.assertEqual(len([c for c in self.hub.calls if c[0] == "publish"]), 1)

    def test_failed_can_retry_once_per_click(self):
        r = self.save()
        fid = r["findings"][0]["id"]
        self.hub.error = AppError("未登录", "AUTH_ERROR")
        self.s.decide(r["id"], fid, "send")
        self.assertEqual(self.s.snapshot()["projects"][0]["mrs"][0]["pending"], 0)
        self.assertEqual(self.s.snapshot()["projects"][0]["mrs"][0]["check"], 1)
        self.hub.error = None
        self.s.decide(r["id"], fid, "send")
        self.assertEqual(len([c for c in self.hub.calls if c[0] == "publish"]), 2)

    def test_global_publish_mutex(self):
        r = self.save(report(findings=[finding(), finding()]))
        self.hub.publish_gate = threading.Event()
        thread = threading.Thread(target=self.s.decide, args=(r["id"], r["findings"][0]["id"], "send"))
        thread.start()
        wait_for(lambda: self.s.sending)
        with self.assertRaises(AppError):
            self.s.decide(r["id"], r["findings"][1]["id"], "send")
        self.hub.publish_gate.set()
        thread.join()
        self.assertEqual(len([c for c in self.hub.calls if c[0] == "publish"]), 1)

    def test_history_is_immutable_and_readonly(self):
        old = self.save()
        fid = old["findings"][0]["id"]
        self.s.decide(old["id"], fid, "dismiss")
        self.s.decide(old["id"], fid, "undo")
        self.save()
        self.assertEqual(self.s.store.decorate(old)["findings"][0]["handling"]["state"], "superseded")
        with self.assertRaises(AppError):
            self.s.decide(old["id"], fid, "send")
        with self.assertRaises(sqlite3.IntegrityError):
            self.s.store.write("UPDATE reports SET data='{}'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.s.store.write("DELETE FROM events")
        self.assertEqual(self.s.store.report(old["id"]), old)

    def test_bulk_dismiss_requires_confirmation_and_undo_is_local(self):
        r = self.save(report(findings=[finding(), finding()]))
        with self.assertRaises(AppError):
            self.s.dismiss_remaining(r["id"], False)
        self.s.dismiss_remaining(r["id"], True)
        self.assertEqual(self.s.snapshot()["projects"][0]["mrs"][0]["pending"], 0)
        self.s.decide(r["id"], r["findings"][0]["id"], "undo")
        self.assertEqual(self.s.snapshot()["projects"][0]["mrs"][0]["pending"], 1)
        self.assertFalse(self.hub.calls)

    def test_recovery_sending_becomes_unknown_queued_stopped(self):
        r = self.save()
        fid = r["findings"][0]["id"]
        self.s.store.event(r["id"], fid, "sending")
        a = dict(id=uid(), project_id="101", iid="1", status="queued")
        self.s.store.attempt(a)
        self.s.store.recover()
        self.assertEqual(self.s.store.states(r["id"])[fid]["state"], "unknown")
        self.assertEqual(self.s.store.attempts()[-1]["status"], "stopped")
        db = Store(self.temp.name)
        self.assertEqual(db.report(r["id"]), r)
        db.db.close()

    def test_fetch_atomic_failure_retains_old_and_continues(self):
        self.s.store.follow(project("102"))
        self.s.store.replace_mrs("102", [mr("102", title="上次结果")])
        self.hub.fail_projects.add("102")
        self.s.fetch()
        wait_for(lambda: not self.s.fetching)
        state = self.s.snapshot()
        self.assertEqual(state["projects"][1]["mrs"][0]["title"], "上次结果")
        self.assertEqual(state["projects"][0]["fetch_status"], "updated")
        self.assertEqual(state["fetch_progress"], dict(total=2, done=2, failed=1))
        self.assertEqual(self.hub.calls[0], ("list", "101"))

    def test_detail_failure_does_not_replace_partial_project(self):
        self.hub.rows["101"] = [mr(), mr(iid="2")]
        original = self.hub.mr
        def fail(pid, iid, **kw):
            if iid == "2":
                raise AppError("详情失败")
            return original(pid, iid)
        self.hub.mr = fail
        self.s.fetch()
        wait_for(lambda: not self.s.fetching)
        self.assertEqual(len(self.s.snapshot()["projects"][0]["mrs"]), 1)
        self.assertEqual(self.s.store.project("101")["fetch_status"], "failed")

    def test_removed_mr_hides_reports_but_keeps_history(self):
        r = self.save()
        self.s.store.replace_mrs("101", [])
        with self.assertRaises(AppError):
            self.s.detail("101", "1")
        self.assertEqual(self.s.store.report(r["id"]), r)
        self.s.store.replace_mrs("101", [mr()])
        self.assertEqual(len(self.s.detail("101", "1")["reports"]), 1)

    def test_validation_duplicate_never_calls_cli(self):
        for value in ("", "0", "-1", "x", "1.5"):
            with self.assertRaises(AppError):
                self.s.add_project(value)
        with self.assertRaises(AppError):
            self.s.add_project("101")
        self.assertFalse(self.hub.calls)

    def test_rules_external_reload_invalid_skip_and_snapshot(self):
        rule = self.s.rules.save(dict(name="数据库", scope="101", enabled=True, files=["src/db/**"], points="检查事务"))
        selected, invalid = self.s.rules.applicable("101", ["src/api/x.ts"])
        self.assertNotIn("数据库", [r["name"] for r in selected])
        selected, _ = self.s.rules.applicable("101", ["src/db/x.ts"])
        self.assertIn("数据库", [r["name"] for r in selected])
        path = self.s.rules.root / (rule["id"] + ".md")
        path.write_text("invalid", encoding="utf-8")
        _, invalid = self.s.rules.applicable("101", ["src/db/x.ts"])
        self.assertEqual(len(invalid), 1)

    def test_rule_statistics_count_failed_send_once_and_undo(self):
        rule = self.s.rules.list()[0][0]
        r = self.save(report(findings=[finding(rule=rule["name"]), finding(rule=rule["name"])], rules=[rule]))
        self.hub.error = AppError("失败", "AUTH_ERROR")
        self.s.decide(r["id"], r["findings"][0]["id"], "send")
        self.s.decide(r["id"], r["findings"][0]["id"], "send")
        self.s.decide(r["id"], r["findings"][1]["id"], "dismiss")
        stat = next(x for x in self.s.rules.list()[0] if x["id"] == rule["id"])["stats"]
        self.assertEqual(stat, dict(hits=2, sent=1, dismissed=1))

    def test_queue_serial_duplicate_cancel_and_failure_policy(self):
        self.s.store.replace_mrs("101", [mr(), mr(iid="2"), mr(iid="3")])
        self.hub.rows["101"] = [mr(), mr(iid="2"), mr(iid="3")]
        gate = threading.Event()
        entered = threading.Event()
        def fail(*_):
            entered.set(); gate.wait(3)
            raise AppError("Git 认证失败", "AUTH_ERROR", environment=True)
        self.s.git.fetch = fail
        first = self.s.enqueue("101", "1")
        entered.wait(1)
        with self.assertRaises(AppError):
            self.s.enqueue("101", "1")
        second = self.s.enqueue("101", "2")
        third = self.s.enqueue("101", "3")
        self.s.stop(third["id"])
        gate.set()
        wait_for(lambda: not self.s.snapshot()["queue"])
        states = {a["id"]: a["status"] for a in self.s.store.attempts()}
        self.assertEqual(states[first["id"]], "failed")
        self.assertEqual(states[second["id"]], "stopped")
        self.assertEqual(states[third["id"]], "stopped")
        self.assertEqual(self.s.store.reports(), [])

    def prepare_pipeline(self, diff=None):
        self.s.git.fetch = lambda *args: "a" * 40
        def snapshot(project, source, target, owner, cancel, progress):
            copy = self.s.store.root / "tmp" / owner
            copy.mkdir()
            progress(1, 1)
            return ({"src/a.ts": diff} if diff is not None else {}), [], "commit", copy
        self.s.git.snapshot = snapshot

    def test_no_changes_saves_distinct_conclusion_without_ai(self):
        self.prepare_pipeline()
        self.s.ai.review = lambda *args: self.fail("AI must not be called for no reviewable changes")
        self.s.enqueue("101", "1")
        wait_for(lambda: not self.s.snapshot()["queue"])
        self.assertEqual(self.s.store.reports()[0]["conclusion"], "无可检视的变更")
        self.assertEqual(list((self.s.store.root / "tmp").iterdir()), [])

    def test_success_no_findings_and_failed_retry_preserves_latest(self):
        self.prepare_pipeline("diff")
        self.s.enqueue("101", "1")
        wait_for(lambda: not self.s.snapshot()["queue"])
        prior = self.s.store.reports()[0]
        self.assertEqual(prior["conclusion"], "未发现问题")
        def fail(*args):
            raise AppError("检视未完成", "INCOMPLETE")
        self.s.ai.review = fail
        self.s.enqueue("101", "1")
        wait_for(lambda: not self.s.snapshot()["queue"])
        self.assertEqual(self.s.store.reports(), [prior])
        self.assertTrue(self.s.store.decorate(prior)["latest"])

    def test_context_preflight_does_not_call_ai(self):
        self.prepare_pipeline("x" * 100000)
        self.s.ai.review = lambda *args: self.fail("preflight must stop before AI")
        self.s.enqueue("101", "1")
        wait_for(lambda: not self.s.snapshot()["queue"])
        attempt = self.s.store.attempts()[-1]
        self.assertEqual(attempt["error_code"], "CONTEXT_PREFLIGHT")
        self.assertFalse(attempt["queue_stopped"])
        self.assertEqual(self.s.store.reports(), [])

    def test_save_failure_never_exposes_partial_report(self):
        self.prepare_pipeline("diff")
        with patch.object(self.s.store, "save_report", side_effect=OSError("disk full")):
            self.s.enqueue("101", "1")
            wait_for(lambda: not self.s.snapshot()["queue"])
        self.assertEqual(self.s.store.reports(), [])
        self.assertTrue(self.s.store.attempts()[-1]["queue_stopped"])

    def test_mr_change_during_fetch_fails_before_ai(self):
        self.prepare_pipeline("diff")
        calls = 0
        def changing(*args, **kwargs):
            nonlocal calls
            calls += 1
            return mr(updated_at="2026-10-21T12:00:00Z" if calls == 2 else "2026-10-20T10:00:00Z")
        self.hub.mr = changing
        self.s.enqueue("101", "1")
        wait_for(lambda: not self.s.snapshot()["queue"])
        self.assertEqual(self.s.store.attempts()[-1]["error_code"], "MR_CHANGED")
        self.assertEqual(self.s.store.reports(), [])


class ValidationCase(unittest.TestCase):
    def test_config_and_exclusions(self):
        for config in ({"port": 0}, {"safety_ratio": .99}, {"focus_areas": []}, {"excluded_files": ["src/*.png"]}):
            with self.assertRaises(ValueError):
                load_config(overrides=config)
        self.assertTrue(excluded("src/package-lock.json", ["package-lock.json"]))
        self.assertFalse(excluded("package-lock.json/src.ts", ["package-lock.json"]))
        self.assertTrue(excluded("foo/a.min.js", [".min.js"]))

    def test_finding_validation_rules_evidence_and_paths(self):
        f = {**finding(), "candidate_id": "c", "evidence": "src/parser.ts:18"}
        self.assertEqual(validate_finding(f, ["正确性"])["title"], f["title"])
        for replacement in ({"rule": "虚构规则"}, {"evidence": "无依据"}, {"location": {"path": "../secret"}}, {"solutions": []}, {"impact": {"scope": "x"}}):
            with self.assertRaises(AppError):
                validate_finding({**f, **replacement}, ["正确性"])
        self.assertIn('```ts\nif (!items.length) return [];\n```', comment_body(f))

    def test_candidates_merge_and_finish_contract(self):
        root = TEST_ROOT / "mcp"
        root.mkdir(parents=True, exist_ok=True)
        c = dict(severity="minor", title="疑点", suspicion="原因", evidence="a.ts:8", location={"path": "a.ts", "start_line": 8})
        merged = merge_candidates([c, {**c, "location": {"path": "a.ts", "start_line": 11}}])
        self.assertEqual(len(merged), 1)
        session = Submission("verify", root, [], ["正确性"], merged)
        with self.assertRaises(AppError):
            session.call("finish_review", {})
        session.call("reject_candidate", {"candidate_id": merged[0]["id"], "reason": "不成立"})
        with self.assertRaises(AppError):
            session.call("reject_candidate", {"candidate_id": merged[0]["id"], "reason": "重复"})
        session.call("finish_review", {})
        with self.assertRaises(AppError):
            session.call("finish_review", {})

    def test_mcp_file_guard_blocks_traversal_excluded_grep_and_binary(self):
        root = TEST_ROOT / "sandbox"
        root.mkdir(parents=True, exist_ok=True)
        (root / "ok.ts").write_text("const token = 1;\n", encoding="utf-8")
        (root / "yarn.lock").write_text("TOP_SECRET", encoding="utf-8")
        (root / "binary").write_bytes(b"a\0b")
        s = Submission("search", root, ["yarn.lock"], [])
        for path in ("../secret", "C:/secret", "yarn.lock", "binary"):
            with self.assertRaises(AppError):
                s.call("read", {"path": path, "reason": "verify"})
        self.assertEqual(s.call("grep", {"pattern": "TOP_SECRET", "reason": "verify"}), [])
        self.assertIn("1: const", s.call("read", {"path": "ok.ts", "reason": "verify"}))
        s.wrapping = True
        with self.assertRaises(AppError):
            s.call("read", {"path": "ok.ts", "reason": "verify"})

    def test_redaction(self):
        value = redact({"token": "TOPSECRET", "message": "Authorization: Bearer abc123 and https://name:pw@example.com/path private-token=xyz"})
        self.assertNotIn("TOPSECRET", json.dumps(value))
        self.assertNotIn("abc123", value["message"])
        self.assertNotIn("name:pw", value["message"])
        self.assertNotIn("xyz", value["message"])

    def test_shards_keep_files_whole(self):
        diffs = {"src/a": "a" * 100, "src/b": "b" * 50, "test/c": "c" * 80}
        parts = split_diffs(diffs, 230, 150)
        self.assertEqual(len(parts), 2)
        self.assertEqual({k: v for p in parts for k, v in p.items()}, diffs)

    def test_shards_keep_directories_together(self):
        diffs = {"src/db/a": "a" * 40, "src/db/b": "b" * 40, "web/x": "x" * 40, "web/y": "y" * 40}
        parts = split_diffs(diffs, 200, 100)
        self.assertEqual(sorted(sorted(p) for p in parts), [["src/db/a", "src/db/b"], ["web/x", "web/y"]])

    def test_candidates_do_not_chain_merge(self):
        c = dict(severity="minor", title="疑点", suspicion="原因", evidence="a.ts:1", location={"path": "a.ts", "start_line": 10})
        merged = merge_candidates([{**c, "title": str(n), "location": {"path": "a.ts", "start_line": n}} for n in (10, 13, 16, 19)])
        self.assertEqual([m["location"]["start_line"] for m in merged], [10, 16])


if __name__ == "__main__":
    unittest.main()
