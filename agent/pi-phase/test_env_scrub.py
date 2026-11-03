"""pi-phase never hands STUDIO_CHRONICLE_* (or configured extra prefixes) to child processes. Synthetic sentinels only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import pi_phase

HERE = Path(__file__).resolve().parent
AI_WORK = HERE.parent.parent / ".ai-work"
ENTRY = ("import sys; sys.path.insert(0, sys.argv[1]); from pi_phase import main; "
         "sys.exit(main(sys.argv[4:], state=sys.argv[2], configuration=sys.argv[3]))")
SENTINEL = "SENTINEL-" + "value-7f3a"  # synthetic; never a real credential
PREFIX = "STUDIO_CHRONICLE_"
TRACKED = [PREFIX + "ONE", "studio_chronicle_two", "Studio_Chronicle_Three", "NUGET_AUTH_TOKEN", "GH_TOKEN", "ACME_X", "PATH"]
REPORT = ("import json,os,sys;names=%r;json.dump([n for n in names if n in os.environ or n.upper() in "
          "{k.upper() for k in os.environ}],open(sys.argv[1],'w'))") % TRACKED


def base_environment(**extra):
    env = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/"), "NUGET_AUTH_TOKEN": "synthetic-nuget",
           "GH_TOKEN": "synthetic-gh", PREFIX + "ONE": SENTINEL, "studio_chronicle_two": SENTINEL,
           "Studio_Chronicle_Three": SENTINEL, "PI_PHASE_WORKTREE_LOCK": "0"}
    env.update(extra)
    return env


class ScrubCase(unittest.TestCase):
    def setUp(self):
        AI_WORK.mkdir(exist_ok=True)
        owned = tempfile.TemporaryDirectory(prefix="pi-phase-scrub-", dir=AI_WORK)
        self.addCleanup(owned.cleanup)
        self.root = Path(owned.name)
        self.state, self.config, self.seen = self.root / "state", self.root / "config.json", self.root / "seen.json"
        self.config.write_text(json.dumps(dict(msbuild_max_cpu=0, phase_nice=0, cold_worktree_hint=False,
                                              container_test_detection="off")))

    def phase(self, *extra, command=None, env=None, kind="test", config=None, state=None):
        command = command or [sys.executable, "-c", REPORT, str(self.seen)]
        kind_args = ["--repo", "r", "--pr", "1", "--commit", "c"] if kind == "ci" else []
        argv = [sys.executable, "-B", "-c", ENTRY, str(HERE), str(state or self.state), str(config or self.config),
                "run", "--kind", kind, "--label", "scrub", "--policy", "direct", "--timeout", "30", "--rerun",
                *kind_args, *extra, "--", *command]
        result = subprocess.run(argv, env=env if env is not None else base_environment(), capture_output=True,
                                text=True, timeout=60)
        return result

    def children_saw(self):
        return json.loads(self.seen.read_text())

    def ledger_text(self):
        return "".join(path.read_text() for path in (self.state / "ledger").glob("*.jsonl"))


class EndToEndSpecs(ScrubCase):
    def test_mixed_case_prefix_is_stripped_and_other_credentials_and_path_survive(self):
        result = self.phase()
        self.assertEqual(result.returncode, 0, result.stderr[-300:])
        self.assertEqual(self.children_saw(), ["NUGET_AUTH_TOKEN", "GH_TOKEN", "PATH"])

    def test_note_count_ledger_and_output_never_contain_the_value(self):
        log = self.root / "run.log"
        result = self.phase("--log", str(log))
        self.assertIn(f"pi-phase: withheld 3 environment variable(s) (prefix {PREFIX})", result.stdout)
        record = json.loads(self.ledger_text().splitlines()[-1])
        self.assertEqual(record["envScrubbed"], 3)
        for text in (result.stdout, result.stderr, self.ledger_text(), log.read_text()):
            self.assertNotIn(SENTINEL, text)

    def test_nothing_withheld_means_no_note_and_no_ledger_field(self):
        env = {k: v for k, v in base_environment().items() if not k.upper().startswith(PREFIX)}
        result = self.phase(env=env)
        self.assertNotIn("withheld", result.stdout)
        self.assertNotIn("envScrubbed", self.ledger_text())

    def test_kind_ci_without_a_prepared_child_environment_is_stripped(self):
        result = self.phase(kind="ci")
        self.assertEqual(result.returncode, 0, result.stderr[-300:])
        self.assertEqual(self.children_saw(), ["NUGET_AUTH_TOKEN", "GH_TOKEN", "PATH"])

    def test_a_configured_prefix_is_added_and_the_builtin_stays(self):
        (self.root / "config.local.json").write_text(json.dumps({"env_scrub": {"prefixes": ["acme_"]}}))
        self.assertEqual(self.phase(env=base_environment(ACME_X="synthetic")).returncode, 0)
        self.assertEqual(self.children_saw(), ["NUGET_AUTH_TOKEN", "GH_TOKEN", "PATH"])

    def test_invalid_or_unreadable_config_still_strips_the_builtin_prefix(self):
        bad = ['{"env_scrub": {"prefixes": 5}}', '{"env_scrub": {"prefixes": ["ok_", 7]}}', '{"env_scrub": []}',
               '{"env_scrub": {"prefixes": ["a b"]}}', "not json", "[]"]
        for text in bad:
            with self.subTest(text=text):
                (self.root / "config.local.json").write_text(text)
                self.assertEqual(self.phase(env=base_environment(ACME_X="synthetic")).returncode, 0)
                self.assertEqual(self.children_saw(), ["NUGET_AUTH_TOKEN", "GH_TOKEN", "ACME_X", "PATH"])
        (self.root / "config.local.json").unlink()
        (self.root / "config.local.json").mkdir()  # unreadable as a file
        self.assertEqual(self.phase(env=base_environment(ACME_X="synthetic")).returncode, 0)
        self.assertEqual(self.children_saw(), ["NUGET_AUTH_TOKEN", "GH_TOKEN", "ACME_X", "PATH"])

    def test_config_cannot_remove_the_builtin_prefix(self):
        (self.root / "config.local.json").write_text(json.dumps({"env_scrub": {"prefixes": [], "remove": [PREFIX]}}))
        self.phase()
        self.assertNotIn(PREFIX + "ONE", self.children_saw())

    def test_a_nested_phase_does_not_reacquire_the_values(self):
        inner = [sys.executable, "-B", "-c", ENTRY, str(HERE), str(self.root / "inner-state"), str(self.config),
                 "run", "--kind", "test", "--label", "inner", "--policy", "direct", "--timeout", "20", "--rerun",
                 "--", sys.executable, "-c", REPORT, str(self.seen)]
        self.assertEqual(self.phase(command=inner).returncode, 0)
        self.assertEqual(self.children_saw(), ["NUGET_AUTH_TOKEN", "GH_TOKEN", "PATH"])

    def test_argv_env_assignments_are_left_alone(self):
        script = f"import json,os,sys;json.dump(os.environ.get('{PREFIX}ARGV'),open(sys.argv[1],'w'))"
        self.assertEqual(self.phase(command=["env", f"{PREFIX}ARGV=explicit", sys.executable, "-c", script, str(self.seen)]).returncode, 0)
        self.assertEqual(self.children_saw(), "explicit")


class LaunchPathSpecs(unittest.TestCase):
    """Every launch builder drops the prefix even when handed a polluted environment explicitly."""

    def polluted(self):
        return {PREFIX + "A": SENTINEL, "studio_chronicle_b": SENTINEL, "GH_TOKEN": "synthetic", "PATH": os.environ["PATH"]}

    def assert_clean(self, env):
        self.assertEqual(sorted(k for k in env if k.upper().startswith(PREFIX)), [])
        self.assertEqual(env["GH_TOKEN"], "synthetic")

    def test_filter_returns_count_and_never_mutates_its_input(self):
        original = self.polluted()
        kept, count = pi_phase.filter_child_environment(original)
        self.assertEqual((count, sorted(kept)), (2, ["GH_TOKEN", "PATH"]))
        self.assertEqual(len(original), 4)

    def test_shim_environment_is_clean(self):
        with tempfile.TemporaryDirectory(dir=AI_WORK) as directory, patch.dict(os.environ, self.polluted(), clear=True):
            self.assert_clean(pi_phase.shim_environment(Path(directory), 2))

    def test_holder_environment_is_clean_for_default_and_explicit_environments(self):
        with patch.dict(os.environ, self.polluted(), clear=True):
            self.assert_clean(pi_phase.holder_environment(Path("/s"), "/r", [], "t", None))
        self.assert_clean(pi_phase.holder_environment(Path("/s"), "/r", [], "t", self.polluted()))

    def test_internal_git_helpers_get_a_clean_environment(self):
        seen = []

        def fake(command, **kwargs):
            seen.append(kwargs.get("env"))
            return subprocess.CompletedProcess(command, 0, stdout="x" if "rev-parse" in command else b"", stderr=b"")
        with patch.dict(os.environ, self.polluted(), clear=True), patch.object(subprocess, "run", side_effect=fake):
            pi_phase.git_state(str(AI_WORK), timeout=3)
        self.assertTrue(seen)
        for env in seen:
            self.assert_clean(env)

    def test_process_scrub_covers_helpers_that_inherit_the_environment(self):
        with patch.dict(os.environ, self.polluted(), clear=True), patch.object(pi_phase, "ENV_WITHHELD", 0):
            self.assertEqual(pi_phase.scrub_process_environment(), 2)
            self.assert_clean(dict(os.environ))


class ReuseKeySpecs(unittest.TestCase):
    def test_policy_fingerprint_changes_with_prefixes_and_is_value_free(self):
        base = pi_phase.env_policy_fingerprint()
        with patch.object(pi_phase, "ACTIVE_SCRUB_PREFIXES", (PREFIX, "ACME_")):
            self.assertNotEqual(pi_phase.env_policy_fingerprint(), base)
        self.assertRegex(base, r"^[0-9a-f]{64}$")

    def test_a_result_from_another_prefix_policy_is_never_matched(self):
        args = SimpleNamespace(kind="test", label="x", priority="normal", command=["true"])
        ledger = pi_phase.PhaseLedger(args)
        stored = dict(ledger.record, verified=True)
        self.assertTrue(ledger.matches_state(stored))
        with patch.object(pi_phase, "ACTIVE_SCRUB_PREFIXES", (PREFIX, "ACME_")):
            other = pi_phase.PhaseLedger(args).record
        self.assertNotEqual(other["envPolicy"], stored["envPolicy"])
        self.assertFalse(ledger.matches_state(dict(stored, envPolicy=other["envPolicy"])))
        self.assertFalse(ledger.matches_state({k: v for k, v in stored.items() if k != "envPolicy"}))


if __name__ == "__main__":
    unittest.main()
