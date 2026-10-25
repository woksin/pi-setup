"""In-place priority changes preserve locked waiter identity and admission order."""
import fcntl
import io
import json
import os
import time
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

import pi_phase
from test_queue_order import Harness


class ReprioritizeTests(Harness):
    def register(self, label, pid, priority="normal", fast=False):
        self.waiter(label, priority=priority, fast=fast)
        path = pi_phase.waiter_path(self.state, label)
        data = pi_phase.metadata(path)
        data["pid"] = pid
        path.write_text(json.dumps(data))
        return path

    def change(self, target, priority="low"):
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            code = pi_phase.main(["reprioritize", str(target), "--priority", priority],
                                 state=self.state, configuration=self.config)
        return code, output.getvalue()

    def test_pid_preserves_inode_identity_and_enqueue_fields(self):
        path = self.register("first", 101)
        before = pi_phase.metadata(path)
        inode = path.stat().st_ino
        code, output = self.change(101)
        self.assertEqual(code, 0, output)
        after = pi_phase.metadata(path)
        self.assertEqual(after["priority"], "low")
        self.assertEqual(path.stat().st_ino, inode)
        self.assertIsNone(pi_phase.lock_file(path))
        for field in ("pid", "token", "enqueued", "seq"):
            self.assertEqual(after[field], before[field])
        self.assertEqual([w["token"] for w in pi_phase.all_waiters(self.state)], ["first"])

    def test_unique_label_in_fast_queue_and_status(self):
        path = self.register("unique label", 102, fast=True)
        code, output = self.change("unique label")
        self.assertEqual(code, 0, output)
        self.assertEqual(pi_phase.metadata(path)["priority"], "low")
        output = io.StringIO()
        with redirect_stdout(output):
            pi_phase.status(self.state, self.config)
        self.assertIn("queued priority=low kind=build label=unique label", output.getvalue())

    def test_ambiguous_label_lists_pids_without_changes(self):
        first = self.register("first", 103)
        second = self.register("second", 104, fast=True)
        for path in (first, second):
            data = pi_phase.metadata(path)
            data["label"] = "duplicate"
            path.write_text(json.dumps(data))
        before = [p.read_bytes() for p in (first, second)]
        code, output = self.change("duplicate")
        self.assertEqual(code, 2, output)
        self.assertIn("103", output)
        self.assertIn("104", output)
        self.assertEqual(before, [p.read_bytes() for p in (first, second)])

    def test_other_uid_refused_by_pid_and_label(self):
        path = self.register("foreign", 105)
        before = path.read_bytes()
        with patch.object(pi_phase.os, "getuid", return_value=os.getuid() + 1):
            for target in (105, "foreign"):
                code, output = self.change(target)
                self.assertEqual(code, 3, output)
                self.assertIn("another uid", output)
        self.assertEqual(path.read_bytes(), before)

    def test_label_selects_only_callers_uid(self):
        first = self.register("first", 106)
        second = self.register("second", 107)
        for path in (first, second):
            data = pi_phase.metadata(path)
            data["label"] = "shared"
            path.write_text(json.dumps(data))
        original = pi_phase.waiter_path

        def owner_path(state, token):
            path = original(state, token)
            if token == "second":
                return SimpleNamespace(stat=lambda: SimpleNamespace(st_uid=os.getuid() + 1))
            return path

        with patch.object(pi_phase, "waiter_path", side_effect=owner_path):
            code, output = self.change("shared")
        self.assertEqual(code, 0, output)
        self.assertEqual(pi_phase.metadata(first)["priority"], "low")
        self.assertEqual(pi_phase.metadata(second)["priority"], "normal")

    def test_running_phase_and_missing_waiter_refused(self):
        self.register("running", 108)
        held = self.admit("running")
        self.assertTrue(held)
        pi_phase.publish(held, dict(token="running", pid=108, label="running", priority="normal"))
        before = (self.state / "heavy-0.json").read_bytes()
        for target in (108, "running", "absent"):
            code, output = self.change(target)
            self.assertEqual(code, 1, output)
            self.assertIn("already admitted/running", output)
        self.assertEqual((self.state / "heavy-0.json").read_bytes(), before)
        self.assertIsNone(pi_phase.lock_file(held[0][0]))

    def test_missing_state_is_not_created(self):
        self.assertEqual(self.change("missing")[0], 1)
        self.assertFalse(self.state.exists())

    def test_lowering_preserves_fifo_in_new_class(self):
        self.register("A", 109)
        self.register("B", 110)
        self.register("C", 111, priority="low")
        self.assertEqual(self.change(109)[0], 0)
        self.assertEqual([w["token"] for w in pi_phase.all_waiters(self.state)], ["B", "A", "C"])
        self.assertFalse(self.admit("A"))
        held = self.admit("B")
        self.assertTrue(held)
        pi_phase.release(self.state, held, "B", True)
        held.clear()  # The harness cleanup must not close released descriptors again.
        self.assertFalse(self.admit("C"))
        self.assertTrue(self.admit("A"))

    def test_high_without_grant_is_unchanged(self):
        path = self.register("unapproved", 112)
        before = path.read_bytes()
        code, output = self.change(112, "high")
        self.assertNotEqual(code, 0)
        self.assertIn(pi_phase.APPROVAL_REQUIRED, output)
        self.assertEqual(path.read_bytes(), before)

    def test_high_grant_cap_and_lowering_slot_accounting(self):
        self.config.write_text('{"max_high":1}')
        first = self.register("first", 113)
        second = self.register("second", 114)
        pi_phase.grant_priority(self.state, 2, None)
        self.assertEqual(self.change(113, "high")[0], 0)
        self.assertEqual(pi_phase.metadata(first)["priority"], "high")
        self.assertEqual(pi_phase.high_count(self.state), 1)
        self.assertEqual(pi_phase.priority_grant(self.state)["uses"], 1)
        code, output = self.change(114, "high")
        self.assertEqual(code, 0, output)
        self.assertIn("cap (1) reached; queued as normal", output)
        self.assertEqual(pi_phase.metadata(second)["priority"], "normal")
        self.assertEqual(pi_phase.priority_grant(self.state)["uses"], 1)
        self.assertEqual(self.change(113, "low")[0], 0)
        self.assertEqual(pi_phase.high_count(self.state), 0)
        self.assertEqual(self.change(114, "high")[0], 0)
        self.assertEqual(pi_phase.high_count(self.state), 1)
        self.assertIsNone(pi_phase.priority_grant(self.state))

    def test_expired_grant_at_cap_is_refused_without_changes(self):
        self.config.write_text('{"max_high":1}')
        pi_phase.grant_priority(self.state, 1, None)
        self.register("high", 115, priority="high")
        path = self.register("normal", 116)
        pi_phase.grant_priority(self.state, 1, None)
        grant = pi_phase.metadata(self.state / "priority-grant.json")
        grant["expires"] = time.time() - 1
        pi_phase.save(self.state / "priority-grant.json", grant)
        before = path.read_bytes()
        code, output = self.change(116, "high")
        self.assertNotEqual(code, 0)
        self.assertIn(pi_phase.APPROVAL_REQUIRED, output)
        self.assertEqual(path.read_bytes(), before)

    def test_legacy_entry_without_identity_extensions_stays_live(self):
        path = self.register("legacy", 117)
        data = pi_phase.metadata(path)
        for key in ("session", "lane", "withdraw"):
            data.pop(key, None)
        path.write_text(json.dumps(data))
        self.assertEqual(self.change(117)[0], 0)
        waiter, = pi_phase.all_waiters(self.state)
        self.assertEqual(pi_phase.legacy_key(waiter)[0], -pi_phase.PRIORITIES["low"])
        self.assertTrue(self.admit("legacy"))

    def test_same_priority_is_noop(self):
        path = self.register("same", 118)
        before = path.read_bytes()
        self.assertEqual(self.change(118, "normal")[0], 0)
        self.assertEqual(path.read_bytes(), before)

    def test_help_and_required_priority(self):
        code, output = self.done(self.start("reprioritize", "--help"))
        self.assertEqual(code, 0, output)
        self.assertIn("pid|label", output)
        self.assertIn("{low,normal,high}", output)
        code, output = self.done(self.start("reprioritize", "target"))
        self.assertEqual(code, 2, output)
        self.assertIn("--priority", output)


class ReprioritizeRunTests(Harness):
    def test_waiter_observes_priority_in_lease_and_ledger(self):
        self.config.write_text(json.dumps(dict(heavy_slots=1, max_high=1, phase_nice=0,
                                              msbuild_max_cpu=0, cold_worktree_hint=False)))
        self.state.mkdir()
        blocker = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.addCleanup(os.close, blocker)
        job = self.run_phase(label="observe", queue="20", command=self.marker_job("observe", 1.5))
        paths = lambda: list((self.state / "waiters").glob("*.json"))
        self.wait_for(lambda: bool(paths()), seconds=8)
        pid = pi_phase.metadata(paths()[0])["pid"]
        pi_phase.grant_priority(self.state, 1, None)
        code, output = self.done(self.start("reprioritize", str(pid), "--priority", "high"))
        self.assertEqual(code, 0, output)
        fcntl.flock(blocker, fcntl.LOCK_UN)
        self.wait_for(lambda: (self.state / "heavy-0.json").exists(), seconds=8)
        self.assertEqual(pi_phase.metadata(self.state / "heavy-0.json")["priority"], "high")
        code, output = self.done(job, timeout=10)
        self.assertEqual(code, 0, output)
        record, = self.ledger_records()
        self.assertEqual(record["priority"], "high")
        self.assertEqual(record["reprioritization"]["previous"], "normal")
        self.assertEqual(record["reprioritization"]["uid"], os.getuid())
