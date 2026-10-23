"""Specs for agent/bin/inbox-watch recipient matching."""
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(os.environ.get("INBOX_WATCH", Path(__file__).resolve().parent.parent / "agent/bin/inbox-watch"))


def matches(names, *args, env=None):
    """Arm the marker, create NAMES, and return the names reported for ARGS."""
    with tempfile.TemporaryDirectory() as inbox:
        run_env = {**os.environ, "INBOX_DIR": inbox, **(env or {})}
        first = subprocess.run(["bash", str(SCRIPT), *args], env=run_env, capture_output=True, text=True)
        assert first.returncode == 1, first.stderr
        time.sleep(1.1)  # marker mtime resolution
        for name in names:
            Path(inbox, name).write_text("x\n")
        result = subprocess.run(["bash", str(SCRIPT), *args], env=run_env, capture_output=True, text=True)
        assert result.returncode in (0, 1), result.stderr
        return set(result.stdout.split())


class InboxWatchSpecs(unittest.TestCase):
    def test_broadcast_from_another_lane_is_inbound(self):
        self.assertEqual(matches(["ALL-from-L0-x.md"], "L15"), {"ALL-from-L0-x.md"})

    def test_own_broadcast_is_skipped(self):
        self.assertEqual(matches(["ALL-from-L0-x.md", "ALL-L0-status.md"], "L0"), {"ALL-L0-status.md"})

    def test_lane_after_l0_in_recipients_is_inbound(self):
        self.assertEqual(matches(["L36-to-L0-L15-L46-x.md"], "L15"), {"L36-to-L0-L15-L46-x.md"})
        self.assertEqual(matches(["L36-to-L0-L15-L46-x.md"], "L0"), {"L36-to-L0-L15-L46-x.md"})

    def test_message_only_to_l0_is_not_inbound_for_others(self):
        self.assertEqual(matches(["L36-to-L0-x.md"], "L15"), set())

    def test_alias_recipient_is_inbound(self):
        self.assertEqual(matches(["L45-to-R-AI-x.md"], "--alias", "R-AI", "L24"), {"L45-to-R-AI-x.md"})
        self.assertEqual(matches(["L45-to-R-AI-x.md"], "L24", env={"INBOX_ALIASES": "R-AI,R-Studio"}), {"L45-to-R-AI-x.md"})
        self.assertEqual(matches(["L45-to-R-AI-x.md"], "L24"), set())

    def test_own_send_is_skipped(self):
        self.assertEqual(matches(["L24-to-L0-x.md"], "L24"), set())
        self.assertEqual(matches(["R-AI-to-L0-x.md"], "--alias", "R-AI", "L24"), set())

    def test_timestamp_prefixed_names(self):
        names = ["20261023-074001-L0-to-L15-x.md", "20261023T074001-L0-to-L15-y.md",
                 "20261023-074001-ALL-from-L0-z.md", "20261023-074001-L15-to-L0-own.md",
                 "20261023-074001-L0-to-L16-other.md", "20261023-074001-L0-to-L0-l15-topic.md"]
        self.assertEqual(matches(names, "L15"),
                         {"20261023-074001-L0-to-L15-x.md", "20261023T074001-L0-to-L15-y.md",
                          "20261023-074001-ALL-from-L0-z.md"})
        self.assertEqual(matches(["20261023-074001-RETRO-to-PISETUP-L0-rule.md"], "PISETUP"),
                         {"20261023-074001-RETRO-to-PISETUP-L0-rule.md"})

    def test_lane_in_topic_is_not_a_recipient(self):
        self.assertEqual(matches(["L0-to-PISETUP-l45-machine-patch-2225.md"], "L45"), set())
        self.assertEqual(matches(["L0-to-PISETUP-l45-machine-patch-2225.md"], "PISETUP"), {"L0-to-PISETUP-l45-machine-patch-2225.md"})

    def test_multi_recipient_with_all(self):
        self.assertEqual(matches(["RETRO-to-PISETUP-L0-ALL-secret-mask.md"], "L46"), {"RETRO-to-PISETUP-L0-ALL-secret-mask.md"})

    def test_group_prefix_and_recipient(self):
        self.assertEqual(matches(["R-x.md", "L0-to-R-y.md"], "L5", "R"), {"R-x.md", "L0-to-R-y.md"})

    def test_unstructured_name_falls_back_to_token_match(self):
        self.assertEqual(matches(["PISETUP-status-note.md", "other-note.md"], "PISETUP"), {"PISETUP-status-note.md"})

    def test_invalid_alias_is_usage_error(self):
        with tempfile.TemporaryDirectory() as inbox:
            r = subprocess.run(["bash", str(SCRIPT), "--alias", "bad name", "L1"], env={**os.environ, "INBOX_DIR": inbox}, capture_output=True, text=True)
            self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
