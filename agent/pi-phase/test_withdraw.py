"""Queued withdrawal is atomic with admission and never cancels a producer."""
import io
import json
import os
import sys
import time
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

import pi_phase
from test_queue_order import Harness


class WithdrawSelectionTests(Harness):
    def setUp(self):
        super().setUp()
        identity = patch.dict(os.environ, PI_SESSION_ID="owner", PI_ORCH_ID="", PI_LANE_ID="")
        identity.start()
        self.addCleanup(identity.stop)

    def withdraw(self, token=None, **changes):
        options = dict(id=token, label=None, mine=False, all=False, force=False, reason=None)
        options.update(changes)
        output = io.StringIO()
        with redirect_stdout(output):
            code = pi_phase.withdraw(self.state, SimpleNamespace(**options))
        return code, output.getvalue()

    def register(self, token, label="phase", **options):
        with patch.dict(os.environ, PI_SESSION_ID=options.get("session", "owner"),
                        PI_LANE_ID=options.get("lane", "")):
            self.waiter(token, fast=options.get("fast", False))
        path = pi_phase.waiter_path(self.state, token)
        data = json.loads(path.read_text())
        data["label"] = label
        # Keep the locked inode: save() would replace it and lose waiter liveness.
        path.write_text(json.dumps(data))
        return path

    def test_id_prefix_unlinks_waiter_before_any_later_claim(self):
        ident = "eeeeee333333"
        path = self.register(ident)
        code, output = self.withdraw(ident[:6], reason="no longer needed")
        self.assertEqual(code, 0, output)
        self.assertIn("withdrawn id=eeeeee333333", output)
        self.assertFalse(path.exists())
        self.assertFalse(self.admit(ident))
        marker = pi_phase.withdrawal(self.state, ident)
        self.assertEqual(marker["session"], "owner")
        self.assertFalse(marker["forced"])
        self.assertEqual(marker["reason"], "no longer needed")

    def test_label_and_mine_selectors_are_anded_and_all_is_required(self):
        first = self.register("aaaaaa111111", label="same")
        second = self.register("aaaaaa222222", label="same", fast=True)
        foreign = self.register("bbbbbb111111", label="same", session="other")
        different = self.register("cccccc111111", label="different")
        code, output = self.withdraw(label="same", mine=True)
        self.assertEqual(code, 2, output)
        self.assertIn("--all", output)
        self.assertTrue(first.exists() and second.exists())
        code, output = self.withdraw("aaaaaa", label="different", mine=True)
        self.assertEqual(code, 1, output)
        code, output = self.withdraw(label="same", mine=True, all=True)
        self.assertEqual(code, 0, output)
        self.assertFalse(first.exists() or second.exists())
        self.assertTrue(foreign.exists() and different.exists())
        self.assertEqual(self.withdraw(mine=True, all=True)[0], 0)
        self.assertFalse(different.exists())
        self.assertTrue(foreign.exists())

    def test_foreign_refusal_is_all_or_nothing_and_force_is_recorded(self):
        own = self.register("aaaaaa111111")
        foreign = self.register("bbbbbb111111", session="other")
        code, output = self.withdraw(label="phase", all=True)
        self.assertEqual(code, 3, output)
        self.assertTrue(own.exists() and foreign.exists())
        self.assertFalse(pi_phase.withdrawal_path(self.state, "aaaaaa111111").exists())
        code, output = self.withdraw("bbbbbb", force=True, reason="orchestrator stopped")
        self.assertEqual(code, 0, output)
        self.assertFalse(foreign.exists())
        self.assertTrue(pi_phase.withdrawal(self.state, "bbbbbb111111")["forced"])

    def test_lane_ownership_and_bounded_identity(self):
        with patch.dict(os.environ, PI_ORCH_ID="lane", PI_LANE_ID="ignored"):
            self.assertEqual(pi_phase.caller_identity(), ("owner", "lane"))
            path = self.register("aaaaaa111111", session="other")
        with patch.dict(os.environ, PI_LANE_ID="lane"):
            self.assertEqual(self.withdraw(mine=True)[0], 0)
        self.assertFalse(path.exists())
        with patch.dict(os.environ, PI_SESSION_ID="s" * 250, PI_LANE_ID="l" * 250):
            path = self.register("bbbbbb111111", session="s" * 250, lane="l" * 250)
        data = json.loads(path.read_text())
        self.assertEqual((len(data["session"]), len(data["lane"]), data["withdraw"]), (200, 200, 1))

    def test_legacy_waiter_is_refused_even_with_force(self):
        path = self.register("aaaaaa111111")
        data = json.loads(path.read_text())
        del data["withdraw"]
        path.write_text(json.dumps(data))
        code, output = self.withdraw("aaaaaa", force=True, reason="stop")
        self.assertEqual(code, 3, output)
        self.assertIn("cancel its process instead", output)
        self.assertTrue(path.exists())

    def test_admitted_lease_is_untouched(self):
        ident = "dddddd111111"
        self.register(ident)
        held = self.admit(ident)
        self.assertTrue(held)
        pi_phase.publish(held, dict(token=ident, kind="build", label="phase", pid=os.getpid()))
        before = {path: path.read_bytes() for path in self.state.glob("*.json")}
        code, output = self.withdraw(ident[:6])
        self.assertEqual(code, 1, output)
        self.assertIn("already admitted", output)
        self.assertEqual(before, {path: path.read_bytes() for path in self.state.glob("*.json")})
        self.assertIsNone(pi_phase.lock_file(held[0][0]))

    def test_stale_markers_are_pruned_but_recent_markers_remain(self):
        self.register("aaaaaa111111")
        directory = self.state / "withdrawn"
        directory.mkdir()
        old = directory / "old.json"
        recent = directory / "recent.json"
        old.write_text("{}")
        recent.write_text("{}")
        stamp = time.time() - 86401
        os.utime(old, (stamp, stamp))
        self.assertEqual(self.withdraw("aaaaaa")[0], 0)
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())

    def test_absent_state_and_unreadable_marker(self):
        self.assertEqual(self.withdraw("aaaaaa")[0], 1)
        path = pi_phase.withdrawal_path(self.state, "aaaaaa111111")
        self.assertIsNone(pi_phase.withdrawal(self.state, "aaaaaa111111"))
        path.parent.mkdir(parents=True)
        path.write_text("not json")
        self.assertIsNotNone(pi_phase.withdrawal(self.state, "aaaaaa111111"))


class WithdrawRunTests(Harness):
    def setUp(self):
        super().setUp()
        identity = patch.dict(os.environ, PI_SESSION_ID="owner", PI_ORCH_ID="", PI_LANE_ID="")
        identity.start()
        self.addCleanup(identity.stop)

    def hold(self, name):
        self.state.mkdir(exist_ok=True)
        fd = pi_phase.lock_file(self.state / (name + ".lock"))
        self.assertIsNotNone(fd)
        self.addCleanup(os.close, fd)

    def test_queued_withdrawal_exits_77_with_wait_telemetry_and_no_command(self):
        self.config.write_text(json.dumps(dict(heavy_slots=1, integration_slots=1)))
        self.hold("heavy-0")
        with patch.dict(os.environ, PI_SESSION_ID="owner", PI_ORCH_ID="", PI_LANE_ID=""):
            job = self.run_phase(label="withdraw-me", queue="20", command=self.marker_job("never"))
            paths = lambda: list((self.state / "waiters").glob("*.json"))
            self.wait_for(lambda: bool(paths()), seconds=8)
            token = paths()[0].stem
            code, status = self.done(self.start("status"), timeout=10)
            self.assertEqual(code, 0, status)
            self.assertRegex(status, r"(?m)label=withdraw-me waited=\d+s .* id=" + token[:12] + r"$")
            code, output = self.done(self.start("withdraw", token[:12], "--reason", "done elsewhere"), timeout=10)
        self.assertEqual(code, 0, output)
        code, output = self.done(job, timeout=10)
        self.assertEqual(code, 77, output)
        self.assertRegex(output, r"queued kind=test label=withdraw-me remaining=\d+s id=" + token[:12])
        self.assertFalse((self.root / "never.json").exists())
        self.assertFalse(pi_phase.waiter_path(self.state, token).exists())
        self.assertFalse(pi_phase.withdrawal_path(self.state, token).exists())
        record, = self.ledger_records()
        self.assertEqual((record["outcome"], record["exit"], record["startedAt"], record["runS"]),
                         ("withdrawn", 77, None, 0))
        self.assertEqual(record["waitV"], 1)
        self.assertAlmostEqual(sum(record["waitBreakdown"].values()), record["waitS"], delta=.02)
        self.assertEqual(record["withdrawal"], dict(session="owner", lane=None, forced=False, reason="done elsewhere"))

    def test_running_producer_is_not_withdrawn(self):
        job = self.run_phase(label="running", timeout="10", command=self.marker_job("running", 3))
        self.wait_for(lambda: any(pi_phase.metadata(path).get("label") == "running"
                                 for path in self.state.glob("heavy-*.json")), seconds=8)
        data = next(pi_phase.metadata(path) for path in self.state.glob("heavy-*.json")
                    if pi_phase.metadata(path).get("label") == "running")
        code, output = self.done(self.start("withdraw", data["token"][:12]), timeout=10)
        self.assertEqual(code, 1, output)
        self.assertIn("already admitted", output)
        self.assertIsNone(job.poll())
        code, output = self.done(job, timeout=10)
        self.assertEqual(code, 0, output)
        self.assertTrue((self.root / "running.json").exists())

    def test_usage_errors(self):
        for options in ((), ("aaaaaa", "--force"), ("abc",), ("nothex",),
                        ("aaaaaa", "--reason", "bad\nreason"), ("aaaaaa", "--reason", "x" * 121)):
            with self.subTest(options=options):
                code, output = self.done(self.start("withdraw", *options), timeout=10)
                self.assertEqual(code, 2, output)
        with patch.dict(os.environ, PI_SESSION_ID="", PI_ORCH_ID="", PI_LANE_ID=""):
            code, output = self.done(self.start("withdraw", "--mine"), timeout=10)
        self.assertEqual(code, 2, output)

    def test_stats_include_withdrawn_only_in_count_and_wait(self):
        pi_phase.append_ledger(self.state, dict(v=1, ts=pi_phase.utc_stamp(), kind="test", stack="python",
                                               startedAt=None, waitS=12, runS=0, outcome="withdrawn"))
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(pi_phase.stats(self.state, 7, None, True), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result["skipped"], 0)
        for row in result["rows"]:
            self.assertEqual((row["count"], row["withdrawn"], row["started"], row["failures"], row["queueTimeouts"]),
                             (1, 1, 0, 0, 0))
            self.assertEqual(row["waitS"], dict(p50=12, p90=12))
            self.assertEqual(row["runS"], dict(p50=None, p90=None))
        output = io.StringIO()
        with redirect_stdout(output):
            pi_phase.stats(self.state, 7, None, False)
        self.assertTrue(output.getvalue().splitlines()[0].endswith("skipped withdrawn"))


if __name__ == "__main__":
    unittest.main()
