"""Status-only critical-path guidance; no admission/grant changes."""
import io
import os
from types import SimpleNamespace
from contextlib import redirect_stdout

import pi_phase
from test_queue_order import Harness


class CriticalPathGuidanceTests(Harness):
    def output(self, waiters):
        output = io.StringIO()
        with redirect_stdout(output):
            pi_phase.critical_path_guidance(waiters)
        return output.getvalue()

    def test_repeated_label_chain_gets_one_timeboxed_advisory(self):
        waiters = [dict(label="Release chain", kind="build"), dict(label="Release chain", kind="test")]
        original = [dict(w) for w in waiters]
        text = self.output(waiters)
        self.assertIn("label=Release chain queued=2 deepest_rank=2", text)
        self.assertIn("user approval", text)
        self.assertIn("pi-phase grant-priority --minutes 5", text)
        self.assertIn("do not promote the whole queue", text)
        self.assertEqual(text.count("critical path:"), 1)
        self.assertEqual(waiters, original)

    def test_deep_heavy_waiter_gets_guidance(self):
        waiters = [dict(label=str(i), kind="build") for i in range(4)]
        self.assertIn("label=3 queued=1 deepest_rank=4", self.output(waiters))

    def test_idle_shallow_unrelated_and_ci_waiters_are_silent(self):
        for waiters in ([], [dict(label=str(i), kind="test") for i in range(3)],
                        [dict(label="CI", kind="ci")] * 5):
            with self.subTest(waiters=waiters):
                self.assertEqual(self.output(waiters), "")

    def test_status_invokes_guidance_without_modifying_queue(self):
        self.state.mkdir(exist_ok=True)
        for token in ("one", "two"):
            args = SimpleNamespace(priority="normal", kind="build", label="same-chain", fast=False)
            ready, fd = pi_phase.register_waiter(self.state, args, token)
            self.assertTrue(ready)
            self.addCleanup(os.close, fd)
        before = {p.name: p.read_bytes() for p in (self.state / "waiters").glob("*.json")}
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(pi_phase.status(self.state, self.config), 0)
        self.assertIn("critical path: label=same-chain queued=2", output.getvalue())
        self.assertEqual(before, {p.name: p.read_bytes() for p in (self.state / "waiters").glob("*.json")})
