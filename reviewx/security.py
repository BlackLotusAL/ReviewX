import fnmatch
import re
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit


class AppError(Exception):
    def __init__(self, message, code="INVALID_ARGUMENT", status=400, environment=False):
        super().__init__(message)
        self.code, self.status, self.environment = code, status, environment


def positive_id(value):
    value = str(value)
    if not re.fullmatch(r"[1-9]\d*", value):
        raise AppError("Project ID / MR IID 应为正整数")
    return value


def redact(value):
    if isinstance(value, dict):
        return {k: "[已隐藏]" if re.search(r"(?i)(password|secret|token|authorization|credential|api.?key|appcode)", k)
                else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(x) for x in value]
    if not isinstance(value, str):
        return value
    value = re.sub(r"(?i)(https?://)[^/\s@]+@", r"\1[已隐藏]@", value)
    value = re.sub(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [已隐藏]", value)
    value = re.sub(r'(?i)((?:private[-_]?token|x-auth-token|password|secret|api[-_]?key|access[-_]?token|token|authorization|appcode)\s*["\']?\s*[:=]\s*["\']?)[^\s"\'&,}]+', r"\1[已隐藏]", value)
    value = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----", "[私钥已隐藏]", value)
    return value


def web_url(value):
    if not isinstance(value, str):
        return ""
    try:
        url = urlsplit(value)
        return value if url.scheme in ("https", "http") and url.hostname and not url.username and not url.password else ""
    except ValueError:
        return ""


def relative_path(value, allow_empty=False):
    if not isinstance(value, str) or "\x00" in value or "\\" in value or ":" in value:
        raise AppError("location.path 必须是仓库相对路径")
    if not value and allow_empty:
        return value
    p = PurePosixPath(value)
    if not value or p.is_absolute() or ".." in p.parts or any(x.casefold() == ".git" for x in p.parts):
        raise AppError("location.path 必须是仓库相对路径，不允许 .git 或上级目录")
    return value


def inside(root, value):
    root = Path(root).resolve()
    path = (root / value).resolve()
    if path == root or not path.is_relative_to(root):
        raise AppError("路径越出允许目录", "FORBIDDEN", 403)
    return path


def excluded(path, patterns):
    name = PurePosixPath(path.replace("\\", "/")).name.casefold()
    return any(name.endswith(p.casefold()) if p.startswith(".") else name == p.casefold() for p in patterns)


def matches(path, pattern):
    return (fnmatch.fnmatchcase(path, pattern) or
            ("/" not in pattern and fnmatch.fnmatchcase(PurePosixPath(path).name, pattern)) or
            (pattern.startswith("**/") and fnmatch.fnmatchcase(path, pattern[3:])))
