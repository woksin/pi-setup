import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "agent" / "bin" / "cratis-local-run"


class CratisLocalRunTests(unittest.TestCase):
    def run_script(self, *args, env_extra=None):
        with tempfile.TemporaryDirectory() as home:
            stub = Path(home) / ".pi" / "agent" / "bin" / "pi-phase"
            stub.parent.mkdir(parents=True)
            stub.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n')
            stub.chmod(0o755)
            env = {k: v for k, v in os.environ.items() if not k.startswith("CRATIS_LOCAL_RUN_")}
            env["HOME"] = home
            env.update(env_extra or {})
            return subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=30)

    def priority_of(self, result):
        lines = result.stdout.splitlines()
        return lines[lines.index("--priority") + 1]

    def test_default_priority_is_normal(self):
        r = self.run_script("build", "lbl", "--", "echo", "hi")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.priority_of(r), "normal")
        self.assertEqual(r.stdout.splitlines()[-3:], ["--", "echo", "hi"])

    def test_priority_flag_and_equals_form(self):
        self.assertEqual(self.priority_of(self.run_script("--priority", "low", "test", "lbl", "--", "x")), "low")
        self.assertEqual(self.priority_of(self.run_script("--priority=high", "test", "lbl", "--", "x")), "high")

    def test_env_default_and_flag_override(self):
        env = {"CRATIS_LOCAL_RUN_PRIORITY": "low"}
        self.assertEqual(self.priority_of(self.run_script("build", "lbl", "--", "x", env_extra=env)), "low")
        self.assertEqual(self.priority_of(self.run_script("--priority", "normal", "build", "lbl", "--", "x", env_extra=env)), "normal")

    def test_invalid_priority_and_usage(self):
        self.assertEqual(self.run_script("--priority", "urgent", "build", "lbl", "--", "x").returncode, 2)
        self.assertEqual(self.run_script("--priority").returncode, 2)
        self.assertEqual(self.run_script("build", "lbl", "x").returncode, 2)


if __name__ == "__main__":
    unittest.main()
