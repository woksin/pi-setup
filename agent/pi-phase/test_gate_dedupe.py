"""Cross-worktree gate dedupe via gateKey (#81 step 9), with two real worktrees of one repository."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import pi_phase


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env=dict(os.environ, GIT_AUTHOR_NAME="T", GIT_AUTHOR_EMAIL="t@e.invalid",
                            GIT_COMMITTER_NAME="T", GIT_COMMITTER_EMAIL="t@e.invalid"))


class GateDedupeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(os.path.realpath(self.tmp.name))
        self.state = self.root / "state"
        self.counter = self.root / "counter"
        self.write_config(skip_cross_worktree=True)
        main = self.root / "main"
        main.mkdir()
        git(main, "init", "-q", "-b", "main")
        (main / "tracked").write_text("x")
        (main / ".gitignore").write_text(".ai-work/\nglobal.json\n")
        git(main, "add", ".")
        git(main, "commit", "-qm", "initial")
        self.a, self.b = main, self.root / "second"
        git(main, "worktree", "add", "-q", "-b", "other", str(self.b))
        for tree in (self.a, self.b):
            (tree / ".ai-work").mkdir()
        self.previous = os.getcwd()
        self.addCleanup(os.chdir, self.previous)

    def write_config(self, **values):
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps(dict(
            heavy_slots=1, integration_slots=1, container_test_detection="off", cold_worktree_hint=False,
            msbuild_max_cpu=0, phase_nice=0, **values)))

    def command(self):
        return [sys.executable, "-c", f"open({str(self.counter)!r}, 'a').write('x')"]

    def run_gate(self, tree, kind="test", label="gate", extra=(), command=None):
        os.chdir(tree)
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(io.StringIO()):
            code = pi_phase.main(["run", "--kind", kind, "--label", label, "--policy", "direct", "--timeout", "20",
                                  *extra, "--", *(command or self.command())], state=self.state,
                                 configuration=self.config)
        self.assertEqual(code, 0, output.getvalue())
        return output.getvalue()

    def runs(self):
        return len(self.counter.read_text()) if self.counter.exists() else 0

    def records(self):
        return [json.loads(line) for path in sorted((self.state / "ledger").glob("*.jsonl"))
                for line in path.read_text().splitlines()]

    def assertSkipsOnlyWhen(self, runs):
        self.assertEqual(self.runs(), runs)

    def test_same_state_in_both_worktrees_skips_even_with_another_label(self):
        self.run_gate(self.a)
        output = self.run_gate(self.b, label="renamed")
        self.assertIn("identical gate already passed", output)
        self.assertEqual(self.runs(), 1)
        first, second = self.records()
        self.assertTrue(first["verified"])
        self.assertEqual((second["outcome"], second["verified"], second["dedupedFrom"]), ("skipped", False, first["ts"]))
        self.assertEqual(first["gateKey"], second["gateKey"])
        self.assertNotEqual(first["cwd"], second["cwd"])

    def test_skip_returns_before_registration(self):
        self.run_gate(self.a)
        with patch.object(pi_phase, "register_waiter", side_effect=ValueError("registered")) as register:
            self.run_gate(self.b)
        register.assert_not_called()
        self.assertEqual(self.runs(), 1)

    def test_default_is_off(self):
        self.write_config()
        self.run_gate(self.a)
        self.run_gate(self.b)
        self.assertEqual(self.runs(), 2)
        self.assertNotIn("dedupedFrom", self.records()[-1])

    def test_differences_never_skip(self):
        self.run_gate(self.a)
        (self.b / "untracked.txt").write_text("different")
        self.run_gate(self.b)
        self.assertEqual(self.runs(), 2)

    def test_ignored_global_json_content_is_part_of_the_key(self):
        (self.a / "global.json").write_text('{"sdk":{"version":"10.0.100"}}')
        (self.b / "global.json").write_text('{"sdk":{"version":"10.0.200"}}')
        self.run_gate(self.a)
        self.run_gate(self.b)
        self.assertEqual(self.runs(), 2)
        (self.b / "global.json").write_text('{"sdk":{"version":"10.0.100"}}')
        self.run_gate(self.b)
        self.assertEqual(self.runs(), 2)

    def test_installed_sdk_list_is_part_of_the_key(self):
        for name, sdks in (("one", ["10.0.100"]), ("two", ["10.0.100", "10.0.200"])):
            bin_dir = self.root / name / "bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "dotnet").write_text("")
            for sdk in sdks:
                (self.root / name / "bin" / "sdk" / sdk).mkdir(parents=True)
        real = pi_phase.shutil.which
        with patch.object(pi_phase.shutil, "which",
                          side_effect=lambda n, *a, **k: str(self.root / "one/bin/dotnet") if n == "dotnet" else real(n, *a, **k)):
            self.run_gate(self.a)
        with patch.object(pi_phase.shutil, "which",
                          side_effect=lambda n, *a, **k: str(self.root / "two/bin/dotnet") if n == "dotnet" else real(n, *a, **k)):
            self.run_gate(self.b)
        self.assertEqual(self.runs(), 2)

    def test_gitignored_argv_script_content_is_part_of_the_key(self):
        count = f"open({str(self.counter)!r}, 'a').write('x')"
        for tree, extra in ((self.a, "# one"), (self.b, "# two")):
            (tree / ".ai-work" / "gate.py").write_text(count + "\n" + extra + "\n")
        command = [sys.executable, ".ai-work/gate.py"]
        self.run_gate(self.a, command=command)
        self.run_gate(self.b, command=command)
        self.assertEqual(self.runs(), 2)
        (self.b / ".ai-work" / "gate.py").write_text(count + "\n# one\n")
        self.run_gate(self.b, command=command)
        self.assertEqual(self.runs(), 2)  # same content as the first worktree's script now: skipped

    def test_integration_never_skips_even_when_enabled(self):
        self.write_config(skip_cross_worktree=True, skip_passed_integration=True)
        self.run_gate(self.a, kind="integration")
        self.run_gate(self.b, kind="integration")
        self.assertEqual(self.runs(), 2)

    def test_rerun_and_environment_switch_force_a_run(self):
        self.run_gate(self.a)
        self.run_gate(self.b, extra=["--rerun"])
        self.assertEqual(self.runs(), 2)
        with patch.dict(os.environ, PI_PHASE_NO_SKIP="1"):
            self.run_gate(self.b)
        self.assertEqual(self.runs(), 3)

    def test_exceeded_hash_caps_refuse_to_skip(self):
        self.run_gate(self.a)
        real = pi_phase.git_state
        with patch.object(pi_phase, "git_state", side_effect=lambda cwd, timeout=None: (real(cwd, timeout)[0], None)):
            output = self.run_gate(self.b)
        self.assertIn("tree state too large to hash; not deduplicating", output)
        self.assertEqual(self.runs(), 2)

    def test_legacy_unverified_and_failed_records_never_match(self):
        self.run_gate(self.a)
        files = list((self.state / "ledger").glob("*.jsonl"))
        original = files[0].read_text()
        for mutate in (lambda r: r.pop("gateKey"), lambda r: r.update(verified=False), lambda r: r.update(outcome="failed")):
            record = json.loads(original.splitlines()[0])
            mutate(record)
            files[0].write_text(json.dumps(record) + "\n")
            self.run_gate(self.b)
        self.assertEqual(self.runs(), 4)

    def test_profile_is_part_of_the_key(self):
        args = type("A", (), dict(kind="test", label="x", priority="normal", command=["true"], profile="full"))
        keys = []
        for profile in ("full", "iterate"):
            args.profile = profile
            ledger = pi_phase.PhaseLedger(args)
            with patch.object(pi_phase, "git_state", return_value=("a" * 40, "clean")):
                os.chdir(self.a)
                ledger.record["cwd"] = str(self.a)
                ledger.prepare_snapshot()
            keys.append(ledger.record["gateKey"])
        self.assertNotEqual(*keys)


if __name__ == "__main__":
    unittest.main()
