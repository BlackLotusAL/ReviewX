import json
import os
from pathlib import Path

EXCLUDES = [
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock",
    ".min.js", ".min.css", ".map", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico",
    ".webp", ".svg", ".ttf", ".otf", ".woff", ".woff2", ".eot",
]
DEFAULT_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")) / "ReviewX"
DEFAULT_CONFIG = Path(os.environ.get("APPDATA", Path.home() / ".config")) / "ReviewX/config.json"
DEFAULTS = dict(
    port=17080, data_dir=str(DEFAULT_DIR), concurrency=6, excluded_files=EXCLUDES,
    context_limit=262144, output_language="中文",
    focus_areas=["逻辑与状态", "边界与错误处理", "接口与一致性", "测试与体验"],
    shard_ratio=.20, search_parallel=8, verify_parallel=4,
    search_wrap_seconds=300, verify_wrap_seconds=600, opencode_timeout=720,
    reading_ratio=.25, safety_ratio=.75,
    codehub_command=["codehub"], opencode_command=["opencode"], git_command=["git"],
)


def load_config(path=None, overrides=None):
    config = DEFAULTS.copy()
    source = Path(path) if path else DEFAULT_CONFIG
    if source.exists():
        try:
            data = json.loads(source.read_text("utf-8-sig"))
        except (ValueError, OSError) as exc:
            raise ValueError(f"配置文件无法读取：{source}（{type(exc).__name__}）") from exc
        if not isinstance(data, dict):
            raise ValueError("配置文件根节点应为对象")
        if unknown := set(data) - set(DEFAULTS):
            raise ValueError(f"未知配置项：{', '.join(sorted(unknown))}")
        config.update(data)
    config.update(overrides or {})
    for name in ("port", "concurrency", "context_limit", "search_parallel", "verify_parallel",
                 "search_wrap_seconds", "verify_wrap_seconds", "opencode_timeout"):
        if type(config[name]) is not int or config[name] <= 0:
            raise ValueError(f"配置项 {name} 应为正整数")
    if config["port"] > 65535:
        raise ValueError("配置项 port 应在 1–65535 之间")
    for name in ("shard_ratio", "reading_ratio", "safety_ratio"):
        if type(config[name]) not in (float, int) or not 0 < config[name] < 1:
            raise ValueError(f"配置项 {name} 应大于 0 且小于 1")
    if config["context_limit"] * (1 - config["safety_ratio"]) <= 32768:
        raise ValueError("配置项 safety_ratio：安全上限 + 32K 输出须低于 context_limit")
    if not config["search_wrap_seconds"] + 120 <= config["verify_wrap_seconds"] < config["opencode_timeout"]:
        raise ValueError("收尾时间须满足 search_wrap_seconds + 120 ≤ verify_wrap_seconds < opencode_timeout")
    for name in ("excluded_files", "focus_areas", "codehub_command", "opencode_command", "git_command"):
        value = config[name]
        if not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
            raise ValueError(f"配置项 {name} 应为非空字符串数组")
        if name != "excluded_files" and not value:
            raise ValueError(f"配置项 {name} 不可为空")
    if any("/" in x or "\\" in x for x in config["excluded_files"]):
        raise ValueError("excluded_files 只允许扩展名或文件名，不允许目录")
    for name in ("data_dir", "output_language"):
        if not isinstance(config[name], str) or not config[name].strip():
            raise ValueError(f"配置项 {name} 应为非空字符串")
    config["data_dir"] = str(Path(config["data_dir"]).expanduser().resolve())
    return config
