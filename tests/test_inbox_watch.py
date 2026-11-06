"""Specs for agent/bin/inbox-watch recipient matching."""
import json
import os
import shutil
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


def moved_report(preexisting, moved):
    """Arm the marker, then rename MOVED (old mtime) into the inbox; return reported names."""
    with tempfile.TemporaryDirectory() as base:
        inbox = Path(base, "inbox")
        inbox.mkdir()
        outside = Path(base, "sibling")
        outside.mkdir()
        old = time.time() - 3600
        for name in preexisting:
            path = inbox / name
            path.write_text("x\n")
            os.utime(path, (old, old))
        env = {**os.environ, "INBOX_DIR": str(inbox)}
        first = subprocess.run(["bash", str(SCRIPT), "L1"], env=env, capture_output=True, text=True)
        assert first.returncode == 1, first.stderr
        time.sleep(1.1)
        for name in moved:
            src = outside / name
            src.write_text("x\n")
            os.utime(src, (old, old))
            os.rename(src, inbox / name)
        result = subprocess.run(["bash", str(SCRIPT), "L1"], env=env, capture_output=True, text=True)
        assert result.returncode in (0, 1), result.stderr
        return set(result.stdout.split())


class InboxDefaultSpecs(unittest.TestCase):
    def check_default(self, user=None, override=None):
        with tempfile.TemporaryDirectory() as home:
            agent = Path(home, ".pi/agent")
            fallback = agent / "inbox"
            fallback.mkdir(parents=True)
            configured = Path(home, "configured inbox")
            configured.mkdir()
            explicit = Path(home, "explicit inbox")
            explicit.mkdir()
            if user is not None:
                content = user.replace("CONFIGURED", str(configured))
                (agent / "user.json").write_text(content)
            env = {**os.environ, "HOME": home}
            env.pop("INBOX_DIR", None)
            if override is not None:
                env["INBOX_DIR"] = str(explicit) if override else ""
            result = subprocess.run(["bash", str(SCRIPT), "L66"], env=env, capture_output=True, text=True)
            if override is False:
                self.assertEqual(result.returncode, 2)
                self.assertIn("invalid INBOX_DIR", result.stderr)
                return
            self.assertEqual(result.returncode, 1, result.stderr)
            expected = explicit if override else configured if user == '{"orchMessagesDir":"CONFIGURED"}' else fallback
            self.assertTrue((expected / "L66-inbox.marker").exists())
            self.assertEqual(len(list(Path(home).rglob("*-inbox.marker"))), 1)

    def test_user_json_directory(self):
        self.check_default('{"orchMessagesDir":"CONFIGURED"}')

    def test_environment_takes_precedence(self):
        self.check_default('{"orchMessagesDir":"CONFIGURED"}', override=True)

    def test_empty_environment_is_not_replaced(self):
        self.check_default('{"orchMessagesDir":"CONFIGURED"}', override=False)

    def test_missing_user_json_falls_back(self):
        self.check_default()

    def test_missing_invalid_or_empty_setting_falls_back(self):
        for user in ({}, {"orchMessagesDir": ""}, {"orchMessagesDir": 42}, []):
            with self.subTest(user=user):
                self.check_default(json.dumps(user))
        self.check_default("{broken")


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

    def test_file_moved_into_inbox_with_old_mtime_is_reported(self):
        self.assertEqual(moved_report([], ["L2-to-L1-moved.md"]), {"L2-to-L1-moved.md"})

    def test_old_file_present_before_arming_is_not_reported(self):
        self.assertEqual(moved_report(["L2-to-L1-old.md"], []), set())

    def test_invalid_alias_is_usage_error(self):
        with tempfile.TemporaryDirectory() as inbox:
            r = subprocess.run(["bash", str(SCRIPT), "--alias", "bad name", "L1"], env={**os.environ, "INBOX_DIR": inbox}, capture_output=True, text=True)
            self.assertEqual(r.returncode, 2)


class InboxBaselineSpecs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inbox = self.root / "inbox"
        self.inbox.mkdir()
        self.env = {**os.environ, "INBOX_DIR": str(self.inbox)}

    def poll(self, *args):
        result = subprocess.run(["bash", str(SCRIPT), *(args or ("L1",))],
                                env=self.env, capture_output=True, text=True)
        self.assertIn(result.returncode, (0, 1), result.stderr)
        names = set(result.stdout.splitlines())
        self.assertEqual(result.returncode, 0 if names else 1, result.stderr)
        return names

    def old_message(self, name="L2-to-L1-old.md"):
        path = self.inbox / name
        path.write_text("x\n")
        old = time.time() - 3600
        os.utime(path, (old, old))
        return path

    def intercept(self, command, body):
        """Inject a concurrent write at a deterministic scan boundary, without sleeps."""
        bindir = self.root / "bin"
        bindir.mkdir()
        self.env["REAL_COMMAND"] = shutil.which(command)
        wrapper = bindir / command
        wrapper.write_text("#!/usr/bin/env bash\n" + body)
        wrapper.chmod(0o755)
        self.env["PATH"] = str(bindir) + os.pathsep + self.env["PATH"]

    def test_first_arm_silently_baselines_recent_and_old_messages(self):
        old = self.old_message()
        recent = self.inbox / "L2-to-L1-recent.md"
        recent.write_text("recent\n")
        self.assertEqual(self.poll(), set())
        self.assertEqual(self.poll(), set())
        self.assertEqual(set(json.loads((self.inbox / "L1-inbox.marker").read_text())),
                         {old.name, recent.name})

    def test_initial_old_then_new_and_edit_inside_overlap_are_delivered(self):
        old = self.old_message()
        original = old.stat()
        self.assertEqual(self.poll(), set())
        new = self.inbox / "L2-to-L1-new.md"
        new.write_text("new\n")
        # Exercise the overlap explicitly without depending on scheduler speed.
        overlap = int(new.stat().st_ctime) - 2
        os.utime(self.inbox / "L1-inbox.marker", (overlap, overlap))
        self.assertEqual(self.poll(), {new.name})
        old.write_text("y\n")  # same size, with the original old mtime restored
        os.utime(old, ns=(original.st_atime_ns, original.st_mtime_ns))
        self.assertIn(old.name, self.poll())

    def test_initial_old_file_renamed_back_into_inbox_is_delivered(self):
        old = self.old_message()
        self.assertEqual(self.poll(), set())
        outside = self.root / "moved.md"
        old.rename(outside)
        outside.rename(old)
        self.assertEqual(self.poll(), {old.name})

    def test_write_during_first_arm_is_not_baselined(self):
        self.intercept("python3", '''if [[ ${2:-} == record ]]; then
    printf 'concurrent\\n' > "$INBOX_DIR/L2-to-L1-concurrent.md"
fi
exec "$REAL_COMMAND" "$@"
''')
        self.assertEqual(self.poll(), set())
        self.assertEqual(self.poll(), {"L2-to-L1-concurrent.md"})

    def test_write_after_scan_listing_remains_new_on_next_poll(self):
        self.assertEqual(self.poll(), set())
        (self.inbox / "L2-to-L1-trigger.md").write_text("trigger\n")
        self.intercept("find", '''"$REAL_COMMAND" "$@" || exit $?
printf 'concurrent\\n' > "$INBOX_DIR/L2-to-L1-concurrent.md"
''')
        self.assertEqual(self.poll(), {"L2-to-L1-trigger.md"})
        self.assertIn("L2-to-L1-concurrent.md", self.poll())

    def test_legacy_empty_marker_and_alias_cc_still_deliver(self):
        marker = self.inbox / "L1-inbox.marker"
        marker.touch()
        old = time.time() - 3600
        os.utime(marker, (old, old))
        name = "L2-to-L0-cc-R-AI-topic.md"
        (self.inbox / name).write_text("alias cc\n")
        self.assertEqual(self.poll("--alias", "R-AI", "L1"), {name})


if __name__ == "__main__":
    unittest.main()
