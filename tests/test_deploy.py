import contextlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import deploy


class DeploymentCase(unittest.TestCase):
    def test_wrong_python_stops_before_changes(self):
        with patch.object(deploy.sys, "version_info", (3, 12, 0)), \
                patch.object(deploy, "prepare_environment") as prepare, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(deploy.main(["--no-start"]), 1)
        prepare.assert_not_called()
        self.assertIn("3.9.11", errors.getvalue())

    def test_existing_wrong_environment_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            executable = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"existing environment")
            with patch.object(deploy, "ROOT", root), patch.object(deploy, "run", return_value="3.12.0"):
                with self.assertRaisesRegex(RuntimeError, "版本不符"):
                    deploy.prepare_environment()
            self.assertEqual(executable.read_bytes(), b"existing environment")

    def test_failed_frontend_build_does_not_install_or_start(self):
        commands = []

        def run(command, **kwargs):
            commands.append(command)
            if command[-2:] == ["run", "build"]:
                raise subprocess.CalledProcessError(1, command)

        with patch.object(deploy.sys, "version_info", (3, 9, 11)), \
                patch.object(deploy.shutil, "which", return_value="tool"), \
                patch.object(deploy, "node_commands", return_value=["npm"]), \
                patch.object(deploy, "prepare_environment", return_value=Path("python")), \
                patch.object(deploy, "run", side_effect=run), \
                patch.object(deploy.subprocess, "Popen") as start, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(deploy.main([]), 1)
        start.assert_not_called()
        self.assertFalse(any("pip" in command for command in commands))

    def test_no_start_installs_but_does_not_launch(self):
        with patch.object(deploy.sys, "version_info", (3, 9, 11)), \
                patch.object(deploy.shutil, "which", return_value="tool"), \
                patch.object(deploy, "node_commands", return_value=["npm"]), \
                patch.object(deploy, "prepare_environment", return_value=Path("python")), \
                patch.object(deploy, "run") as run, \
                patch.object(deploy.subprocess, "Popen") as start, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(deploy.main(["--no-start"]), 0)
        start.assert_not_called()
        self.assertTrue(any("install" in call.args[0] for call in run.call_args_list))
        self.assertEqual(run.call_args_list[-1].args[0][-3:], ["-m", "pip", "check"])
