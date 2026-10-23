"""Queue order (shortest-expected-first with aging), work identity, history and replay tests."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pi_phase
import test_pi_phase

HERE = Path(__file__).resolve().parent
GIT = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"]


class Harness(unittest.TestCase):
    """The PhaseTests helpers without inheriting (and re-running) its tests."""
    for _name in ("setUp", "finish_children", "cli", "start", "waiter", "admit", "executable", "configure",
                  "ledger_records", "done", "run_phase", "wait_for", "marker_job", "intervals", "fast_args",
                  "fast_settings", "policy_options", "orphan_slots"):
        locals()[_name] = test_pi_phase.PhaseTests.__dict__[_name]
    del _name

    def ranked(self, label, expected, age_after=600, priority="normal", kind="build", fast=False, basis="work",
               promote_after=None):
        self.state.mkdir(exist_ok=True)
        args = SimpleNamespace(priority=priority, kind=kind, label=label, fast=fast, expected=expected,
                               basis=basis, age_after=age_after, promote_after=promote_after)
        ready, fd = pi_phase.register_waiter(self.state, args, label)
        self.assertTrue(ready)
        self.addCleanup(os.close, fd)
        return label

    def at(self, now, call, *args, **kwargs):
        with patch.object(pi_phase.time, "time", return_value=now):
            return call(*args, **kwargs)

    def seed(self, command, durations, kind="test", **fields):
        now = datetime.now(timezone.utc).isoformat()
        for seconds in durations:
            record = dict(v=1, ts=now, kind=kind, stack="other", startedAt=now, waitS=0, runS=seconds,
                          outcome="passed", fingerprint=pi_phase.test_fingerprint(os.getcwd(), command))
            record.update(fields)
            pi_phase.append_ledger(self.state, record)


def git_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run([*GIT, "init", "-q", str(path)], check=True)
    subprocess.run([*GIT, "-C", str(path), "commit", "-q", "--allow-empty", "-m", "init"], check=True)
    return path


class WorkIdentityTests(unittest.TestCase):
    def setUp(self):
        self.owned = tempfile.TemporaryDirectory(prefix="pi-phase-identity-")
        self.addCleanup(self.owned.cleanup)
        self.root = Path(self.owned.name)
        self.repo = git_repo(self.root / "repo")
        subprocess.run([*GIT, "-C", str(self.repo), "worktree", "add", "-q", str(self.root / "wt"), "-b", "other"],
                       check=True)
        self.worktree = self.root / "wt"

    def identity(self, command, cwd=None, kind="test"):
        return pi_phase.work_identity(cwd or self.repo, command, kind)

    def test_equivalent_invocations_share_work_key_and_family(self):
        runs = [["dotnet", "bin/Release/net10.0/X.Specs.dll"], ["./bin/Release/net10.0/X.Specs"],
                ["dotnet", "test", "--no-build", "src/X.Specs/X.Specs.csproj"],
                ["dotnet", "bin/Debug/net9.0/X.Specs.dll"], ["/abs/bin/Release/net10.0/X.Specs.exe"]]
        for cwd in (self.repo, self.worktree):
            identities = [self.identity(command, cwd) for command in runs]
            self.assertEqual({i.work_key for i in identities}, {identities[0].work_key}, cwd)
            self.assertEqual({i.family_key for i in identities}, {identities[0].family_key})
            self.assertEqual({i.shape for i in identities}, {"run"})
            self.assertEqual(identities[0].project, "X.Specs")
        self.assertEqual(self.identity(runs[0]), self.identity(runs[0], self.worktree))

    def test_filtered_runs_share_work_key_and_always_the_family(self):
        plain = self.identity(["dotnet", "bin/Release/net10.0/X.Specs.dll"])
        filtered = [self.identity(["dotnet", "bin/Release/net10.0/X.Specs.dll", "-class", "Foo"]),
                    self.identity(["./bin/Release/net10.0/X.Specs", "--filter-class", "Bar"]),
                    self.identity(["dotnet", "test", "--no-build", "X.Specs.csproj", "--filter", "Name~x"]),
                    self.identity(["dotnet", "test", "--no-build", "X.Specs.csproj", "--treenode-filter", "/a/b"])]
        self.assertEqual({i.work_key for i in filtered}, {filtered[0].work_key})
        self.assertNotEqual(filtered[0].work_key, plain.work_key)
        self.assertEqual({i.family_key for i in [plain, *filtered]}, {plain.family_key})
        self.assertTrue(all(i.filtered for i in filtered))
        self.assertFalse(plain.filtered)

    def test_projectless_dotnet_test_in_project_dir_matches_the_executable_identity(self):
        sub = self.repo / "src" / "X.Specs"
        sub.mkdir(parents=True)
        for cwd, command in ((sub, ["dotnet", "test", "--no-build"]), (self.repo, ["./bin/Release/net10.0/X.Specs"]),
                             (self.repo, ["dotnet", "bin/Release/net10.0/X.Specs.dll"]),
                             (sub, ["dotnet", "test", "--no-build", "--filter", "A"])):
            identity = self.identity(command, cwd)
            self.assertEqual((identity.project, identity.family_key),
                             ("X.Specs", self.identity(["dotnet", "bin/X.Specs.dll"]).family_key), command)
        self.assertEqual(self.identity(["dotnet", "test", "--no-build"], sub).work_key,
                         self.identity(["./bin/X.Specs"]).work_key)

    def test_other_project_repo_kind_and_shape_differ(self):
        base = self.identity(["dotnet", "bin/X.Specs.dll"])
        self.assertNotEqual(base.family_key, self.identity(["dotnet", "bin/Y.Specs.dll"]).family_key)
        self.assertNotEqual(base.family_key, self.identity(["dotnet", "bin/X.Specs.dll"], kind="build").family_key)
        self.assertNotEqual(base.repo_key, self.identity(["dotnet", "bin/X.Specs.dll"], self.root).repo_key)
        self.assertEqual(self.identity(["dotnet", "test", "X.Specs.csproj"]).shape, "build+run")
        self.assertEqual(self.identity(["dotnet", "build", "X.Specs.csproj"]).shape, "build")
        self.assertEqual(self.identity(["dotnet", "test", "X.Specs.csproj"]).family_key, base.family_key)

    def test_wrappers_unwrap_and_shell_sequences_are_stable_by_directory(self):
        plain = self.identity(["dotnet", "bin/X.Specs.dll"])
        wrapped = self.identity(["nice", "-n", "5", "env", "A=1", "dotnet", "bin/X.Specs.dll"])
        self.assertEqual(plain, wrapped)
        sub = self.repo / "sub"
        sub.mkdir()
        first = self.identity(["bash", "-c", "make a; make b"], sub)
        self.assertEqual(first, self.identity(["bash", "-c", "make c; make d"], sub))
        self.assertEqual(first.project, "sub")
        self.assertNotEqual(first.family_key, self.identity(["bash", "-c", "make a; make b"]).family_key)

    def test_non_git_directory_falls_back_to_cwd(self):
        plain = self.root / "plain"
        plain.mkdir()
        with patch.object(pi_phase.subprocess, "run", side_effect=OSError("no git")):
            one = pi_phase.work_identity(plain, ["dotnet", "x/X.Specs.dll"], "test")
        self.assertEqual(one.repo_key, pi_phase.digest(os.path.realpath(plain)))
        self.assertEqual(one.project, "X.Specs")

    def test_git_is_called_once_with_bounded_timeout(self):
        with patch.object(pi_phase.subprocess, "run", wraps=subprocess.run) as run:
            self.identity(["dotnet", "x/X.Specs.dll"])
        self.assertEqual(run.call_count, 1)
        self.assertLessEqual(run.call_args.kwargs["timeout"], 1)

    def test_stack_of_spec_executables_and_existing_wrappers(self):
        for command in (["./bin/X.Specs"], ["/a/b/X.Tests"], ["X.Specs.exe"], ["dotnet", "X.dll"],
                        ["env", "-i", "A=1", "./bin/X.Specs"]):
            self.assertEqual(pi_phase.command_stack(command), "dotnet", command)
        self.assertEqual(pi_phase.command_stack(["./bin/tool"]), "other")
        self.assertEqual(pi_phase.command_stack(["bash", "-c", "a; b"]), "other")
        self.assertEqual(pi_phase.command_stack(["env", "--bad", "node"]), "other")
        self.assertEqual(pi_phase.command_stack([]), "other")


class HistoryTests(unittest.TestCase):
    def record(self, seconds, hours=1, **fields):
        stamp = datetime.now(timezone.utc) - timedelta(hours=hours)
        base = dict(v=1, ts=stamp.isoformat(), kind="test", startedAt=stamp.isoformat(), runS=seconds,
                    outcome="passed")
        return dict(base, **fields)

    def identity(self, repo="r", work="w", family="f"):
        return pi_phase.WorkIdentity(repo, work, family, "p", "run", False)

    def test_cascade_exact_work_family_repo_default(self):
        history = pi_phase.PhaseHistory([self.record(10, fingerprint="fp"), self.record(30, fingerprint="fp"),
                                         self.record(50, workKey="w"), self.record(70, familyKey="f"),
                                         *[self.record(90, repoKey="r") for _ in range(3)]])
        ident = self.identity()
        self.assertEqual(history.estimate(ident, "fp", "test", 180), (10.0, "exact"))
        self.assertEqual(history.estimate(ident, "other", "test", 180), (50.0, "work"))
        self.assertEqual(history.estimate(self.identity(work="x"), "other", "test", 180), (70.0, "family"))
        self.assertEqual(history.estimate(self.identity(work="x", family="y"), "o", "test", 180), (90.0, "repo"))
        self.assertEqual(history.estimate(self.identity("z", "x", "y"), "o", "test", 180), (180.0, "default"))
        self.assertEqual(history.estimate(self.identity(), "o", "build", 180)[1], "work")
        self.assertEqual(history.estimate(self.identity("r", "x", "y"), "o", "build", 7), (7.0, "default"))

    def test_exact_needs_two_runs_and_median_of_last_twenty(self):
        one = pi_phase.PhaseHistory([self.record(10, fingerprint="fp"), self.record(8, workKey="w")])
        self.assertEqual(one.estimate(self.identity(), "fp", "test", 99), (8.0, "work"))
        many = pi_phase.PhaseHistory([self.record(1000, workKey="w")] + [self.record(5, workKey="w")] * 20)
        self.assertEqual(many.estimate(self.identity(), "x", "test", 99), (5.0, "work"))

    def test_old_unstarted_failed_to_start_and_malformed_records_are_ignored(self):
        history = pi_phase.PhaseHistory([self.record(10, hours=24 * 8, workKey="w"),
                                         self.record(10, startedAt=None, workKey="w"),
                                         self.record(10, outcome="queue-timeout", workKey="w"),
                                         dict(kind="test"), self.record(40, workKey="w")])
        self.assertEqual(history.estimate(self.identity(), "x", "test", 99), (40.0, "work"))

    def test_legacy_records_are_indexed_by_fingerprint_only(self):
        history = pi_phase.PhaseHistory([self.record(3, fingerprint="a"), self.record(5, fingerprint="a")])
        self.assertEqual(history.estimate(None, "a", "test", 99), (3.0, "exact"))
        self.assertEqual(history.estimate(self.identity(), "b", "test", 99), (99.0, "default"))

    def test_ledger_is_read_once_per_load(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(pi_phase, "read_ledger",
                                                                wraps=pi_phase.read_ledger) as read:
            pi_phase.load_history(Path(tmp))
        self.assertEqual(read.call_count, 1)


class ConfigTests(Harness):
    def test_queue_order_defaults_and_overrides(self):
        self.assertEqual(pi_phase.config(self.config).options["queue_order"],
                         dict(mode="shortest-first", aging_s=600, default_expected_s=180, low_promote_after_s=900))
        self.configure(queue_order=dict(mode="fifo", aging_s=300, default_expected_s=60, low_promote_after_s=900))
        self.assertEqual(pi_phase.config(self.config).options["queue_order"],
                         dict(mode="fifo", aging_s=300, default_expected_s=60, low_promote_after_s=900))

    def test_queue_order_invalid_values_warn_and_fall_back(self):
        defaults = dict(mode="shortest-first", aging_s=600, default_expected_s=180, low_promote_after_s=900)
        for value in ("fifo", None, 3, [1]):
            self.configure(queue_order=value)
            with patch.object(pi_phase, "note") as note:
                self.assertEqual(pi_phase.config(self.config).options["queue_order"], defaults)
            note.assert_called_once()
        self.configure(queue_order=dict(mode="lifo", aging_s=29, default_expected_s=0, typo=1))
        with patch.object(pi_phase, "note") as note:
            self.assertEqual(pi_phase.config(self.config).options["queue_order"], defaults)
        self.assertEqual(note.call_count, 4)
        for key, bad in (("aging_s", 3601), ("aging_s", True), ("default_expected_s", 7201), ("low_promote_after_s", 29)):
            self.configure(queue_order={key: bad})
            with patch.object(pi_phase, "note"):
                self.assertEqual(pi_phase.config(self.config).options["queue_order"], defaults)

    def test_fast_lane_shape_flag(self):
        self.assertIs(self.fast_settings()["shape"], True)
        self.configure(fast_lane=dict(shape=False))
        self.assertIs(self.fast_settings()["shape"], False)
        self.configure(fast_lane=dict(shape="yes"))
        with patch.object(pi_phase, "note"):
            self.assertIs(self.fast_settings()["shape"], True)

    def test_repository_config_declares_the_new_keys(self):
        data = json.loads((HERE / "config.json").read_text())
        self.assertEqual(data["queue_order"], dict(mode="shortest-first", aging_s=600, low_promote_after_s=900))
        self.assertIs(data["fast_lane"]["shape"], True)


class FastShapeTests(Harness):
    COMMAND = ["dotnet", "bin/Release/net10.0/X.Specs.dll"]

    def decide(self, command=None, history=None, kind="test", options=None, **fields):
        command = command or self.COMMAND
        identity = pi_phase.work_identity(os.getcwd(), command, kind)
        history = history or pi_phase.PhaseHistory([])
        options = options or self.policy_options()
        fingerprint = pi_phase.test_fingerprint(os.getcwd(), command)
        return pi_phase.select_policy(self.state, self.fast_args(kind=kind, **fields), options, fingerprint,
                                      history=history, identity=identity), identity

    def overrun(self, identity, source="shape", hours=1, **fields):
        stamp = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        return dict(v=1, ts=stamp, kind="test", startedAt=stamp, runS=270, outcome="timeout", fastBudgetExceeded=True,
                    source=source, workKey=identity.work_key, familyKey=identity.family_key,
                    repoKey=identity.repo_key, **fields)

    def test_first_spec_run_is_fast_by_shape(self):
        (policy, source), _ = self.decide()
        self.assertEqual((policy, source), ("fast", "shape"))
        self.assertEqual(self.decide(["./bin/Release/net10.0/X.Specs"])[0], ("fast", "shape"))
        self.assertEqual(self.decide(["dotnet", "test", "--no-build", "X.Specs.csproj"])[0], ("fast", "shape"))

    def test_compile_builds_and_disabled_shape_are_not_eligible(self):
        self.assertEqual(self.decide(["dotnet", "test", "X.Specs.csproj"])[0], ("queued", "default"))
        self.assertEqual(self.decide(["dotnet", "build", "X.Specs.csproj"], kind="build")[0], ("queued", "default"))
        self.assertEqual(self.decide(["dotnet", "bin/X.Specs.dll"], kind="build")[0], ("queued", "default"))
        self.assertEqual(self.decide(["python3", "-c", "pass"])[0], ("queued", "default"))
        self.configure(fast_lane=dict(shape=False))
        self.assertEqual(self.decide()[0], ("queued", "default"))

    def test_any_family_history_ends_shape_eligibility(self):
        _, identity = self.decide()
        record = dict(self.overrun(identity), fastBudgetExceeded=False, outcome="passed", runS=5)
        self.assertEqual(self.decide(history=pi_phase.PhaseHistory([record]))[0], ("queued", "default"))
        twice = pi_phase.PhaseHistory([record, record])
        self.assertEqual(self.decide(history=twice)[0], ("fast", "history"))

    def test_one_overrun_demotes_the_whole_family_whatever_the_filter(self):
        _, identity = self.decide()
        history = pi_phase.PhaseHistory([self.overrun(identity)])
        for command in (self.COMMAND, [*self.COMMAND, "-class", "Foo"], ["./bin/Release/net10.0/X.Specs"],
                        ["dotnet", "test", "--no-build", "X.Specs.csproj", "--filter", "A"]):
            self.assertEqual(self.decide(command, history)[0], ("queued", "default"), command)
            with patch.object(pi_phase, "note") as note:
                self.assertEqual(self.decide(command, history, expect_fast=True)[0][0], "queued")
            self.assertTrue(any("--expect-fast ignored" in c.args[0] for c in note.call_args_list))
        stale = pi_phase.PhaseHistory([self.overrun(identity, hours=24 * 8)])
        self.assertEqual(self.decide(history=stale)[0], ("fast", "shape"))

    def test_family_overrun_is_per_project(self):
        _, identity = self.decide()
        history = pi_phase.PhaseHistory([self.overrun(identity)])
        self.assertEqual(self.decide(["dotnet", "bin/Y.Specs.dll"], history)[0], ("fast", "shape"))

    def test_container_test_family_is_refused(self):
        _, identity = self.decide()
        self.state.mkdir(exist_ok=True)
        (self.state / "container-tests.json").write_text(json.dumps({f"family:{identity.family_key}": True}))
        self.assertEqual(self.decide()[0], ("queued", "default"))
        self.assertEqual(self.decide([*self.COMMAND, "-class", "Foo"])[0], ("queued", "default"))
        self.assertEqual(self.decide(policy="direct")[0], ("queued", "flag"))

    def test_repo_circuit_breaker_after_three_shape_overruns_in_a_day(self):
        _, identity = self.decide()
        others = [pi_phase.work_identity(os.getcwd(), ["dotnet", f"bin/P{n}.Specs.dll"], "test") for n in range(3)]
        history = pi_phase.PhaseHistory([self.overrun(other) for other in others[:2]])
        self.assertEqual(self.decide(history=history)[0], ("fast", "shape"))
        history = pi_phase.PhaseHistory([self.overrun(other) for other in others])
        with patch.object(pi_phase, "note") as note:
            self.assertEqual(self.decide(history=history)[0], ("queued", "default"))
        self.assertTrue(any("shape-based fast lane off" in c.args[0] for c in note.call_args_list))
        old = pi_phase.PhaseHistory([self.overrun(other, hours=30) for other in others])
        self.assertEqual(self.decide(history=old)[0], ("fast", "shape"))

    def test_two_fast_work_runs_make_a_filtered_command_fast_and_slow_work_refuses(self):
        command = [*self.COMMAND, "-class", "Foo"]
        _, identity = self.decide(command)
        quick = [dict(self.overrun(identity), fastBudgetExceeded=False, outcome="passed", runS=5)] * 2
        self.assertEqual(self.decide(command, pi_phase.PhaseHistory(quick))[0], ("fast", "history"))
        slow = [dict(quick[0], runS=200)] * 2
        self.assertEqual(self.decide(command, pi_phase.PhaseHistory(slow))[0], ("queued", "default"))

    def test_direct_rule_uses_work_history_not_the_exact_command(self):
        _, identity = self.decide()
        rule = dict(path=str(self.root) + "*", kinds=["test"], policy="direct", max_expected_s=90)
        options = self.policy_options(policy=[rule])
        cwd = patch.object(pi_phase.os, "getcwd", return_value=str(self.root))
        with cwd:
            self.assertEqual(pi_phase.rule_policy(self.state, rule, "fp", history=pi_phase.PhaseHistory([]),
                                                  identity=identity), "fast")
            slow = pi_phase.PhaseHistory([dict(self.overrun(identity), fastBudgetExceeded=False, runS=200)])
            self.assertEqual(pi_phase.rule_policy(self.state, rule, "other", history=slow, identity=identity), "fast")
            fine = pi_phase.PhaseHistory([dict(self.overrun(identity), fastBudgetExceeded=False, runS=5)])
            self.assertEqual(pi_phase.rule_policy(self.state, rule, "other", history=fine, identity=identity), "direct")
        self.assertEqual(options["policy"], [rule])

    def test_shape_run_end_to_end_then_overrun_demotes_family(self):
        executable = self.executable(self.root / "bin" / "Release" / "net10.0" / "X.Specs", "#!/bin/sh\nsleep 2\n") \
            if (self.root / "bin" / "Release" / "net10.0").mkdir(parents=True) is None else None
        with patch.object(pi_phase, "fast_budget", return_value=.3), patch.object(pi_phase, "note") as note:
            code = pi_phase.main(["run", "--kind", "test", "--label", "shape", "--timeout", "5", "--",
                                  str(executable)], state=self.state, configuration=self.config)
        messages = [call.args[0] for call in note.call_args_list]
        self.assertEqual(code, 124)
        self.assertIn("policy=fast source=shape", messages)
        self.assertIn("fast-lane phase exceeded its budget; rerun normally; this command family now queues", messages)
        record = self.ledger_records()[0]
        self.assertTrue(record["fastBudgetExceeded"])
        self.assertEqual(record["source"], "shape")
        with patch.object(pi_phase, "note") as note:
            code = pi_phase.main(["run", "--kind", "test", "--label", "filtered", "--timeout", "5", "--",
                                  str(executable), "-class", "Foo"], state=self.state, configuration=self.config)
        self.assertIn("policy=queued source=default", [call.args[0] for call in note.call_args_list])
        records = self.ledger_records()
        self.assertEqual(records[0]["familyKey"], records[1]["familyKey"])
        self.assertNotEqual(records[0]["workKey"], records[1]["workKey"])


class OrderTests(Harness):
    def admitted_first(self, now, tokens, **kwargs):
        """Who wins the single heavy slot at `now`."""
        winners = [t for t in tokens if self.at(now, self.admit, t, **kwargs)]
        self.assertEqual(len(winners), 1, winners)
        return winners[0]

    def test_short_later_beats_long_earlier(self):
        self.at(100, self.ranked, "long", 300)
        self.at(101, self.ranked, "short", 5)
        self.assertEqual(self.admitted_first(102, ["long", "short"]), "short")

    def test_equal_estimates_keep_fifo_and_ties_break_by_sequence(self):
        self.at(100, self.ranked, "a", 50)
        self.at(100, self.ranked, "b", 50)
        self.assertEqual(self.admitted_first(101, ["b", "a"]), "a")

    def test_aged_long_beats_new_short_and_aged_are_fifo(self):
        self.at(100, self.ranked, "long", 300, age_after=50)
        self.at(110, self.ranked, "longer", 900, age_after=50)
        self.at(190, self.ranked, "short", 1)
        self.assertEqual([w["token"] for w in self.at(200, pi_phase.all_waiters, self.state)],
                         ["long", "longer", "short"])
        self.assertEqual(self.admitted_first(200, ["short", "longer", "long"]), "long")

    def test_nothing_in_class_passes_an_aged_waiter_enqueued_earlier(self):
        self.at(100, self.ranked, "old", 900, age_after=30)
        for n in range(5):
            self.at(120 + n, self.ranked, f"new{n}", 1)
        order = [w["token"] for w in self.at(131, pi_phase.all_waiters, self.state)]
        self.assertEqual(order[0], "old")
        self.assertEqual(order[1:], [f"new{n}" for n in range(5)])
        self.assertEqual([w["token"] for w in self.at(129, pi_phase.all_waiters, self.state)][-1], "old")

    def test_priority_classes_stay_first(self):
        self.assertEqual(self.done(self.start("grant-priority"))[0], 0)
        self.at(100, self.ranked, "normal-short", 1)
        self.at(101, self.ranked, "low-short", 1, priority="low")
        self.at(102, self.ranked, "high-long", 3000, priority="high")
        self.assertEqual([w["token"] for w in self.at(103, pi_phase.all_waiters, self.state)],
                         ["high-long", "normal-short", "low-short"])
        self.at(100, self.ranked, "aged-low", 1, priority="low", age_after=1)
        self.assertEqual([w["token"] for w in self.at(5000, pi_phase.all_waiters, self.state)],
                         ["high-long", "normal-short", "aged-low", "low-short"])

    def test_low_waiter_is_promoted_to_aged_normal_and_cannot_starve(self):
        # Continuous stream of normal arrivals, one admission per 10 s on a single slot; the low waiter
        # arrives first. Bound: promote_after + draining work enqueued before it (here none).
        promote = 100
        self.at(1000, self.ranked, "low", 600, priority="low", age_after=50, promote_after=promote)
        admitted_at, tick = None, 0
        for tick in range(0, 400, 10):
            now = 1001 + tick
            self.at(now, self.ranked, f"n{tick}", 1, age_after=600)
            order = [w["token"] for w in self.at(now, pi_phase.all_waiters, self.state)]
            if order[0] == "low":
                admitted_at = now
                break
            winner = order[0]
            (self.state / "waiters" / f"{winner}.json").unlink()  # the slot serves the head of the queue
        self.assertIsNotNone(admitted_at)
        self.assertLessEqual(admitted_at - 1000, promote + 10)
        # Before promotion a normal waiter always wins; after it the low waiter beats later normals only.
        self.at(1000, self.ranked, "early-normal", 900, age_after=1)
        self.assertEqual([w["token"] for w in self.at(1000 + promote + 1, pi_phase.all_waiters, self.state)][:2],
                         ["low", "early-normal"] if False else ["low", "early-normal"])
        self.assertEqual(pi_phase.waiter_order(pi_phase.metadata(self.state / "waiters" / "low.json"),
                                               1000 + promote + 1), "aged")

    def test_high_still_beats_a_promoted_low_waiter(self):
        self.assertEqual(self.done(self.start("grant-priority"))[0], 0)
        self.at(100, self.ranked, "low", 1, priority="low", promote_after=10)
        self.at(500, self.ranked, "high", 900, priority="high")
        self.assertEqual([w["token"] for w in self.at(600, pi_phase.all_waiters, self.state)], ["high", "low"])

    def test_fifo_mode_and_legacy_low_waiters_never_promote(self):
        self.at(100, self.ranked, "low", 1, priority="low", age_after=None, promote_after=None)
        self.at(200, self.ranked, "normal", 900, age_after=None)
        self.assertEqual([w["token"] for w in self.at(10**6, pi_phase.all_waiters, self.state)], ["normal", "low"])
        self.assertNotIn("promoteAt", pi_phase.metadata(self.state / "waiters" / "low.json"))

    def test_registration_derives_promotion_from_config_and_queue_timeout(self):
        options = pi_phase.config(self.config).options
        args = SimpleNamespace(kind="build", queue_timeout=1200, priority="low")
        pi_phase.prepare_policy(self.state, args, options, "fp", pi_phase.PhaseHistory([]), None)
        self.assertEqual((args.promote_after, args.age_after), (600, 600))
        args = SimpleNamespace(kind="build", queue_timeout=7200, priority="low")
        pi_phase.prepare_policy(self.state, args, options, "fp", pi_phase.PhaseHistory([]), None)
        self.assertEqual(args.promote_after, 900)
        fifo = dict(options, queue_order=dict(options["queue_order"], mode="fifo"))
        args = SimpleNamespace(kind="build", queue_timeout=7200, priority="low")
        pi_phase.prepare_policy(self.state, args, fifo, "fp", pi_phase.PhaseHistory([]), None)
        self.assertIsNone(args.promote_after)

    def test_fifo_mode_reproduces_arrival_order(self):
        self.at(100, self.ranked, "long", 900, age_after=None)
        self.at(101, self.ranked, "short", 1, age_after=None)
        self.assertEqual(self.admitted_first(102, ["short", "long"]), "long")
        self.assertEqual(pi_phase.waiter_order(pi_phase.metadata(self.state / "waiters" / "short.json"), 102), "fifo")

    def test_legacy_waiter_without_rank_fields_is_ordered_and_does_not_raise(self):
        with patch.object(pi_phase.time, "time", return_value=100):
            self.waiter("legacy")
        self.at(101, self.ranked, "fast-job", 1)
        self.at(102, self.ranked, "slow-job", 9999)
        # A legacy waiter anywhere switches the whole scan to strict priority/FIFO (see mixed-version test).
        for now in (103, 10_000):
            self.assertEqual([w["token"] for w in self.at(now, pi_phase.all_waiters, self.state)],
                             ["legacy", "fast-job", "slow-job"])

    def test_mixed_old_and_new_processes_agree_on_the_head_so_a_free_slot_is_taken(self):
        # New long waiter enqueued first, legacy (old-code) waiter later. Old processes rank by
        # (priority, enqueued, seq); the new scan must pick the same head or both yield and the slot idles.
        self.at(100, self.ranked, "new-long", 900)
        with patch.object(pi_phase.time, "time", return_value=101):
            self.waiter("legacy")
        self.at(102, self.ranked, "new-short", 1)
        for now in (103, 5000):
            scan = self.at(now, pi_phase.all_waiters, self.state)
            old_view = sorted(scan, key=pi_phase.legacy_key)  # what an old process computes
            self.assertEqual([w["token"] for w in scan], [w["token"] for w in old_view])
            self.assertEqual(scan[0]["token"], "new-long")
        self.assertEqual(self.admitted_first(103, ["legacy", "new-short", "new-long"]), "new-long")
        # Once the legacy waiter is gone the new order applies again.
        (self.state / "waiters" / "legacy.json").unlink()
        self.assertEqual(self.at(103, pi_phase.all_waiters, self.state)[0]["token"], "new-short")

    def test_malformed_rank_fields_make_the_waiter_unreadable(self):
        self.at(100, self.ranked, "ok", 5)
        path = self.state / "waiters" / "ok.json"
        data = json.loads(path.read_text())
        for bad in (-1, "x", float("nan")):
            path.write_text(json.dumps(dict(data, expected=bad)).replace("NaN", "NaN"))
            with self.assertRaises(ValueError):
                pi_phase.all_waiters(self.state)

    def test_fast_waiter_falling_back_to_heavy_keeps_its_rank(self):
        self.at(100, self.ranked, "long", 300)
        self.at(101, self.ranked, "fast-short", 2, fast=True)
        self.assertEqual(self.admitted_first(102, ["long", "fast-short"]), "fast-short")

    def test_unsatisfiable_integration_waiter_still_takes_nothing(self):
        self.at(100, self.ranked, "integration", 1, kind="integration")
        self.at(101, self.ranked, "build", 500)
        fd = pi_phase.lock_file(self.state / "integration-0.lock")
        self.addCleanup(os.close, fd)
        self.assertIsNone(self.at(102, self.admit, "integration", kind="integration"))
        self.assertTrue(self.at(102, self.admit, "build"))

    def test_registration_records_rank_fields_once(self):
        data = self.at(100, lambda: (self.ranked("x", 42.5, age_after=77, basis="family"),
                                     pi_phase.metadata(self.state / "waiters" / "x.json"))[1])
        self.assertEqual((data["expected"], data["basis"], data["ageAt"], data["enqueued"]), (42.5, "family", 177, 100))
        self.at(100, self.ranked, "f", 1, age_after=None)
        data = pi_phase.metadata(self.state / "waiters" / "f.json")
        self.assertEqual(data["ageAt"], data["enqueued"])

    def test_short_queue_timeout_bound_has_no_floor(self):
        options = pi_phase.config(self.config).options
        args = SimpleNamespace(kind="build", queue_timeout=20, priority="low")
        pi_phase.prepare_policy(self.state, args, options, "fp", pi_phase.PhaseHistory([]), None)
        self.assertEqual((args.age_after, args.promote_after), (10, 10))

    def test_eta_counts_promoted_low_waiters_ahead_and_not_unpromoted_ones(self):
        self.seed([sys.executable, "-c", "pass"], [50] * 10, kind="build")
        self.config.write_text('{"heavy_slots": 1}')
        fd = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.addCleanup(os.close, fd)
        now = time.time()
        self.at(now - 500, self.ranked, "promoted", 600, priority="low", promote_after=100)
        self.at(now - 500, self.ranked, "waiting-low", 600, priority="low", promote_after=9999)
        request = SimpleNamespace(command=["--", sys.executable, "-c", "pass"], queue_timeout=1200, kind="build")
        with patch.object(sys, "stdout", new_callable=__import__("io").StringIO) as out:
            pi_phase.wait_eta(self.state, self.config, "build", request)
        self.assertIn("ahead=1", out.getvalue())

    def test_status_lists_effective_order_with_new_fields(self):
        self.at(time.time() - 50, self.ranked, "long", 300, basis="family")
        self.at(time.time() - 40, self.ranked, "short", 5, basis="work")
        self.at(time.time() - 900, self.ranked, "aged", 800, age_after=10, basis="exact")
        self.at(time.time() - 30, self.ranked, "fifo", 1, age_after=None, basis="default")
        code, out = self.done(self.start("status"))
        self.assertEqual(code, 0, out)
        lines = [line for line in out.splitlines() if "queued priority=" in line]
        self.assertEqual([line.split("label=")[1].split()[0] for line in lines], ["aged", "fifo", "short", "long"])
        self.assertRegex(lines[0], r"waited=\d+s rank=1 expected=800s basis=exact order=aged")
        self.assertRegex(lines[1], r"rank=2 expected=1s basis=default order=fifo")
        self.assertRegex(lines[2], r"rank=3 expected=5s basis=work order=short policy=queued source=default$")
        self.assertRegex(lines[3], r"rank=4 expected=300s basis=family order=short")
        self.assertTrue(all(line.startswith("pi-phase: queued priority=") for line in lines))

    def test_status_parsers_accept_queued_lines_with_new_fields(self):
        sys.path.insert(0, str(HERE.parent / "bin"))
        self.addCleanup(sys.path.remove, str(HERE.parent / "bin"))
        import phase_status
        text = ("pi-phase: no active phases\npi-phase: queued priority=normal kind=test label=a waited=3s rank=1 "
                "expected=12s basis=work order=short fast policy=fast source=shape")
        self.assertEqual(phase_status.active_phases(text), [])

    def test_ledger_records_work_identity_and_estimate(self):
        command = [sys.executable, "-c", "pass"]
        self.seed(command, [4, 6])
        result = subprocess.run(self.cli("run", "--kind", "test", "--label", "ledger", "--timeout", "3", "--",
                                         *command), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.ledger_records()[-1]
        self.assertEqual((record["expectedS"], record["expectedBasis"]), (4.0, "exact"))
        self.assertTrue(all(len(record[k]) == 40 for k in ("workKey", "familyKey", "repoKey")))

    def test_eta_places_a_short_caller_ahead_of_long_waiters(self):
        self.seed([sys.executable, "-c", "pass"], [50] * 10, kind="build")
        self.config.write_text('{"heavy_slots": 1}')
        fd = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.addCleanup(os.close, fd)
        self.ranked("long-1", 600)
        self.ranked("long-2", 600)
        request = SimpleNamespace(command=["--", sys.executable, "-c", "pass"], queue_timeout=1200, kind="build")
        self.seed(request.command[1:], [5, 5], kind="build")
        with patch.object(sys, "stdout", new_callable=__import__("io").StringIO) as out:
            pi_phase.wait_eta(self.state, self.config, "build", request)
        self.assertIn("ahead=0", out.getvalue())

    def run_ordered(self, aged, label_first="long", label_second="short"):
        self.config.write_text('{"heavy_slots": 1, "integration_slots": 1}')
        self.state.mkdir(exist_ok=True)
        long_job, short_job = self.marker_job("long", .1), self.marker_job("short", .1)
        self.seed(long_job, [30, 30])
        self.seed(short_job, [1, 1])
        blocker = pi_phase.lock_file(self.state / "heavy-0.lock")
        try:
            jobs = []
            for label, command in (("long", long_job), ("short", short_job)):
                patch_code = ("orig = pi_phase.register_waiter\n"
                              "def register(state, args, token):\n"
                              "    args.age_after = 1.0\n"
                              "    return orig(state, args, token)\n"
                              "pi_phase.register_waiter = register\n") if aged and label == "long" else ""
                entry = ("import sys; sys.path.insert(0, sys.argv[1]); import pi_phase\n" + patch_code +
                         "sys.exit(pi_phase.main(sys.argv[4:], state=sys.argv[2], configuration=sys.argv[3]))")
                job = subprocess.Popen([sys.executable, "-B", "-c", entry, str(HERE), str(self.state),
                                        str(self.config), "run", "--kind", "test", "--label", label, "--timeout", "4",
                                        "--queue-timeout", "10", "--", *command],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                self.children.append(job)
                jobs.append(job)
                self.wait_for(lambda: len(list((self.state / "waiters").glob("*.json"))) == len(jobs), 5)
            if aged:
                time.sleep(1.4)
        finally:
            os.close(blocker)
        for job in jobs:
            code, out = self.done(job, 15)
            self.assertEqual(code, 0, out)
        return self.intervals("long", "short")

    def test_two_processes_short_waiter_starts_before_earlier_long_one(self):
        long, short = self.run_ordered(aged=False)
        self.assertLess(short[0], long[0])

    def test_two_processes_aged_long_waiter_starts_before_later_short_one(self):
        long, short = self.run_ordered(aged=True)
        self.assertLess(long[0], short[0])

    def test_killed_waiter_does_not_stall_the_queue_and_is_reaped(self):
        self.config.write_text('{"heavy_slots": 1, "integration_slots": 1}')
        self.state.mkdir(exist_ok=True)
        blocker = pi_phase.lock_file(self.state / "heavy-0.lock")
        try:
            doomed = self.run_phase(label="doomed", queue="10", command=self.marker_job("doomed", .1))
            self.wait_for(lambda: len(list((self.state / "waiters").glob("*.json"))) == 1)
            survivor = self.run_phase(label="survivor", queue="10", command=self.marker_job("survivor", .1))
            self.wait_for(lambda: len(list((self.state / "waiters").glob("*.json"))) == 2)
            doomed.send_signal(signal.SIGKILL)
            doomed.communicate(timeout=5)
        finally:
            os.close(blocker)
        code, out = self.done(survivor, 15)
        self.assertEqual(code, 0, out)
        code, out = self.done(self.start("status"))
        self.assertNotIn("queued priority=", out)
        self.assertEqual(list((self.state / "waiters").glob("*.json")), [])


class ReplayTests(unittest.TestCase):
    """Discrete-event replay of a day of anonymised heavy-lane arrivals; no subprocesses."""
    SLOTS = 3
    PATIENCE = 1800

    @classmethod
    def setUpClass(cls):
        rows = [json.loads(line) for line in (HERE / "testdata" / "queue-replay.json").read_text().splitlines()]
        cls.rows = rows
        cls.arrivals = [dict(r, index=i) for i, r in enumerate(r for r in rows if not r.get("history"))]
        done = [r for r in rows if r.get("outcome", "passed") in ("passed", "failed", "timeout") and r["runS"] > 0]
        cls.median = {k: pi_phase.percentile([r["runS"] for r in done if r["kind"] == k], 50) for k in ("build", "test")}
        events = []
        for row in rows:
            if row.get("outcome", "passed") not in ("passed", "failed", "timeout"):
                continue
            end = row["endOffset"] if "endOffset" in row else row["arr"] + row["waitS"] + row["runS"]
            record = dict(kind=row["kind"], runS=row["runS"], fingerprint=row.get("fp"),
                          workKey=(row["argv"], row["cwd"]), familyKey=row["cwd"])
            events.append((end, record))
        cls.history_events = sorted(events, key=lambda e: e[0])

    def estimates(self):
        """Causal estimates through the production cascade (history rows with end <= arrival)."""
        history, pending, result = pi_phase.PhaseHistory([]), iter(self.history_events), {}
        upcoming = next(pending, None)
        for row in self.arrivals:
            while upcoming is not None and upcoming[0] <= row["arr"]:
                history.add(upcoming[1])
                upcoming = next(pending, None)
            identity = pi_phase.WorkIdentity(None, (row["argv"], row["cwd"]), row["cwd"], "", "run", False)
            result[row["index"]] = history.estimate(identity, row.get("fp"), row["kind"], 180)[0]
        return result

    def simulate(self, mode, aging_s, estimates):
        waiting, running, waits, starts = [], [], [], 0
        patience = lambda r: r["waitS"] if r.get("outcome") == "queue-timeout" else self.PATIENCE
        arrivals, clock = list(self.arrivals), 0.0
        while arrivals or waiting or running:
            candidates = [t for t in [arrivals[0]["arr"] if arrivals else None, *(end for end in running),
                                      *(w["arr"] + patience(w) for w in waiting)] if t is not None]
            clock = max(clock, min(candidates))
            running = [end for end in running if end > clock]
            while arrivals and arrivals[0]["arr"] <= clock:
                row = arrivals.pop(0)
                after = min(aging_s, max(30, 0.5 * patience(row))) if mode == "shortest-first" else 0
                waiting.append(dict(row, priority_name=row.get("priority", "normal"), seq=row["index"],
                                    waiter=dict(priority=row.get("priority", "normal"), enqueued=row["arr"],
                                                seq=row["index"], expected=estimates[row["index"]],
                                                ageAt=row["arr"] + after)))
            waiting = [w for w in waiting if w["arr"] + patience(w) > clock]
            while len(running) < self.SLOTS and waiting:
                best = min(waiting, key=lambda w: pi_phase.queue_key(w["waiter"], clock))
                waiting.remove(best)
                waits.append(clock - best["arr"])
                running.append(clock + (best["runS"] or self.median[best["kind"]]))
        return waits

    def summary(self, waits):
        return tuple(pi_phase.percentile(waits, p) for p in (50, 90, 100))

    def test_shortest_first_beats_fifo_p90_and_keeps_the_worst_case_bounded(self):
        estimates = self.estimates()
        fifo = self.summary(self.simulate("fifo", 600, estimates))
        print("\nreplay at 3 heavy slots (seconds)      p50     p90     max")
        print(f"  fifo                              {fifo[0]:6.0f}  {fifo[1]:6.0f}  {fifo[2]:6.0f}")
        for aging in (300, 600, 900):
            with self.subTest(aging_s=aging):
                short = self.summary(self.simulate("shortest-first", aging, estimates))
                print(f"  shortest-first aging_s={aging:<4}          {short[0]:6.0f}  {short[1]:6.0f}  {short[2]:6.0f}")
                self.assertLessEqual(short[1], 0.85 * fifo[1])
                self.assertLessEqual(short[2], fifo[2] + aging)

    def test_fixture_is_anonymous(self):
        text = (HERE / "testdata" / "queue-replay.json").read_text()
        for needle in ("/", "\\", "sha", "session", "label"):
            self.assertNotIn(needle, text)
        self.assertLessEqual(len(text), 200_000)


if __name__ == "__main__":
    unittest.main()
