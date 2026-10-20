import io
import os
import re
import shutil
import tarfile
from pathlib import Path
from urllib.parse import urlsplit
from .security import AppError, excluded, inside, relative_path


class Git:
    def __init__(self, config, processes, root):
        self.config, self.processes, self.root = config, processes, root
        (root / "cache").mkdir(exist_ok=True)
        (root / "tmp").mkdir(exist_ok=True)

    def run(self, args, owner, cancel, cwd=None, binary=False):
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        code, out, err = self.processes.run([*self.config["git_command"], "-c", "core.longpaths=true",
                                           "-c", "core.hooksPath=NUL" if os.name == "nt" else "core.hooksPath=/dev/null",
                                           *args], owner, cwd, env, cancel, timeout=180)
        if code:
            error = err.decode("utf-8", "replace").lower()
            if any(x in error for x in ("authentication", "permission denied", "could not read username", "host key verification")):
                raise AppError("Git 认证失败，请在终端配置本机 Git 凭据", "AUTH_ERROR", environment=True)
            if any(x in error for x in ("could not resolve", "failed to connect", "timed out", "unable to access")):
                raise AppError("Git 网络不可用，请检查网络连接", "NETWORK_ERROR", environment=True)
            if any(x in error for x in ("corrupt", "bad object", "not a git repository", "invalid object")):
                raise AppError("代码缓存损坏，请在关注项目菜单中清除代码缓存", "CACHE_CORRUPT")
            raise AppError("Git 操作失败，请检查分支是否存在、仓库地址和权限", "GIT_ERROR")
        return out if binary else out.decode("utf-8", "replace").strip()

    def cache(self, pid):
        return inside(self.root / "cache", pid + ".git")

    def clone_url(self, project):
        urls = project.get("clone_urls") or {}
        if isinstance(urls, dict):
            url = urls.get("ssh") or urls.get("https") or urls.get("http")
        elif isinstance(urls, list):
            url = next((x for x in urls if isinstance(x, str)), None)
        else:
            url = urls if isinstance(urls, str) else None
        if not url or url.startswith("-") or "\n" in url:
            raise AppError("项目缺少可用的 clone_urls", "CLI_ERROR")
        parsed = urlsplit(url)
        if parsed.scheme in ("https", "http", "ssh"):
            if parsed.password or (parsed.scheme != "ssh" and parsed.username):
                raise AppError("仓库地址不可包含凭据，请配置 Git Credential Helper", "AUTH_ERROR", environment=True)
        elif not re.match(r"[\w.-]+@[\w.-]+:[^\s]+$", url):
            raise AppError("只支持 HTTPS / SSH 仓库地址", "CLI_ERROR")
        return url

    def fetch(self, project, branch, side, owner, cancel):
        cache = self.cache(project["id"])
        self.run(["check-ref-format", "refs/heads/" + branch], owner, cancel)
        url = self.clone_url(project)
        if not cache.exists():
            self.run(["init", "--bare", str(cache)], owner, cancel)
            self.run(["config", "remote.origin.url", url], owner, cancel, cache)
            self.run(["config", "remote.origin.promisor", "true"], owner, cancel, cache)
            self.run(["config", "remote.origin.partialclonefilter", "blob:none"], owner, cancel, cache)
        # Include files marked export-ignore in release archives.
        (cache / "info").mkdir(exist_ok=True)
        (cache / "info/attributes").write_text("* -export-ignore -export-subst\n", encoding="utf-8")
        ref = "refs/reviewx/" + side
        self.run(["fetch", "--no-tags", "--filter=blob:none", "--force", "--", url,
                  f"+refs/heads/{branch}:{ref}"], owner, cancel, cache)
        return self.run(["rev-parse", "--verify", ref + "^{commit}"], owner, cancel, cache)

    def snapshot(self, project, source, target, owner, cancel, progress):
        cache = self.cache(project["id"])
        base = self.run(["merge-base", target, source], owner, cancel, cache)
        paths = self.run(["diff", "--name-only", "-z", base, source, "--"], owner, cancel, cache, binary=True).decode("utf-8", "replace").split("\0")
        paths = [p for p in paths if p]
        kept, skipped = {}, []
        for index, path in enumerate(paths):
            relative_path(path)
            progress(index + 1, len(paths))
            if excluded(path, self.config["excluded_files"]):
                skipped.append({"path": path, "reason": "排除文件类型"})
                continue
            stat = self.run(["diff", "--numstat", base, source, "--", path], owner, cancel, cache)
            if stat.startswith("-\t-"):
                skipped.append({"path": path, "reason": "二进制文件"})
                continue
            diff = self.run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--function-context",
                             base, source, "--", path], owner, cancel, cache)
            if diff:
                kept[path] = diff
        commits = self.run(["log", "--format=%B", f"{base}..{source}", "--"], owner, cancel, cache)
        copy = inside(self.root / "tmp", owner)
        copy.mkdir()
        # Export tracked files without .git, symlinks, executable project config, or credentials.
        archive = self.run(["archive", "--format=tar", source], owner, cancel, cache, binary=True)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            for member in tar:
                if not member.isfile():
                    continue
                name = relative_path(member.name)
                if Path(name).name.casefold() in (".gitconfig", ".git-credentials", ".gitmodules"):
                    continue
                destination = inside(copy, name)
                destination.parent.mkdir(parents=True, exist_ok=True)
                stream = tar.extractfile(member)
                if stream:
                    with destination.open("wb") as output:
                        shutil.copyfileobj(stream, output)
        return kept, skipped, commits, copy

    def clean(self, path):
        path = Path(path).resolve()
        allowed = [self.root / "tmp", self.root / "cache"]
        if not any(path != p.resolve() and path.is_relative_to(p.resolve()) for p in allowed):
            raise AppError("清理目标不在代码缓存或临时目录内", "FORBIDDEN", 403)
        if path.exists():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
