"""hang_timeout: blame-hang-timeout injection for direct VSTest `dotnet test` only (#81 step 7)."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import hashlib
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

import pi_phase

FIXTURES = Path(__file__).parent / "testdata" / "failure-logs"


class HangTimeoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(os.path.realpath(self.tmp.name))
        (self.root / ".git").mkdir()
        self.settings = pi_phase.hang_timeout_config(dict(mode="on"), lambda _: None)

    def args(self, **fields):
        values = dict(kind="test", timeout=300, diagnose_hang=False, vstest_hang_minutes=None,
                      no_hang_timeout=False, ledger=None)
        return SimpleNamespace(**dict(values, **fields))

    def apply(self, command, settings=None, cwd=None, **fields):
        errors = io.StringIO()
        with redirect_stdout(errors):
            result = pi_phase.apply_hang_timeout(command, self.args(**fields), settings or self.settings, cwd or self.root)
        return result, errors.getvalue()

    def test_defaults_are_off(self):
        self.assertEqual(pi_phase.config(self.root / "none.json").options["hang_timeout"], dict(mode="off"))
        self.assertEqual(self.settings, dict(mode="on", seconds=150, kinds=["test"], paths=[]))

    def test_injected_for_direct_vstest_with_and_without_runsettings(self):
        injected = ["--blame-hang-timeout", "150s", "--blame-hang-dump-type", "none"]
        for prefix in ([], ["env", "A=1", "nice", "-n", "5"], ["env", "--"]):
            for tail in ([], ["--", "RunConfiguration.MaxCpuCount=1"]):
                with self.subTest(prefix=prefix, tail=tail):
                    command = [*prefix, "dotnet", "test", "X.csproj", *tail]
                    result, errors = self.apply(command)
                    self.assertEqual(result, [*prefix, "dotnet", "test", "X.csproj", *injected, *tail])
                    self.assertEqual(len(errors.splitlines()), 1)

    def test_not_injected(self):
        command = ["dotnet", "test"]
        cases = {
            "mode off": dict(settings=dict(mode="off")),
            "integration": dict(kind="integration"),
            "build": dict(kind="build"),
            "opt out": dict(no_hang_timeout=True),
            "diagnose": dict(diagnose_hang=True),
            "preset": dict(vstest_hang_minutes=2),
            "too short timeout": dict(timeout=170),
        }
        for name, fields in cases.items():
            with self.subTest(name):
                self.assertEqual(self.apply(command, **fields)[0], command)
        for extra in (["--blame"], ["--blame-hang"], ["--blame-hang-timeout=5m"], ["--hangdump"], ["--blame-crash"]):
            with self.subTest(extra=extra):
                self.assertEqual(self.apply(command + extra)[0], command + extra)
        for shell in (["bash", "-c", "dotnet test"], ["sh", "-c", "bash .ai-work/ci-local.sh"],
                      ["env", "A=1", "bash", "-c", "dotnet test"], ["bash", ".ai-work/ci-local.sh"], ["python3", "t.py"]):
            with self.subTest(shell=shell):
                self.assertEqual(self.apply(shell)[0], shell)

    def test_boundary_timeout_is_allowed(self):
        self.assertNotEqual(self.apply(["dotnet", "test"], timeout=180)[0], ["dotnet", "test"])

    def test_mtp_global_json_is_skipped_with_a_note(self):
        (self.root / "global.json").write_text(json.dumps({"test": {"runner": "Microsoft.Testing.Platform"}}))
        sub = self.root / "src"
        sub.mkdir()
        result, errors = self.apply(["dotnet", "test"], cwd=sub)
        self.assertEqual(result, ["dotnet", "test"])
        self.assertIn("Microsoft.Testing.Platform", errors)
        (self.root / "global.json").write_text(json.dumps({"sdk": {"version": "10.0.100"}}))
        self.assertNotEqual(self.apply(["dotnet", "test"], cwd=sub)[0], ["dotnet", "test"])
        (self.root / "global.json").write_text("{broken")
        self.assertEqual(self.apply(["dotnet", "test"], cwd=sub)[0], ["dotnet", "test"])

    def test_path_allowlist(self):
        inside = dict(self.settings, paths=[str(self.root) + "*"])
        outside = dict(self.settings, paths=["/nowhere/*"])
        self.assertNotEqual(self.apply(["dotnet", "test"], inside)[0], ["dotnet", "test"])
        self.assertEqual(self.apply(["dotnet", "test"], outside)[0], ["dotnet", "test"])

    def test_invalid_config_is_off(self):
        for value in ("on", dict(mode="on", seconds=0), dict(mode="on", kinds=["ci"]), dict(mode="x"),
                      dict(mode="on", paths="a")):
            with self.subTest(value=value):
                self.assertEqual(pi_phase.hang_timeout_config(value, lambda _: None), dict(mode="off"))

    def test_ledger_records_seconds_and_argv_hash_is_original(self):
        ledger = SimpleNamespace(record={})
        self.apply(["dotnet", "test"], ledger=ledger)
        self.assertEqual(ledger.record["hangTimeoutS"], 150)
        # End to end: stub dotnet sees the injected arguments; the ledger hash covers the original argv only.
        stub = self.root / "dotnet"
        seen = self.root / "seen"
        stub.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shlex.quote(str(seen)) + "\n")
        stub.chmod(0o700)
        configuration = self.root / "config.json"
        configuration.write_text(json.dumps(dict(
            heavy_slots=1, integration_slots=1, container_test_detection="off", cold_worktree_hint=False,
            msbuild_max_cpu=0, phase_nice=0, hang_timeout=dict(mode="on", seconds=60))))
        state = self.root / "state"
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = pi_phase.main(["run", "--kind", "test", "--label", "hang", "--policy", "direct", "--timeout", "120",
                                  "--", str(stub), "test"], state=state, configuration=configuration)
        self.assertEqual(code, 0)
        self.assertEqual(seen.read_text().split(), ["test", "--blame-hang-timeout", "60s",
                                                    "--blame-hang-dump-type", "none"])
        record = [json.loads(line) for path in (state / "ledger").glob("*.jsonl")
                  for line in path.read_text().splitlines()][-1]
        self.assertEqual(record["hangTimeoutS"], 60)
        self.assertEqual(record["argvHash"], hashlib.sha256(os.fsencode("\0".join([str(stub), "test"]))).hexdigest())

    def test_classifier_maps_blame_text_to_hang(self):
        text = (FIXTURES / "blame-hang.log").read_bytes()
        self.assertEqual(pi_phase.classify_failure(text, 124, "timeout", False)["detail"], "hang")


if __name__ == "__main__":
    unittest.main()
