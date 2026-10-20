import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from reviewx.config import load_config
from reviewx.diagnostics import Diagnostics
from reviewx.git import Git
from reviewx.opencode import OpenCode
from reviewx.processes import Processes
from reviewx.security import AppError
from helpers import project

ROOT = Path(__file__).resolve().parents[1] / ".reviewx-tests"


class RuntimeCase(unittest.TestCase):
    def setUp(self):
        ROOT.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT, prefix="运行 测试 ")
        self.root = Path(self.temp.name)
        self.config = load_config(overrides={"data_dir": str(self.root)})
        self.processes = Processes()

    def tearDown(self):
        self.processes.cancel()
        self.temp.cleanup()

    def test_real_git_three_dot_function_context_binary_and_full_snapshot(self):
        repo = self.root / "repo"
        repo.mkdir()
        def git(*args):
            result = subprocess.run(["git", "-c", "core.longpaths=true", *args], cwd=repo, check=True, capture_output=True)
            return result.stdout.decode().strip()
        git("init", "-b", "main")
        git("config", "user.email", "test@example.invalid")
        git("config", "user.name", "Test")
        (repo / "source.py").write_text("def test():\n    first = 1\n    return first\n", encoding="utf-8")
        (repo / ".gitattributes").write_text("keep.txt export-ignore\n", encoding="utf-8")
        (repo / "keep.txt").write_text("full snapshot", encoding="utf-8")
        git("add", "."); git("commit", "-m", "base")
        base = git("rev-parse", "HEAD")
        git("checkout", "-b", "feature")
        (repo / "source.py").write_text("def test():\n    first = 2\n    return first\n", encoding="utf-8")
        (repo / "yarn.lock").write_text("lock", encoding="utf-8")
        (repo / "binary.dat").write_bytes(b"binary\0content")
        git("add", "."); git("commit", "-m", "source changes")
        source = git("rev-parse", "HEAD")
        git("checkout", "main")
        (repo / "target-only.txt").write_text("not part of source", encoding="utf-8")
        git("add", "."); git("commit", "-m", "target changes")
        target = git("rev-parse", "HEAD")
        engine = Git(self.config, self.processes, self.root)
        cache = engine.cache("101")
        subprocess.run(["git", "clone", "--bare", str(repo), str(cache)], capture_output=True, check=True)
        (cache / "info").mkdir(exist_ok=True)
        (cache / "info/attributes").write_text("* -export-ignore -export-subst\n")
        diffs, skipped, commits, copy = engine.snapshot(project(), source, target, "test", threading.Event(), lambda *_: None)
        self.assertNotIn("target-only.txt", diffs)
        self.assertIn("def test():", diffs["source.py"])
        self.assertIn("return first", diffs["source.py"])
        self.assertEqual({x["path"] for x in skipped}, {"yarn.lock", "binary.dat"})
        self.assertTrue((copy / "keep.txt").exists())
        self.assertTrue((copy / "yarn.lock").exists())
        self.assertFalse((copy / ".git").exists())
        self.assertIn("source changes", commits)
        self.assertNotIn("target changes", commits)
        engine.clean(copy)
        self.assertFalse(copy.exists())
        with self.assertRaises(AppError):
            engine.clean(repo)

    def run_session(self, mode=""):
        command = [sys.executable, str(Path(__file__).parent / "fake_opencode.py")]
        if mode:
            command.append(mode)
        self.config["opencode_command"] = command
        ai = OpenCode(self.config, self.processes, Diagnostics(self.root))
        copy = self.root / "tmp" / "copy"
        copy.mkdir(parents=True)
        try:
            ai.version("test", threading.Event())
            return ai.session("search", copy, "中文长提示词\n" + "a" * 40000, [], "test",
                              threading.Event(), threading.Event(), time.monotonic())
        finally:
            ai.close()

    def test_opencode_transport_finishes_through_mcp(self):
        submission, model = self.run_session()
        self.assertTrue(submission.finished)
        self.assertEqual(model, "fixture/local-model")
        self.assertEqual(list((self.root / "tmp").glob("*.prompt.txt")), [])

    def test_opencode_wraps_same_session_once_with_read_tools_closed(self):
        submission, _ = self.run_session("wrap")
        self.assertTrue(submission.finished)
        self.assertTrue(submission.wrapping)

    def test_opencode_unauthorized_tool_fails(self):
        with self.assertRaises(AppError) as error:
            self.run_session("unauthorized")
        self.assertEqual(error.exception.code, "UNAUTHORIZED_TOOL")
