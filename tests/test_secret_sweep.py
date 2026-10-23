"""Read-only scanner tests. Credential fixtures are assembled only at runtime."""
from datetime import date
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "agent/bin/secret-sweep"
loader = importlib.machinery.SourceFileLoader("secret_sweep", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
sweep = importlib.util.module_from_spec(spec)
loader.exec_module(sweep)


class SecretSweepTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="secret-sweep-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.home = self.base / "home"
        self.root = self.base / "repos"
        self.work = self.root / "fixture/.ai-work"
        self.work.mkdir(parents=True)
        self.home.mkdir()
        self.env = {**os.environ, "HOME": str(self.home), "GITLEAKS_CONFIG": "",
                    "GITLEAKS_CONFIG_TOML": ""}
        self.secret = "gh" + "p_" + "9aQ2vX7nK4zR6bT8yW3mP5dF1jH0sL2cE4uN"

    def run_sweep(self, *args):
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), *args],
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertNotIn(self.secret, result.stdout + result.stderr)
        return result

    def report(self):
        report = self.home / f".pi/agent/logs/secret-sweep/{date.today().isoformat()}.md"
        text = report.read_text()
        self.assertNotIn(self.secret, text)
        return text

    def require_gitleaks(self):
        self.assertIsNotNone(shutil.which("gitleaks"), "gitleaks required for scanner integration specs")

    def test_findings_include_file_rule_count_and_line_but_no_secret(self):
        self.require_gitleaks()
        fixture = self.work / "record.txt"
        fixture.write_text(self.secret + "\n")
        result = self.run_sweep()
        self.assertEqual(result.returncode, 1, result.stderr)
        report = self.report()
        self.assertIn("record.txt", report)
        self.assertIn("github-pat", report)
        self.assertIn("| 1 | 1 |", report)
        self.assertEqual(fixture.read_text(), self.secret + "\n")

    def test_clean_directory(self):
        self.require_gitleaks()
        (self.work / "clean.txt").write_text("ordinary local record\n")
        self.assertEqual(self.run_sweep().returncode, 0)
        self.assertIn("No findings.", self.report())

    def test_sessions_are_scanned_even_with_custom_roots(self):
        self.require_gitleaks()
        sessions = self.home / ".pi/agent/sessions"
        sessions.mkdir(parents=True)
        (sessions / "session.jsonl").write_text(json.dumps({"text": self.secret}) + "\n")
        self.assertEqual(self.run_sweep().returncode, 1)
        self.assertIn("session.jsonl", self.report())

    def test_missing_gitleaks(self):
        self.env["PATH"] = str(self.base / "empty-path")
        result = self.run_sweep()
        self.assertEqual(result.returncode, 2)
        self.assertIn("gitleaks is missing from PATH", result.stderr)
        self.assertIn("Incomplete:", self.report())

    def test_defensive_metadata_drops_secret_match_and_other_fields(self):
        rows = [{"File": "record.txt", "RuleID": "fixture-rule", "StartLine": 4,
                 "Secret": self.secret, "Match": "prefix " + self.secret,
                 "Description": self.secret},
                {"File": self.secret, "RuleID": "fixture-rule", "StartLine": self.secret}]
        metadata = sweep.metadata(rows)
        self.assertEqual(metadata[0], ("record.txt", "fixture-rule", 4))
        self.assertNotIn(self.secret, repr(metadata))
        sweep.write_report(self.home / "report", metadata, None)
        self.assertNotIn(self.secret, next((self.home / "report").glob("*.md")).read_text())

    def test_discovery_prunes_links_git_modules_and_depth_and_deduplicates(self):
        for path in [self.root / "node_modules/pkg/.ai-work", self.root / ".git/.ai-work",
                     self.root / "deep/a/b/.ai-work"]:
            path.mkdir(parents=True)
        outside = self.base / "outside/.ai-work"
        outside.mkdir(parents=True)
        (self.root / "linked").symlink_to(outside.parent, target_is_directory=True)
        found = sweep.targets([self.root, self.root / "fixture"], self.home / "absent", 2,
                              time.monotonic() + 5)
        self.assertEqual(found, [self.work])

    def test_discovery_timeout_is_partial_not_an_error(self):
        status = {"unreadable": 0, "limits": set()}
        found = sweep.targets([self.root], self.home / "absent", 8, time.monotonic() - 1, status)
        self.assertEqual(found, [])
        self.assertIn("discovery time/directory cap", status["limits"])

    def test_unreadable_directory_is_skipped_and_counted_in_report(self):
        blocked = self.root / "blocked"
        blocked.mkdir()
        original = os.scandir

        def scandir(path):
            if Path(path) == blocked:
                raise PermissionError("fixture directory denied")
            return original(path)

        status = {"unreadable": 0, "limits": set()}
        with mock.patch.object(sweep.os, "scandir", side_effect=scandir):
            found = sweep.targets([self.root], self.home / "absent", 8, time.monotonic() + 5, status)
        self.assertEqual(found, [self.work])
        self.assertEqual(status["unreadable"], 1)
        sweep.write_report(self.home / ".pi/agent/logs/secret-sweep", [], None, status)
        self.assertIn("unreadable directories skipped: 1", self.report())
        self.assertIn("Partial discovery:", self.report())

    def test_directory_cap_scans_found_records_and_marks_report_partial(self):
        self.require_gitleaks()
        (self.root / "zzz").mkdir()
        (self.work / "capped.txt").write_text(self.secret + "\n")
        result = self.run_sweep("--max-directories", "3")
        self.assertEqual(result.returncode, 1, result.stderr)
        report = self.report()
        self.assertIn("Partial discovery:", report)
        self.assertIn("capped.txt", report)
        self.assertIn("github-pat", report)

    def test_pruned_directories_and_discovered_records_are_not_walked(self):
        pruned = [self.root / name for name in sweep.PRUNED_DIRS]
        pruned += [self.home / "Library", self.home / ".Trash", self.work / "inside"]
        for path in pruned:
            (path / "nested/.ai-work").mkdir(parents=True)
        original = os.scandir
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}):
            with mock.patch.object(sweep.os, "scandir", side_effect=original) as scandir:
                found = sweep.targets([self.root, self.home], self.home / "absent", 8,
                                      time.monotonic() + 5)
        self.assertEqual(found, [self.work])
        visited = [Path(call.args[0]) for call in scandir.call_args_list]
        for path in pruned:
            self.assertFalse(any(path == entry or path in entry.parents for entry in visited), str(path))

    def test_gitleaks_file_size_limit_is_passed(self):
        report = self.base / "scanner.json"
        report.write_text("[]")
        with mock.patch.object(sweep.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
            sweep.scan("gitleaks", self.work, report, time.monotonic() + 5)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--max-target-megabytes") + 1], "20")

    def test_tool_error_suppresses_scanner_output(self):
        tool = self.base / "gitleaks"
        tool.write_text(f'#!{sys.executable}\nimport sys\nprint({self.secret!r})\nprint({self.secret!r}, file=sys.stderr)\nsys.exit(2)\n')
        tool.chmod(0o700)
        self.env["PATH"] = str(self.base)
        result = self.run_sweep()
        self.assertEqual(result.returncode, 2)
        self.assertIn("gitleaks failed", result.stderr)
        self.assertIn("Incomplete:", self.report())


if __name__ == "__main__":
    unittest.main()
