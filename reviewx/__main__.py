import argparse
import ctypes
import json
import os
import signal
import sqlite3
import sys
import tempfile
import threading
import urllib.request
import webbrowser
from pathlib import Path
from .config import load_config, DEFAULT_CONFIG
from .security import AppError


def main():
    parser = argparse.ArgumentParser(description="ReviewX · 个人代码检视")
    parser.add_argument("--config", help="JSON 配置文件路径")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--dev", action="store_true", help="允许本机 Vite 开发服务器来源")
    args = parser.parse_args()
    mutex = None
    instance = Path(tempfile.gettempdir()) / "reviewx-instance.json"
    server = service = None
    try:
        config = load_config(args.config)
        if os.name == "nt":
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
            kernel.CreateMutexW.restype = ctypes.c_void_p
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            mutex = kernel.CreateMutexW(None, False, "Local\\ReviewX.PersonalCodeReview")
            if not mutex:
                raise AppError("无法创建 ReviewX 单实例锁")
            if ctypes.get_last_error() == 183:
                try:
                    existing = json.loads(instance.read_text("utf-8"))
                    url = f"http://127.0.0.1:{int(existing['port'])}"
                    with urllib.request.urlopen(url + "/api/health", timeout=3) as response:
                        if json.load(response).get("app") != "ReviewX":
                            raise ValueError()
                    print(f"ReviewX 已在运行：{url}")
                    if not args.no_browser:
                        webbrowser.open(url)
                    return
                except (OSError, ValueError, KeyError):
                    raise AppError("ReviewX 已在启动或停止中，请稍后重试")
        from .service import Service
        from .server import Server
        service = Service(config)
        try:
            server = Server(service, args.dev)
        except OSError as exc:
            raise AppError(f"端口 {config['port']} 已被占用，请在配置文件中更换端口") from exc
        instance.write_text(json.dumps({"port": config["port"], "pid": os.getpid()}), encoding="utf-8")
        url = f"http://127.0.0.1:{config['port']}"
        print(f"ReviewX 已启动：{url}\n配置文件：{args.config or DEFAULT_CONFIG}\n诊断日志：{service.log.path}\n按 Ctrl+C 停止服务。", flush=True)
        if not args.no_browser:
            try:
                webbrowser.open(url)
            except Exception:
                print("浏览器未能打开，请手动访问上述地址。", flush=True)
        def shutdown(*_):
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGINT, shutdown)
        signal.signal(signal.SIGTERM, shutdown)
        server.serve_forever(poll_interval=.2)
    except (AppError, ValueError, OSError, sqlite3.Error) as exc:
        print(f"ReviewX 启动失败：{exc}", file=sys.stderr)
        return 1
    finally:
        if server:
            server.server_close()
        if service:
            service.close()
            service.store.db.close()
            instance.unlink(missing_ok=True)
        if mutex:
            kernel.CloseHandle(mutex)
    return 0


if __name__ == "__main__":
    sys.exit(main())
