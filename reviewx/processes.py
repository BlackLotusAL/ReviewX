import json
import os
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from .security import AppError, redact


def resolve_command(command):
    """Avoid cmd.exe: npm shims are resolved to their actual node/native entry point."""
    executable = shutil.which(command[0]) or command[0]
    path = Path(executable)
    if os.name == "nt" and path.suffix.lower() in (".cmd", ".bat", ".ps1"):
        name = path.stem
        if name == "opencode":
            native = path.parent / "node_modules/opencode-ai/bin/opencode.exe"
            if native.exists():
                return [str(native), *command[1:]]
        modules = path.parent / "node_modules"
        candidates = list(modules.glob("*/package.json")) + list(modules.glob("@*/*/package.json"))
        for package in candidates:
            try:
                data = json.loads(package.read_text("utf-8"))
                binary = data.get("bin", {})
                entry = binary.get(name) if isinstance(binary, dict) else binary if data.get("name", "").split("/")[-1] == name else None
                if entry:
                    return [shutil.which("node") or "node", str(package.parent / entry), *command[1:]]
            except (ValueError, OSError):
                continue
        raise AppError(f"无法安全运行 {name} 的命令脚本，请在配置文件中指定可执行文件参数数组", "CONFIG_ERROR", environment=True)
    return [str(path), *command[1:]]


class Processes:
    def __init__(self):
        self.lock = threading.RLock()
        self.running = {}
        self.closed = False

    def spawn(self, command, owner, cwd=None, env=None):
        with self.lock:
            if self.closed:
                raise AppError("服务正在停止", "CANCELLED")
            try:
                process = subprocess.Popen(resolve_command(command), cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                                           start_new_session=os.name != "nt")
            except OSError as exc:
                raise AppError(f"无法启动 {Path(command[0]).name}，请检查安装和命令配置", "CONFIG_ERROR", environment=True) from exc
            self.running[process] = owner
            return process

    def kill(self, process):
        if process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()

    def cancel(self, owner=None):
        with self.lock:
            targets = [p for p, key in self.running.items() if owner is None or owner == key]
        for process in targets:
            self.kill(process)

    def release(self, process):
        with self.lock:
            self.running.pop(process, None)

    def run(self, command, owner="operation", cwd=None, env=None, cancel=None, timeout=120):
        if cancel and cancel.is_set():
            raise AppError("主动停止", "CANCELLED")
        process = self.spawn(command, owner, cwd, env)
        started = time.monotonic()
        try:
            while True:
                try:
                    stdout, stderr = process.communicate(timeout=.15)
                    break
                except subprocess.TimeoutExpired:
                    if cancel and cancel.is_set():
                        self.kill(process)
                        raise AppError("主动停止", "CANCELLED")
                    if time.monotonic() - started > timeout:
                        self.kill(process)
                        raise AppError("命令超时，请检查网络后手动重试", "TIMEOUT", environment=True)
            if cancel and cancel.is_set():
                raise AppError("主动停止", "CANCELLED")
            return process.returncode, stdout, stderr
        finally:
            self.kill(process)
            self.release(process)


class CodeHub:
    def __init__(self, config, processes):
        self.command, self.processes = config["codehub_command"], processes

    def call(self, args, owner="codehub", cancel=None, write=False):
        try:
            code, out, err = self.processes.run([*self.command, *args, "--output", "json"], owner, cancel=cancel)
        except AppError as exc:
            if write and exc.code in ("TIMEOUT", "CANCELLED"):
                raise AppError("评论发送中断，结果未知，请到 CodeHub 核对", "WRITE_RESULT_UNKNOWN") from exc
            raise
        if code:
            try:
                result = json.loads(err)
                error = result["code"]
            except (ValueError, KeyError, TypeError):
                raise AppError("CodeHub CLI 未返回有效结果" + ("，请到 CodeHub 核对" if write else ""),
                               "WRITE_RESULT_UNKNOWN" if write else "CLI_ERROR")
            messages = {"AUTH_ERROR": "CodeHub CLI 未登录，请在终端重新登录",
                        "CONFIG_ERROR": "CodeHub CLI 配置不可用，请检查配置",
                        "NETWORK_ERROR": "网络不可用，请检查网络后手动重试",
                        "WRITE_RESULT_UNKNOWN": "发送结果未知，请到 CodeHub 核对",
                        "HTTP_ERROR": "项目不存在、无访问权限或 CodeHub 请求失败",
                        "INVALID_ARGUMENT": "CodeHub CLI 参数无效，请检查版本与配置",
                        "CANCELLED": "CodeHub 操作已取消"}
            raise AppError(messages.get(error, "CodeHub CLI 执行失败"), error, environment=error in ("AUTH_ERROR", "NETWORK_ERROR", "CONFIG_ERROR"))
        try:
            return json.loads(out)
        except ValueError as exc:
            raise AppError("CodeHub CLI 输出格式无效", "WRITE_RESULT_UNKNOWN" if write else "CLI_ERROR") from exc

    def project(self, pid, **kwargs):
        data = self.call(["repo", "view", pid], **kwargs)
        if not isinstance(data, dict) or not data.get("full_name"):
            raise AppError("项目详情缺少仓库完整路径", "CLI_ERROR")
        return data

    def mr(self, pid, iid, **kwargs):
        return self.call(["mr", "view", iid, "--project-id", pid], **kwargs)

    def list_mrs(self, pid):
        return self.call(["mr", "list", "--project-id", pid, "--state", "open"])

    def publish(self, pid, iid, finding, body):
        result = self.call(["mr", "comment", "create", iid, "--project-id", pid, "--body", body,
                           "--severity", finding["severity"]], owner="publish", write=True)
        if not isinstance(result, dict) or not result.get("comment_id"):
            raise AppError("CLI 未返回评论标识，请到 CodeHub 核对", "WRITE_RESULT_UNKNOWN")
        return {"comment_id": str(result["comment_id"])}
