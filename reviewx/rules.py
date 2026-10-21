import json
import os
import re
import threading
import tomli
from datetime import datetime, timedelta, timezone
from .security import AppError, inside, matches
from .store import uid

BUILTINS = [
    ("正确性", "核对状态转换、数据一致性与业务条件，关注可复现的逻辑错误。", "先验证前置条件，再修改状态。", "空值未校验就直接访问其字段。"),
    ("安全", "检查权限边界、输入校验、敏感数据保护和注入风险。", "使用参数化查询，并在服务端校验资源归属。", "将用户输入直接拼入 SQL 或命令。"),
    ("性能", "检查本次变更引入的不必要计算、重复请求和资源泄漏。", "复用连接，及时释放资源。", "循环内部重复执行相同的数据库查询。"),
    ("可维护性", "检查接口契约、错误传播、可测试性和容易误用的设计。", "清晰的类型与明确的错误处理。", "吞掉异常并返回看似成功的结果。"),
]


class Rules:
    def __init__(self, store):
        self.store = store
        self.root = store.root / "rules"
        self.lock = threading.RLock()
        first = not self.root.exists()
        self.root.mkdir(exist_ok=True)
        if first:
            for name, points, good, bad in BUILTINS:
                self.save(dict(name=name, scope="global", enabled=True, files=[], points=points, good=good, bad=bad, builtin=True))

    def validate(self, data):
        for key in ("name", "points"):
            if not isinstance(data.get(key), str) or not data[key].strip():
                raise AppError(f"{key} 不可为空")
        scope = data.get("scope", "global")
        if scope != "global" and not re.fullmatch(r"[1-9]\d*", str(scope)):
            raise AppError("scope 应为 global 或 Project ID")
        files = data.get("files", [])
        if not isinstance(files, list) or any(not isinstance(x, str) or not x.strip() or ".." in x or "\\" in x or ":" in x or x.startswith("/") for x in files):
            raise AppError("files 应为仓库相对 glob 模式数组")
        if type(data.get("enabled", False)) is not bool:
            raise AppError("enabled 应为布尔值")
        for key in ("good", "bad"):
            if not isinstance(data.get(key, ""), str):
                raise AppError(f"{key} 应为文本")
        return {k: data.get(k, default) for k, default in
                dict(name="", scope="global", enabled=False, files=[], points="", good="", bad="", builtin=False).items()}

    def parse(self, path):
        text = path.read_text("utf-8-sig")
        if not text.startswith("+++\n"):
            raise ValueError("缺少 +++ TOML 元信息")
        head, body = text[4:].split("\n+++\n", 1)
        meta = tomli.loads(head)
        sections = dict(re.findall(r"## (检查要点|正例|反例)\n([\s\S]*?)(?=\n## (?:检查要点|正例|反例)\n|$)", body))
        data = self.validate({**meta, "points": sections.get("检查要点", "").strip(),
                              "good": sections.get("正例", "").strip(), "bad": sections.get("反例", "").strip()})
        return {**data, "id": path.stem, "markdown": text, "error": None}

    def list(self):
        result = []
        with self.lock:
            for path in sorted(self.root.glob("*.md")):
                if path.is_symlink():
                    continue
                try:
                    result.append(self.parse(path))
                except (ValueError, OSError, AppError) as exc:
                    result.append(dict(id=path.stem, name=path.stem, scope="global", enabled=False,
                                       files=[], error=str(exc), points="", good="", bad=""))
        names = [rule["name"] for rule in result if not rule["error"]]
        for rule in result:
            if names.count(rule["name"]) > 1:
                rule["error"] = "规则名称重复，请使用唯一名称"
        counts = {}
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        unassigned = dict(hits=0, sent=0, dismissed=0)
        for report in self.store.reports():
            if report["created_at"] < cutoff:
                continue
            states = self.store.states(report["id"])
            rule_ids = {r["name"]: r["id"] for r in report.get("rules", [])}
            for finding in report["findings"]:
                key = rule_ids.get(finding.get("rule", ""))
                stat = counts.setdefault(key, dict(hits=0, sent=0, dismissed=0)) if key else unassigned
                stat["hits"] += 1
                state = states.get(finding["id"], {}).get("state")
                stat["sent"] += int(state in ("sending", "published", "manual", "failed", "unknown"))
                stat["dismissed"] += int(state == "dismissed")
        for rule in result:
            rule["stats"] = counts.get(rule["id"], dict(hits=0, sent=0, dismissed=0))
        return result, unassigned

    def save(self, data, rid=None):
        data = self.validate(data)
        rid = rid or uid()
        if not re.fullmatch(r"[A-Za-z0-9_-]+", rid):
            raise AppError("规则 ID 格式错误")
        with self.lock:
            for rule in self.list()[0]:
                if rule["id"] != rid and rule["name"] == data["name"]:
                    raise AppError("规则名称已存在，请使用不同名称")
            meta = "\n".join(f"{key} = {json.dumps(data[key], ensure_ascii=False)}"
                             for key in ("name", "scope", "enabled", "files", "builtin"))
            body = f"+++\n{meta}\n+++\n\n## 检查要点\n{data['points']}\n\n## 正例\n{data['good']}\n\n## 反例\n{data['bad']}\n"
            target = inside(self.root, f"{rid}.md")
            temp = target.with_suffix(".tmp")
            temp.write_text(body, encoding="utf-8")
            os.replace(temp, target)
            return self.parse(target)

    def delete(self, rid):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", rid):
            raise AppError("规则 ID 格式错误")
        inside(self.root, rid + ".md").unlink(missing_ok=True)

    def applicable(self, pid, files, snapshot=None):
        selected, invalid = [], []
        for rule in snapshot if snapshot is not None else self.list()[0]:
            if rule["error"]:
                invalid.append({"name": rule["name"], "reason": rule["error"]})
            elif rule["enabled"] and rule["scope"] in ("global", pid):
                if not rule["files"] or any(matches(p, pattern) for p in files for pattern in rule["files"]):
                    selected.append({k: v for k, v in rule.items() if k != "stats"})
        return selected, invalid
