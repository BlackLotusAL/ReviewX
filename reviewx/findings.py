from .security import AppError, relative_path
from .store import uid

SEVERITIES = ("fatal", "major", "minor", "suggestion")
LOCATION = {"type": "object", "properties": {"path": {"type": "string"},
            "start_line": {"type": "integer", "minimum": 1}, "end_line": {"type": "integer", "minimum": 1}}, "required": ["path"]}
TEXT = {"type": "string", "minLength": 1}
CODE = {"type": "object", "properties": {"code": {"type": "string"}, "language": {"type": "string"}}, "required": ["code"]}
CANDIDATE_SCHEMA = {"type": "object", "properties": {
    "severity": {"enum": list(SEVERITIES)}, "title": TEXT, "suspicion": TEXT, "location": LOCATION, "evidence": TEXT,
}, "required": ["severity", "title", "suspicion", "location", "evidence"]}
FINDING_SCHEMA = {"type": "object", "properties": {
    "candidate_id": TEXT, "severity": {"enum": list(SEVERITIES)}, "title": TEXT,
    "tags": {"type": "array", "items": TEXT}, "summary": TEXT, "location": LOCATION,
    "related_code": CODE, "impact": {"type": "object", "properties": {k: TEXT for k in ("consequence", "scope", "trigger")}, "required": ["consequence", "scope", "trigger"]},
    "solutions": {"type": "array", "minItems": 1, "items": {"type": "object", "properties": {"description": TEXT, "code": CODE}, "required": ["description"]}},
    "prevention": {"type": "array", "items": TEXT}, "rule": {"type": "string"}, "evidence": TEXT,
}, "required": ["candidate_id", "severity", "title", "summary", "location", "impact", "solutions", "evidence"]}


def validate_schema(value, schema, path=""):
    kind = schema.get("type")
    valid = {"object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str),
             "integer": type(value) is int}
    if kind and not valid[kind]:
        raise AppError(f"{path or '参数'} 应为 {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise AppError(f"{path} 应为 {' / '.join(schema['enum'])}")
    if kind == "string" and schema.get("minLength") and not value.strip():
        raise AppError(f"{path} 不可为空")
    if kind == "integer" and value < schema.get("minimum", 0):
        raise AppError(f"{path} 应为正整数")
    if kind == "object":
        for key in schema.get("required", []):
            if key not in value:
                raise AppError(f"{path + '.' if path else ''}{key} 为必填字段")
        return {key: validate_schema(val, schema["properties"][key], f"{path + '.' if path else ''}{key}")
                for key, val in value.items() if key in schema.get("properties", {})}
    if kind == "array":
        if len(value) < schema.get("minItems", 0):
            raise AppError(f"{path} 至少需要 {schema['minItems']} 项")
        return [validate_schema(v, schema["items"], f"{path}[{i}]") for i, v in enumerate(value)]
    return value


def validate_location(location):
    relative_path(location["path"], allow_empty=True)
    start, end = location.get("start_line"), location.get("end_line")
    if end is not None and (start is None or end < start):
        raise AppError("location.end_line 不可小于 start_line")
    return location


def validate_finding(data, rules):
    data = validate_schema(data, FINDING_SCHEMA)
    validate_location(data["location"])
    if data.get("rule") and data["rule"] not in rules:
        raise AppError("rule 必须是本次使用的规则名")
    import re
    if not re.search(r"[^\s:]+:\d+", data["evidence"]):
        raise AppError("evidence 应包含 文件:行号 依据")
    return data


def merge_candidates(candidates):
    result = []
    for candidate in sorted(candidates, key=lambda c: (c["location"]["path"], c["location"].get("start_line", 0))):
        previous = result[-1] if result else None
        same = previous and previous["location"]["path"] == candidate["location"]["path"]
        # Compare with the group's first line so merging cannot chain beyond 3 lines (R10).
        nearby = same and candidate["location"].get("start_line") and previous["location"].get("start_line") and abs(candidate["location"]["start_line"] - previous["location"]["start_line"]) <= 3
        duplicate = same and previous["title"] == candidate["title"] and previous["location"] == candidate["location"]
        if nearby or duplicate:
            previous["suspicion"] += "\n" + candidate["suspicion"]
            previous["evidence"] += "\n" + candidate["evidence"]
            previous["severity"] = min((previous["severity"], candidate["severity"]), key=SEVERITIES.index)
        else:
            result.append({**candidate, "id": uid()})
    return result


def finding_order(f):
    return SEVERITIES.index(f["severity"]), f["location"]["path"], f["location"].get("start_line", 0)


def comment_body(f):
    light = dict(fatal="🔴", major="🟠", minor="🟡", suggestion="🟢")[f["severity"]]
    severity = f["severity"].title()
    location = f["location"]
    where = location["path"] or "无法定位到具体文件"
    if location.get("start_line"):
        where += f":{location['start_line']}"
        if location.get("end_line") and location["end_line"] != location["start_line"]:
            where += f"-{location['end_line']}"
    def code_block(code):
        # Longer fences preserve code that itself contains markdown fences.
        import re
        fence = "`" * max(3, max((len(x) + 1 for x in re.findall(r"`+", code["code"])), default=3))
        language = re.sub(r"[^a-zA-Z0-9_+-]", "", code.get("language", ""))
        return f"\n{fence}{language}\n{code['code']}\n{fence}\n"
    parts = [f"### {light} {severity}: {f['title']}", "**问题描述**：",
             f"- 严重级别：{severity}", *(["- 标签：" + " ".join(f"`#{t.lstrip('#')}`" for t in f["tags"])] if f.get("tags") else []),
             f"- 简述：{f['summary']}", f"\n**问题位置**：`{where}`"]
    if f.get("related_code"):
        parts.append(code_block(f["related_code"]))
    parts += ["\n**影响分析**：", f"- **直接后果**：{f['impact']['consequence']}",
              f"- **影响范围**：{f['impact']['scope']}", f"- **触发条件**：{f['impact']['trigger']}", "\n**解决方案**："]
    for solution in f["solutions"]:
        parts.append(solution["description"])
        if solution.get("code"):
            parts.append(code_block(solution["code"]))
    if f.get("prevention"):
        parts += ["\n**预防措施**：", *["- " + x for x in f["prevention"]]]
    return "\n\n".join(parts)
