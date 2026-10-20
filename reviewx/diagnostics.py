import json
import threading
from datetime import datetime, timedelta
from .security import redact
from .store import now, dump


class Diagnostics:
    def __init__(self, root):
        self.root = root / "logs"
        self.root.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.day = ""
        self.prune()

    @property
    def path(self):
        return self.root / f"{datetime.now():%Y-%m-%d}.jsonl"

    def prune(self):
        current = self.path
        cutoff = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
        files = sorted(p for p in self.root.glob("????-??-??.jsonl") if not p.is_symlink())
        for path in files:
            if path != current and path.stem < cutoff:
                path.unlink(missing_ok=True)
        files = [p for p in files if p.exists()]
        total = sum(p.stat().st_size for p in files)
        for path in files:
            if total <= 100 * 1024 * 1024:
                break
            if path != current:
                total -= path.stat().st_size
                path.unlink()

    def log(self, level, message, **context):
        with self.lock:
            day = str(self.path)
            if day != self.day:
                self.day = day
                self.prune()
            record = dump(redact(dict(at=now(), level=level, message=message, **context))) + "\n"
            # Today's file is never removed. Bound writes so it cannot exceed the total cap.
            size = self.path.stat().st_size if self.path.exists() else 0
            if size + len(record.encode("utf-8")) <= 100 * 1024 * 1024:
                with self.path.open("a", encoding="utf-8") as file:
                    file.write(record)
            self.prune()

    def read(self, day=None):
        paths = sorted(self.root.glob("????-??-??.jsonl"), reverse=True)
        if day:
            paths = [p for p in paths if p.stem == day]
        result = []
        for path in paths:
            if path.is_symlink():
                continue
            # Retain a bounded tail without loading a 100 MB log into the browser.
            with path.open("rb") as file:
                file.seek(max(0, path.stat().st_size - 2 * 1024 * 1024))
                if file.tell():
                    file.readline()
                for line in file:
                    try:
                        result.append(json.loads(line))
                    except ValueError:
                        continue
            if len(result) >= 1000:
                break
        return sorted(result, key=lambda x: x["at"], reverse=True)[:1000]
