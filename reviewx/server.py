import json
import mimetypes
import re
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from .security import AppError, inside, redact
from .store import dump


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, service, dev=False):
        self.service = service
        self.csrf = secrets.token_urlsafe(32)
        self.dev = dev
        self.assets = Path(__file__).parent / "web"
        super().__init__(("127.0.0.1", service.config["port"]), Handler)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, payload, kind="application/json; charset=utf-8"):
        raw = payload if isinstance(payload, bytes) else dump(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def guard(self, mutation=False):
        address = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get("Host") != address:
            raise AppError("请求主机无效", "FORBIDDEN", 403)
        origins = {"http://" + address}
        if self.server.dev:
            origins.add("http://127.0.0.1:5173")
        origin, referer = self.headers.get("Origin"), self.headers.get("Referer")
        if origin and origin not in origins:
            raise AppError("请求来源无效", "FORBIDDEN", 403)
        if referer:
            parts = urlsplit(referer)
            if f"{parts.scheme}://{parts.netloc}" not in origins:
                raise AppError("请求来源无效", "FORBIDDEN", 403)
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise AppError("拒绝跨站请求", "FORBIDDEN", 403)
        if mutation:
            if not secrets.compare_digest(self.headers.get("X-ReviewX-CSRF", ""), self.server.csrf):
                raise AppError("请求校验失效，请刷新页面", "FORBIDDEN", 403)
            if self.headers.get_content_type() != "application/json":
                raise AppError("请求需要 application/json", "INVALID_ARGUMENT", 415)

    def do_GET(self):
        try:
            self.guard()
            url = urlsplit(self.path)
            path = unquote(url.path)
            service = self.server.service
            if path == "/api/health":
                return self.send(200, {"app": "ReviewX", "version": "0.1.0"})
            if path == "/api/state":
                return self.send(200, {**service.snapshot(), "csrf": self.server.csrf})
            if match := re.fullmatch(r"/api/projects/([1-9]\d*)/mrs/([1-9]\d*)", path):
                return self.send(200, service.detail(*match.groups()))
            if path == "/api/rules":
                rules, unassigned = service.rules.list()
                return self.send(200, {"rules": rules, "unassigned": unassigned})
            if path == "/api/logs":
                query = parse_qs(url.query)
                return self.send(200, {"logs": service.log.read(query.get("date", [None])[0])})
            if path.startswith("/api/"):
                raise AppError("接口不存在", "NOT_FOUND", 404)
            asset = inside(self.server.assets, "index.html" if path == "/" else path.lstrip("/"))
            if not asset.is_file():
                raise AppError("页面不存在，请先运行 npm run build", "NOT_FOUND", 404)
            return self.send(200, asset.read_bytes(), mimetypes.guess_type(asset.name)[0] or "application/octet-stream")
        except AppError as exc:
            self.send(exc.status, {"error": str(exc), "code": exc.code})
        except Exception as exc:
            self.server.service.log.log("ERROR", "读取失败", error_type=type(exc).__name__)
            self.send(500, {"error": "本地读取失败，请查看会话日志"})

    def do_POST(self):
        try:
            self.guard(mutation=True)
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if not isinstance(data, dict):
                raise AppError("请求应为 JSON 对象")
            path = urlsplit(self.path).path
            service = self.server.service
            result = {"ok": True}
            if path == "/api/projects":
                result = service.add_project(data.get("id", ""))
            elif path == "/api/fetch":
                service.fetch(data.get("project_id"))
            elif path == "/api/reviews":
                result = service.enqueue(str(data.get("project_id", "")), str(data.get("iid", "")))
            elif match := re.fullmatch(r"/api/reviews/([a-f0-9]+)/stop", path):
                service.stop(match[1])
            elif match := re.fullmatch(r"/api/projects/([1-9]\d*)/(remove|clear-cache)", path):
                if match[2] == "remove":
                    service.remove_project(match[1], data.get("confirmed"))
                else:
                    service.clear_cache(match[1])
            elif match := re.fullmatch(r"/api/reports/([a-f0-9]+)/findings/([a-f0-9]+)/action", path):
                service.decide(match[1], match[2], data.get("action"))
            elif match := re.fullmatch(r"/api/reports/([a-f0-9]+)/dismiss", path):
                service.dismiss_remaining(match[1], data.get("confirmed"))
            elif path == "/api/rules":
                result = service.rules.save(data)
            elif match := re.fullmatch(r"/api/rules/([A-Za-z0-9_-]+)/(save|delete)", path):
                if match[2] == "save":
                    result = service.rules.save(data, match[1])
                else:
                    service.rules.delete(match[1])
            else:
                raise AppError("接口不存在", "NOT_FOUND", 404)
            self.send(200, result)
        except AppError as exc:
            self.send(exc.status, {"error": str(exc), "code": exc.code})
        except (ValueError, TypeError, KeyError):
            self.send(400, {"error": "请求字段格式无效"})
        except Exception as exc:
            self.server.service.log.log("ERROR", "操作失败", error_type=type(exc).__name__)
            self.send(500, {"error": "本地操作失败，请查看会话日志；未确认的发送请到 CodeHub 核对"})
