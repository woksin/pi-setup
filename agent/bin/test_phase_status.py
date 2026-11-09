"""phase_status.active_phases: parses every state pi_phase.py's status formatter can write."""
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "pi-phase"))
import phase_status  # noqa: E402
import pi_phase  # noqa: E402

CWD = "/work/my repo/.worktrees/ps-1"


def line(state, tail=""):
    return f"pi-phase: test label pid=7 cwd={CWD} elapsed=12s {state}{tail}"


class ParseTests(unittest.TestCase):
    def one(self, text):
        phases = phase_status.active_phases(text)
        self.assertEqual(len(phases), 1, phases)
        self.assertEqual(phases[0]["cwd"], CWD)
        return phases[0]

    def test_draining_with_pids(self):
        phase = self.one(line("draining pids=43,44"))
        self.assertEqual((phase["state"], phase["pids"], phase["orphan"]), ("draining", [43, 44], False))

    def test_draining_none_and_orphan_group(self):
        phase = self.one(line("draining pids=none orphan-group"))
        self.assertEqual((phase["state"], phase["pids"], phase["orphan"]), ("draining", [], True))
        self.assertTrue(self.one(line("draining pids=5 orphan-group"))["orphan"])

    def test_draining_with_suffixes(self):
        phase = self.one(line("draining pids=none", " fast policy=fast source=shape"))
        self.assertEqual((phase["fast"], phase["policy"], phase["source"]), (True, "fast", "shape"))
        phase = self.one(line("draining pids=1,2 orphan-group", " policy=queued source=default"))
        self.assertEqual((phase["fast"], phase["policy"], phase["source"], phase["pids"]), (False, "queued", "default", [1, 2]))

    def test_running_and_orphan_keep_shape(self):
        self.assertEqual(self.one(line("running"))["state"], "running")
        phase = self.one(line("orphan-group"))
        self.assertEqual((phase["state"], phase["orphan"], phase["pids"]), ("orphan-group", True, []))

    def test_label_with_decoy_cwd_uses_the_real_cwd(self):
        text = f"pi-phase: test x pid=1 cwd=/tmp/decoy pid=7 cwd={CWD} elapsed=12s running"
        self.assertEqual(phase_status.active_phases(text)[0]["cwd"], CWD)

    def test_unknown_or_malformed_state_is_unknown(self):
        for state in ("zombie", "draining", "draining pids=", "draining pids=x", "draining pids=1 bogus"):
            self.assertIsNone(phase_status.active_phases(line(state)), state)


class FormatterDriftTests(unittest.TestCase):
    """Render lines through the real pi_phase.status formatter and parse them."""

    def render(self, data, busy, snapshot, live=frozenset()):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            state.mkdir()
            fd = pi_phase.lock_file(state / "heavy-0.lock")
            if not busy:
                os.close(fd)
                fd = None
            try:
                pi_phase.save(state / "heavy-0.json", dict(token="t", kind="test", label="l", cwd=CWD, **data))
                out = io.StringIO()
                with patch.object(pi_phase, "process_snapshot", return_value=snapshot), \
                        patch.object(pi_phase, "live_groups", return_value=set(live)), \
                        patch.object(pi_phase, "worktree_status"), redirect_stdout(out):
                    self.assertEqual(pi_phase.status(state, Path(tmp) / "config.json"), 0)
            finally:
                if fd is not None:
                    os.close(fd)
            return out.getvalue()

    def parsed(self, text):
        phases = phase_status.active_phases(text)
        self.assertIsNotNone(phases, text)
        self.assertEqual(len(phases), 1, text)
        self.assertEqual(phases[0]["cwd"], CWD)
        return phases[0]

    def test_running(self):
        me = os.getpid()
        text = self.render(dict(pid=me, pgid=me), True, {me: (1, me, "S")})
        self.assertEqual(self.parsed(text)["state"], "running")

    def test_orphan_group(self):
        text = self.render(dict(pid=42, pgid=4242), False, {42: (1, 4242, "S")}, live={4242})
        self.assertEqual(self.parsed(text)["state"], "orphan-group")

    def test_draining(self):
        text = self.render(dict(pid=42, pgid=42), True, {43: (1, 42, "S")})
        phase = self.parsed(text)
        self.assertEqual((phase["state"], phase["pids"], phase["orphan"]), ("draining", [43], False))

    def test_draining_none_and_orphan(self):
        phase = self.parsed(self.render(dict(pid=42, pgid=42), True, {}))
        self.assertEqual((phase["state"], phase["pids"]), ("draining", []))
        phase = self.parsed(self.render(dict(pid=42, pgid=4242), False, {44: (1, 4242, "S")}, live={4242}))
        self.assertEqual((phase["state"], phase["pids"], phase["orphan"]), ("draining", [44], True))


if __name__ == "__main__":
    unittest.main()
