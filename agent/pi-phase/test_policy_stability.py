"""Policy regressions using private state/config and bounded synthetic producers only."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pi_phase


AI_WORK = Path(__file__).resolve().parents[2] / ".ai-work"


class FingerprintTests(unittest.TestCase):
    def fingerprint(self, *command):
        return pi_phase.test_fingerprint("/pi-phase-compat", list(command))

    def test_ordinary_fingerprints_pinned_from_origin_main(self):
        # Computed by executing origin/main's test_fingerprint, not the new normalizer.
        cases = [
            (["dotnet", "build", "Example.sln", "-c", "Release"],
             "c6313498477ae99e5a87fd220cc93a96c05cb7bc"),
            (["python3", "-m", "unittest", "discover"],
             "d035500a5c37d971c8a006169adab36464654829"),
            (["bash", "tools/cratis-local-packages.sh", "pack-nuget", "producer", "5.0.0"],
             "d938bbc4267615dcf73310670371b920c89a55ef"),
            (["dotnet", "test", "--filter", "FullyQualifiedName~when_ready"],
             "4691f1cc2a118209b0f2a27a1a314d4163bd93a6"),
        ]
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertEqual(self.fingerprint(*command), expected)

    def test_each_property_form_ignores_its_value(self):
        for prefix in ("-p:Version=", "/p:Version=", "-p:PackageVersion=", "/p:PackageVersion="):
            with self.subTest(prefix=prefix):
                self.assertEqual(self.fingerprint("dotnet", "pack", prefix + "5.0.0-local.1"),
                                 self.fingerprint("dotnet", "pack", prefix + "6.0.0-train.42"))

    def test_local_and_train_stamp_tokens(self):
        base = ["bash", "cratis-local-packages.sh", "pack-nuget", "producer"]
        for stamp in ("5.0.0-local.1", "5.0.0-train.42", "6.1.2-local.20261025.gabcdef0"):
            with self.subTest(stamp=stamp):
                self.assertEqual(self.fingerprint(*base, stamp), self.fingerprint(*base, "9.0.0-train.next"))

    def test_git_stamp_suffix(self):
        self.assertEqual(self.fingerprint("pack", "stamp.g0123abc"),
                         self.fingerprint("pack", "stamp.gAbC4567"))
        self.assertNotEqual(self.fingerprint("pack", "stamp.g0123abc"),
                            self.fingerprint("pack", "other.g0123abc"))

    def test_mixed_forms_and_input_is_not_mutated(self):
        command = ["dotnet", "pack", "-p:Version=5.0.0-local.1", "/p:PackageVersion=5.0.0-train.2",
                   "5.0.0-local.3.gabcdef0", "stamp.gabcdef0"]
        original = command.copy()
        expected = ["dotnet", "pack", "-p:Version=6.0.0-local.5", "/p:PackageVersion=6.0.0-train.6",
                    "6.0.0-train.7.g1234567", "stamp.g1234567"]
        self.assertEqual(self.fingerprint(*command), self.fingerprint(*expected))
        self.assertEqual(command, original)

    def test_near_matches_keep_their_identity(self):
        for token in ("-p:Other=5.0.0", "5.0.0", "5.0.0-preview.1", "stamp.g12345678", "stamp.gxyz1234"):
            with self.subTest(token=token):
                self.assertEqual(pi_phase.fingerprint_argument(token), token)


class ConfigDirectTests(unittest.TestCase):
    def setUp(self):
        AI_WORK.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="policy-stability-", dir=AI_WORK)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.state = self.root / "state"
        self.configuration = self.root / "config.json"
        self.rule = dict(path=str(self.root), kinds=["build", "test"], policy="direct", max_expected_s=7)
        self.options = dict(policy=[self.rule], fast_lane=pi_phase.fast_lane_config({}, lambda _: None))
        self.configuration.write_text(json.dumps(dict(policy=[self.rule], msbuild_max_cpu=0, phase_nice=0,
                                                       cold_worktree_hint=False, container_test_detection="off")))
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("PI_PHASE_POLICY", None)
        os.environ["GIT_CEILING_DIRECTORIES"] = str(self.root.parent)
        cwd = patch.object(pi_phase.os, "getcwd", return_value=str(self.root))
        cwd.start()
        self.addCleanup(cwd.stop)

    def history(self, durations, **extra):
        now = datetime.now(timezone.utc).isoformat()
        records = [dict(ts=now, startedAt=now, outcome="passed", runS=value,
                        fingerprint="fingerprint", **extra) for value in durations]
        return pi_phase.PhaseHistory(records)

    def policy(self, history=None, **fields):
        args = SimpleNamespace(kind="build", **fields)
        return pi_phase.select_policy(self.state, args, self.options, "fingerprint", history=history)

    def run_phase(self, command, timeout="10"):
        with redirect_stdout(io.StringIO()):
            return pi_phase.main(["run", "--kind", "build", "--label", "config-direct", "--rerun",
                                  "--timeout", timeout, "--", *command],
                                 state=self.state, configuration=self.configuration)

    def records(self):
        return [json.loads(line) for path in (self.state / "ledger").glob("*.jsonl")
                for line in path.read_text().splitlines()]

    def test_first_run_without_history_is_direct(self):
        self.assertEqual(self.policy(), ("direct", "config"))
        self.assertEqual(self.policy(self.history([])), ("direct", "config"))
        self.assertEqual(self.run_phase([sys.executable, "-c", "pass"]), 0)
        self.assertEqual(self.records()[0]["policy"], "direct")
        self.assertFalse(list(self.state.glob("fast-*.lock")))
        self.assertFalse(list(self.state.glob("heavy-*.lock")))

    def test_budget_uses_rule_limit_even_with_fast_lane_disabled(self):
        args = SimpleNamespace(timeout=1000)
        policy_args = SimpleNamespace(config_direct_limit=60)
        held = [(self.state / "direct-owned.lock", None)]
        with patch.object(pi_phase, "note"):
            self.assertEqual(pi_phase.apply_fast_budget(args, False, held, policy_args), 180)
        self.assertEqual(args.timeout, 180)
        self.assertEqual(pi_phase.fast_budget(dict(max_expected_s=7)), 120)

    def test_shorter_caller_timeout_wins(self):
        args = SimpleNamespace(timeout=4)
        with patch.object(pi_phase, "note"):
            budget = pi_phase.apply_fast_budget(args, False, [(self.state / "direct-owned.lock", None)],
                                                SimpleNamespace(config_direct_limit=7))
        self.assertEqual(budget, 120)
        self.assertEqual(args.timeout, 4)

    def test_config_direct_overrun_exits_124_and_one_run_does_not_demote(self):
        # Accelerate the budget rather than sleeping for its production minimum of 120 seconds.
        with patch.object(pi_phase, "fast_budget", return_value=.1):
            code = self.run_phase([sys.executable, "-c", "import time; time.sleep(2)"])
        self.assertEqual(code, 124)
        record = self.records()[0]
        self.assertEqual((record["policy"], record["outcome"], record["fastBudgetExceeded"]),
                         ("direct", "timeout", True))
        self.assertEqual(self.policy(self.history([121], fastBudgetExceeded=True)), ("direct", "config"))

    def test_one_or_two_slow_runs_do_not_demote(self):
        for durations in ([8], [8, 9]):
            with self.subTest(durations=durations):
                self.assertEqual(self.policy(self.history(durations)), ("direct", "config"))

    def test_p90_over_three_runs_demotes_rule_to_fast(self):
        for durations, expected in (([7, 7, 7], "direct"), ([8, 9, 10], "fast")):
            with self.subTest(durations=durations):
                self.assertEqual(pi_phase.rule_policy(self.state, self.rule, "fingerprint",
                                                      history=self.history(durations)), expected)
        self.assertEqual(self.policy(self.history([8, 9, 10])), ("fast", "config"))
        # Normal fast-lane safeguards further demote commands above the fast threshold.
        self.assertEqual(self.policy(self.history([91, 92, 93])), ("queued", "config"))

    def test_unrelated_family_overrun_does_not_demote_direct_fingerprint(self):
        history = self.history([200, 200, 200], familyKey="family", fastBudgetExceeded=True)
        self.assertEqual(pi_phase.rule_policy(self.state, self.rule, "new-fingerprint", history=history,
                                              identity=SimpleNamespace(family_key="family")), "direct")

    def test_integration_and_container_phases_never_direct(self):
        self.rule["kinds"].append("integration")
        self.assertEqual(pi_phase.select_policy(self.state, SimpleNamespace(kind="integration"), self.options,
                                                "fingerprint"), ("queued", "config"))
        self.state.mkdir(exist_ok=True)
        (self.state / "container-tests.json").write_text(json.dumps(dict(fingerprint=True)))
        self.assertEqual(self.policy(), ("queued", "config"))

    def test_ledger_retains_raw_argv_hash_and_schema(self):
        commands = [[sys.executable, "-c", "pass", "-p:Version=" + version]
                    for version in ("5.0.0-local.1", "5.0.0-local.2")]
        for command in commands:
            self.assertEqual(self.run_phase(command), 0)
        records = self.records()
        self.assertEqual(records[0]["fingerprint"], records[1]["fingerprint"])
        self.assertNotEqual(records[0]["argvHash"], records[1]["argvHash"])
        self.assertEqual([record["v"] for record in records], [1, 1])
        for record, command in zip(records, commands):
            self.assertEqual(record["argvHash"], hashlib.sha256(os.fsencode("\0".join(command))).hexdigest())


class WorktreeRuleTests(unittest.TestCase):
    def setUp(self):
        AI_WORK.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="policy-worktrees-", dir=AI_WORK)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        environment = patch.dict(os.environ, GIT_CEILING_DIRECTORIES=str(self.root.parent))
        environment.start()
        self.addCleanup(environment.stop)
        self.checkout = self.root / "Fundamentals"
        self.checkout.mkdir()
        self.worktree = self.root / "worktree"
        self.rule = dict(path=str(self.checkout) + "*", kinds=["build"], policy="direct")

    def git(self, *arguments):
        return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *arguments], cwd=self.checkout,
                              capture_output=True, text=True, check=True, timeout=5)

    def test_real_git_worktree_inherits_main_checkout_rule(self):
        self.git("init")
        self.git("-c", "user.name=Policy Test", "-c", "user.email=policy@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial")
        self.git("worktree", "add", "--detach", str(self.worktree))
        nested = self.worktree / "nested"
        nested.mkdir()
        for cwd in (self.worktree, nested):
            with self.subTest(cwd=cwd), patch.object(pi_phase.os, "getcwd", return_value=str(cwd)):
                self.assertEqual(pi_phase.main_worktree(str(cwd)), str(self.checkout))
                self.assertEqual(list(pi_phase.matching_policy_rules("build", [self.rule])), [self.rule])
                options = dict(policy=[self.rule], fast_lane=False)
                with patch.dict(os.environ, PI_PHASE_POLICY=""):
                    self.assertEqual(pi_phase.select_policy(self.root / "state", SimpleNamespace(kind="build"),
                                                           options, "fingerprint"), ("direct", "config"))

    def test_non_git_cwd_does_not_inherit(self):
        with patch.object(pi_phase.os, "getcwd", return_value=str(self.root)):
            self.assertIsNone(pi_phase.main_worktree(str(self.root)))
            self.assertEqual(list(pi_phase.matching_policy_rules("build", [self.rule])), [])

    def test_git_failure_and_timeout_fail_closed(self):
        errors = [OSError("missing git"), subprocess.CalledProcessError(128, "git"),
                  subprocess.TimeoutExpired("git", 1)]
        for error in errors:
            with self.subTest(error=error), patch.object(pi_phase.subprocess, "run", side_effect=error) as run:
                self.assertIsNone(pi_phase.main_worktree(str(self.root)))
                self.assertEqual(run.call_args.kwargs["timeout"], 1)

    def test_failure_preserves_cwd_rules_and_order(self):
        matching = dict(self.rule, path=str(self.root), policy="queued")
        with patch.object(pi_phase.os, "getcwd", return_value=str(self.root)), \
                patch.object(pi_phase.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 1)):
            self.assertEqual(list(pi_phase.matching_policy_rules("build", [self.rule, matching])), [matching])
            self.assertEqual(list(pi_phase.matching_policy_rules("test", [matching])), [])

    def test_fundamentals_seed_matches_non_git_worktree_path(self):
        config = json.loads((Path(pi_phase.__file__).parent / "config.json").read_text())
        rules = [dict(rule, path=rule["path"].replace("{{" + "REPOS_ROOT}}", str(self.root)))
                 for rule in config["policy"]]
        cwd = self.root / "cratis" / ".worktrees" / "fundamentals-policy"
        cwd.mkdir(parents=True)
        with patch.object(pi_phase.os, "getcwd", return_value=str(cwd)):
            self.assertEqual(next(pi_phase.matching_policy_rules("build", rules))["policy"], "direct")


if __name__ == "__main__":
    unittest.main()
