"""Deterministic executable fixture exercising real subprocess + HTTP MCP transport."""
import json
import os
import sys
import urllib.request

if "--version" in sys.argv:
    print("1.18.31")
    sys.exit(0)
config = json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])
mcp = config["mcp"]["reviewx"]


def rpc(method, params=None):
    payload = dict(jsonrpc="2.0", id=1, method=method, params=params or {})
    request = urllib.request.Request(mcp["url"], json.dumps(payload).encode(), headers={
        "Content-Type": "application/json", **mcp["headers"]})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)["result"]


assert config["permission"]["*"] == "deny"
assert "GIT_ASKPASS" not in os.environ
assert "--pure" in sys.argv
print(json.dumps({"type": "step_start", "sessionID": "fixture-session", "part": {"model": "fixture/local-model"}}), flush=True)
rpc("initialize")
tools = rpc("tools/list")["tools"]
if "unauthorized" in sys.argv:
    print(json.dumps({"type": "tool_use", "part": {"tool": "bash"}}), flush=True)
    sys.exit(0)
if "wrap" in sys.argv and "--session" not in sys.argv:
    print(json.dumps({"type": "text", "part": {"text": "本轮结束但未提交"}}), flush=True)
    sys.exit(0)
if "--session" in sys.argv:
    assert not any(t["name"] in ("read", "glob", "grep") for t in tools)
result = rpc("tools/call", {"name": "finish_review", "arguments": {}})
assert not result.get("isError"), result
print(json.dumps({"type": "step_finish", "part": {"reason": "stop", "tokens": {"input": 1000, "cache": {"read": 0}}}}), flush=True)
