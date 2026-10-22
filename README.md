# ReviewX

个人 CodeHub 代码检视应用，在本机浏览器中查看 MR、发起 AI 检视并管理检视规则。每条意见由你确认后才会发布到 CodeHub。

## 部署前准备

Windows 和 Linux 均使用下方脚本部署。请先安装：

- [Python 3.9.11](https://www.python.org/downloads/release/python-3911/)（须为此版本，并包含 pip、venv）。
- [Node.js](https://nodejs.org/) 22 或更高版本（包含 npm）、[Git](https://git-scm.com/)。
- [CodeHub CLI](https://github.com/BlackLotusAL/CodeHubX)，完成登录，并确认 Git 可以访问要检视的仓库。
- [OpenCode](https://opencode.ai/)，完成登录并配置默认模型。

将这些命令加入 PATH，重新打开终端。下载本仓库并解压，或使用 Git 克隆到本机。

## 一键部署

在 ReviewX 文件夹中打开终端，执行对应系统的命令。首次部署需要联网，脚本会自动安装应用依赖、构建界面并启动 ReviewX。

**Windows（PowerShell）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1
```

**Linux（Bash）**

```bash
bash deploy.sh
```

启动后访问 [http://127.0.0.1:17080](http://127.0.0.1:17080)。应用仅供本机访问；关闭网页不会停止应用，在启动终端按 `Ctrl+C` 停止。

以后启动时，在 ReviewX 文件夹中执行：

| 系统 | 启动命令 |
| --- | --- |
| Windows | `.\.venv\Scripts\reviewx.exe` |
| Linux | `.venv/bin/reviewx` |

更新应用时，先停止应用，更新仓库文件，再运行同一个部署脚本。项目、报告与规则保存在用户数据目录中。

## 开始使用

1. 添加需要关注的数字 Project ID，点击「获取 MR」。
2. 选择 MR 发起检视，完成后查看报告。
3. 逐条选择发送或不发送意见；可在「规则管理」中调整检视规则。

## 前端预览

启动应用后访问 [前端预览页](http://127.0.0.1:17080/preview.html)。顶部可切换工作台、报告、检视进度、失败、规则、日志和空页面等场景，也可重置演示数据。

预览页复用正式界面，所有操作仅修改当前页面内存中的演示数据，不访问业务 API，不需要 CodeHub 或 OpenCode。刷新、切换场景或重置会恢复示例。外部 CodeHub 链接不启用。

只开发前端时，在安装 npm 依赖后运行 `npm run preview`，即可打开 `http://127.0.0.1:5173/preview.html`，无需启动 Python 服务。场景可以通过链接直接打开，例如 `/preview.html#report`。

## 常见问题

- **未找到 Python 3.9.11**：安装指定版本，或将环境变量 `REVIEWX_PYTHON` 设为其可执行文件的完整路径后重试。
- **原有环境版本不符**：停止应用，将 ReviewX 文件夹中的 `.venv` 重命名后重新部署。
- **依赖下载失败**：检查网络或代理设置，恢复连接后重新运行部署脚本。
- **无法获取 MR 或检视失败**：检查 CodeHub CLI、Git 和 OpenCode 的登录、网络及仓库权限；详细原因可在「运行日志」中查看。
- **修改端口或数据位置**：参考 [配置示例](reviewx.example.json)，保存至 Windows 的 `%APPDATA%\ReviewX\config.json` 或 Linux 的 `~/.config/ReviewX/config.json`，重启生效。默认数据目录分别为 `%LOCALAPPDATA%\ReviewX` 和 `~/.local/share/ReviewX`。
