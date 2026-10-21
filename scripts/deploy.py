"""Shared user deployment for Windows and Linux; run through deploy.ps1/deploy.sh."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
VERSION = (3, 9, 11)


def run(command, capture=False):
    result = subprocess.run([str(item) for item in command], cwd=ROOT, check=True,
                            stdout=subprocess.PIPE if capture else None,
                            encoding="utf-8", errors="replace")
    return result.stdout.strip() if capture else None


def node_commands():
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        raise RuntimeError("请安装 Node.js 22 或更高版本（包含 npm），然后重新打开终端。")
    if int(run([node, "-p", "process.versions.node.split('.')[0]"], capture=True)) < 22:
        raise RuntimeError("Node.js 版本过低，请安装 22 或更高版本。")
    # Invoke npm through Node on Windows, avoiding cmd.exe quoting of user paths.
    if os.name == "nt":
        for folder in (Path(npm).parent, Path(node).parent):
            cli = folder / "node_modules/npm/bin/npm-cli.js"
            if cli.is_file():
                return [node, str(cli)]
        raise RuntimeError("找不到 npm-cli.js，请重新安装包含 npm 的 Node.js。")
    return [npm]


def prepare_environment():
    environment = ROOT / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if environment.exists():
        if not python.is_file():
            raise RuntimeError(".venv 不完整，请停止应用，将其重命名后重新部署。")
        version = run([python, "-c", "import platform; print(platform.python_version())"], capture=True)
        if version != "3.9.11":
            raise RuntimeError(".venv 的 Python 版本不符，请停止应用，将其重命名后重新部署。")
    else:
        print("[1/4] 创建 Python 3.9.11 应用环境…", flush=True)
        run([sys.executable, "-m", "venv", environment])
    run([python, "-m", "pip", "--version"])
    return python


def main(argv=None):
    parser = argparse.ArgumentParser(description="部署并启动 ReviewX")
    parser.add_argument("--no-start", action="store_true", help="部署完成后不启动")
    parser.add_argument("--no-browser", action="store_true", help="启动时不打开浏览器")
    parser.add_argument("--config", help="启动时使用指定配置文件")
    args = parser.parse_args(argv)
    try:
        if sys.version_info[:3] != VERSION:
            raise RuntimeError("请使用 Python 3.9.11 运行部署脚本。")
        if not shutil.which("git"):
            raise RuntimeError("请先安装 Git 并加入 PATH。")
        npm = node_commands()
        python = prepare_environment()
        print("[2/4] 安装界面依赖并构建…", flush=True)
        run([*npm, "ci", "--include=dev", "--no-audit", "--no-fund"])
        run([*npm, "run", "build"])
        print("[3/4] 安装 ReviewX…", flush=True)
        run([python, "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", str(ROOT)])
        run([python, "-m", "pip", "check"])
        print("[4/4] 部署完成。", flush=True)
        for name in ("codehub", "opencode"):
            if not shutil.which(name):
                print(f"提示：尚未找到 {name}，使用检视功能前请安装并完成登录。", flush=True)
        if not args.no_start:
            command = [str(python), "-I", "-m", "reviewx"]
            if args.no_browser:
                command.append("--no-browser")
            if args.config:
                command.extend(["--config", str(Path(args.config).resolve())])
            # Keep the deployment terminal attached to the app for Ctrl+C shutdown.
            with subprocess.Popen(command) as process:
                try:
                    return process.wait()
                except KeyboardInterrupt:
                    return process.wait()
        return 0
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"部署失败：{exc}\n修正上述问题后重新运行部署脚本。", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("部署已取消。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
