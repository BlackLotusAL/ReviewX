import json
import shutil
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from .security import AppError, redact


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def uid():
    return uuid.uuid4().hex


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class Store:
    """Reports and decisions are append-only; snapshots are replaceable projections."""
    VERSION = 1

    def __init__(self, directory):
        self.root = Path(directory)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / "reviewx.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > self.VERSION:
            self.db.close()
            raise AppError("数据版本高于程序版本，请升级 ReviewX")
        if version and version < self.VERSION:
            self.backup(version)
            raise AppError("尚无此数据版本的迁移程序，原数据未改动；请升级 ReviewX")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
                position INTEGER NOT NULL, fetch_status TEXT DEFAULT 'idle', fetched_at TEXT, error TEXT
            );
            CREATE TABLE IF NOT EXISTS mrs (project_id TEXT, iid TEXT, data TEXT NOT NULL,
                visible INTEGER DEFAULT 1, PRIMARY KEY (project_id, iid));
            CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, project_id TEXT, iid TEXT,
                status TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reports (seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT UNIQUE NOT NULL, project_id TEXT, iid TEXT, created_at TEXT, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,
                report_id TEXT NOT NULL, finding_id TEXT NOT NULL, state TEXT NOT NULL,
                created_at TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TRIGGER IF NOT EXISTS immutable_reports_update BEFORE UPDATE ON reports
                BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_reports_delete BEFORE DELETE ON reports
                BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_events_update BEFORE UPDATE ON events
                BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_events_delete BEFORE DELETE ON events
                BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
            PRAGMA user_version=1;
        """)
        self.db.commit()

    def backup(self, version):
        path = self.root / "backups" / f"v{version}-{datetime.now():%Y%m%d-%H%M%S}"
        path.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path / "reviewx.sqlite3") as target:
            self.db.backup(target)
        for name in ("rules", "logs"):
            if (self.root / name).exists():
                shutil.copytree(self.root / name, path / name)
        for old in sorted(path.parent.iterdir(), reverse=True)[3:]:
            if old.is_dir() and old.resolve().is_relative_to(path.parent.resolve()):
                shutil.rmtree(old)
        return path

    def rows(self, sql, values=()):
        with self.lock:
            return [dict(x) for x in self.db.execute(sql, values).fetchall()]

    def write(self, sql, values=()):
        with self.lock, self.db:
            self.db.execute(sql, values)

    def projects(self, active=True):
        return [{**json.loads(x["data"]), **{k: v for k, v in x.items() if k != "data"}}
                for x in self.rows("SELECT * FROM projects " + ("WHERE active=1 " if active else "") + "ORDER BY position")]

    def project(self, pid):
        return next((p for p in self.projects() if p["id"] == pid), None)

    def follow(self, project):
        with self.lock, self.db:
            prior = self.rows("SELECT * FROM projects WHERE id=?", (project["id"],))
            if prior and prior[0]["active"]:
                raise AppError(f"该项目已在关注列表中：{json.loads(prior[0]['data'])['full_name']}（{project['id']}）", "DUPLICATE", 409)
            position = self.db.execute("SELECT COALESCE(MAX(position),0)+1 FROM projects").fetchone()[0]
            self.db.execute("INSERT INTO projects(id,data,position) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,active=1,position=excluded.position",
                            (project["id"], dump(project), position))
            return self.db.execute("SELECT COUNT(*) FROM reports WHERE project_id=?", (project["id"],)).fetchone()[0]

    def replace_mrs(self, pid, mrs):
        with self.lock, self.db:
            self.db.execute("UPDATE mrs SET visible=0 WHERE project_id=?", (pid,))
            for mr in mrs:
                self.db.execute("INSERT INTO mrs VALUES(?,?,?,1) ON CONFLICT(project_id,iid) DO UPDATE SET data=excluded.data,visible=1",
                                (pid, mr["iid"], dump(mr)))
            self.db.execute("UPDATE projects SET fetch_status='updated',fetched_at=?,error=NULL WHERE id=?", (now(), pid))

    def mr(self, pid, iid):
        rows = self.rows("SELECT data FROM mrs WHERE project_id=? AND iid=? AND visible=1", (pid, iid))
        if not rows or not self.project(pid):
            raise AppError("MR 不在当前关注项目的开放列表中", "NOT_FOUND", 404)
        return json.loads(rows[0]["data"])

    def attempt(self, attempt):
        self.write("INSERT INTO attempts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
                   (attempt["id"], attempt["project_id"], attempt["iid"], attempt["status"], dump(attempt)))

    def attempts(self):
        return [json.loads(x["data"]) for x in self.rows("SELECT data FROM attempts ORDER BY rowid")]

    def save_report(self, report, attempt):
        with self.lock, self.db:
            self.db.execute("INSERT INTO reports(id,project_id,iid,created_at,data) VALUES(?,?,?,?,?)",
                            (report["id"], report["project_id"], report["iid"], report["created_at"], dump(redact(report))))
            self.db.execute("UPDATE attempts SET status=?,data=? WHERE id=?", (attempt["status"], dump(attempt), attempt["id"]))

    def reports(self, pid=None, iid=None):
        sql, args = "SELECT data FROM reports", ()
        if pid is not None:
            sql += " WHERE project_id=? AND iid=?"
            args = (pid, iid)
        return [json.loads(x["data"]) for x in self.rows(sql + " ORDER BY seq DESC", args)]

    def report(self, rid):
        row = self.rows("SELECT data FROM reports WHERE id=?", (rid,))
        if not row:
            raise AppError("报告不存在", "NOT_FOUND", 404)
        return json.loads(row[0]["data"])

    def states(self, rid):
        return {x["finding_id"]: {**json.loads(x["data"]), "state": x["state"], "at": x["created_at"]}
                for x in self.rows("SELECT * FROM events WHERE report_id=? ORDER BY seq", (rid,))}

    def event(self, rid, fid, state, **data):
        self.write("INSERT INTO events(report_id,finding_id,state,created_at,data) VALUES(?,?,?,?,?)",
                   (rid, fid, state, now(), dump(redact(data))))

    def decorate(self, report):
        states = self.states(report["id"])
        latest = self.reports(report["project_id"], report["iid"])[0]["id"] == report["id"]
        return {**report, "latest": latest, "findings": [
            {**f, "handling": ({"state": "superseded"} if not latest and states.get(f["id"], {}).get("state", "pending") == "pending"
                              else states.get(f["id"], {"state": "pending"})),
             "history": [{**json.loads(e["data"]), "state": e["state"], "at": e["created_at"]}
                         for e in self.rows("SELECT * FROM events WHERE report_id=? AND finding_id=? ORDER BY seq", (report["id"], f["id"]))]}
            for f in report["findings"]]}

    def recover(self):
        with self.lock:
            for attempt in self.attempts():
                if attempt["status"] in ("queued", "running", "stopping"):
                    attempt.update(status="stopped", message="ReviewX 关闭时中断", ended_at=now())
                    self.attempt(attempt)
            for report in self.reports():
                for fid, state in self.states(report["id"]).items():
                    if state["state"] == "sending":
                        self.event(report["id"], fid, "unknown", decision="send", message="发送时 ReviewX 关闭，请到 CodeHub 核对")
            self.write("UPDATE projects SET fetch_status='failed',error='获取时 ReviewX 关闭，请重新获取' WHERE fetch_status='fetching'")
