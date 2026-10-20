import http.client
import json
import threading
import unittest
from reviewx.server import Server
import test_core


class HTTPCase(test_core.ServiceCase):
    # Separate HTTP tests, using the same isolated fixture.
    def setUp(self):
        super().setUp()
        self.s.config["port"] = 0
        self.http = Server(self.s)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        super().tearDown()

    def request(self, path, method="GET", body=None, **headers):
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=5)
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, json.loads(payload)

    def test_http_source_csrf_and_host_guards(self):
        status, state = self.request("/api/state")
        self.assertEqual(status, 200)
        status, _ = self.request("/api/projects", "POST", {"id": "102"}, **{"Content-Type": "application/json"})
        self.assertEqual(status, 403)
        for headers in ({"Origin": "https://evil.example"}, {"Host": "evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("/api/state", **headers)[0], 403)
        headers = {"Content-Type": "application/json", "X-ReviewX-CSRF": state["csrf"]}
        self.assertEqual(self.request("/api/projects", "POST", {"id": "102"}, **headers)[0], 200)
        self.assertEqual(self.request("/api/projects", "POST", [], **headers)[0], 400)

    def test_http_traversal_and_no_file_api(self):
        for path in ("/../pyproject.toml", "/%2e%2e/pyproject.toml", "/api/files?path=C:/Windows/win.ini"):
            self.assertIn(self.request(path)[0], (403, 404))


# Do not duplicate the base-class business suite here.
for name in list(vars(test_core.ServiceCase)):
    if name.startswith("test_"):
        setattr(HTTPCase, name, None)
