"""Phase-specific SharedCompilationId and own-server cleanup (#81 step 8)."""
import io
import os
import signal
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import pi_phase

UID = os.getuid()


class CompilerIsolationTests(unittest.TestCase):
    def test_off_by_default_and_user_ids_are_kept(self):
        self.assertIsNone(pi_phase.shared_compilation_id({}, "abc"))
        self.assertIsNone(pi_phase.shared_compilation_id({"PI_PHASE_SHARED_COMPILATION": "0"}, "abc"))
        self.assertIsNone(pi_phase.shared_compilation_id(
            {"PI_PHASE_SHARED_COMPILATION": "1", "SharedCompilationId": "mine"}, "abc"))

    def test_concurrent_phases_get_distinct_ids(self):
        env = {"PI_PHASE_SHARED_COMPILATION": "1"}
        ids = {pi_phase.shared_compilation_id(env, token) for token in ("t-1111", "t-2222", "t-3333")}
        self.assertEqual(len(ids), 3)
        self.assertTrue(all(item.startswith("pi-phase-") for item in ids))

    def test_cleanup_stops_only_own_same_user_server(self):
        own = "pi-phase-t1111"
        listing = "\n".join([
            f"11 {UID} 409600 /sdk/Roslyn/bincore/VBCSCompiler -pipename:{own}",       # ours -> stop
            f"12 {UID} 409600 /sdk/Roslyn/bincore/VBCSCompiler -pipename:pi-phase-t2222",  # other worktree
            f"13 {UID} 409600 /sdk/Roslyn/bincore/VBCSCompiler -pipename:default",       # shared server
            f"14 {UID + 1} 409600 /sdk/Roslyn/bincore/VBCSCompiler -pipename:{own}",   # other user
            f"15 {UID} 1024 /bin/sh -c echo -pipename:{own}",                          # not a compiler
        ])
        kills = []
        with redirect_stdout(io.StringIO()) as out:
            stopped = pi_phase.stop_phase_compiler_server(own, listing, kill=lambda pid, sig: kills.append((pid, sig)))
        self.assertEqual(stopped, [11])
        self.assertEqual(kills, [(11, signal.SIGTERM)])
        self.assertIn("rss=400MB", out.getvalue())

    def test_cleanup_tolerates_ps_failure(self):
        with patch.object(pi_phase.subprocess, "run", side_effect=OSError):
            self.assertEqual(pi_phase.stop_phase_compiler_server("pi-phase-x"), [])


if __name__ == "__main__":
    unittest.main()
