"""pi-profile routing: active-profile-only splice of the managed routing block."""
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[1] / "agent/bin/pi-profile"
START = b"<!-- pi-profile:routing:start (managed) -->"
END = b"<!-- pi-profile:routing:end -->"


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.root = self.home / ".pi/agent"
        self.profile = self.root / "profiles/p"
        (self.profile / "agents").mkdir(parents=True)
        (self.root / "agents").mkdir()
        (self.root / "profiles/ACTIVE").write_text("p\n")
        (self.profile / "routing.md").write_bytes(b"new routing\r\nline 2\n")
        (self.profile / "agents/a.md").write_text("profile agent\n")
        (self.root / "agents/a.md").write_text("drifted agent\n")
        self.agents = self.root / "AGENTS.md"
        self.original = b"before\r\n" + START + b"\r\nold routing\n" + END + b"\r\nafter\r\n"
        self.agents.write_bytes(self.original)
        self.agents.chmod(0o640)

    def run_tool(self, *args):
        env = dict(os.environ, HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        return subprocess.run([sys.executable, str(TOOL), *args], env=env, text=True, capture_output=True, timeout=60)

    def assert_unchanged(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.agents.read_bytes(), self.original)
        self.assertEqual(self.agents.stat().st_mode & 0o777, 0o640)

    def test_changes_only_routing_block_and_preserves_everything_else(self):
        result = self.run_tool("routing")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.agents.read_bytes(), b"before\r\n" + START + b"\r\nnew routing\r\nline 2\n" + END + b"\r\nafter\r\n")
        self.assertEqual(self.agents.stat().st_mode & 0o777, 0o640)
        self.assertEqual((self.root / "agents/a.md").read_text(), "drifted agent\n")
        self.assertEqual((self.root / "profiles/ACTIVE").read_text(), "p\n")
        self.assertEqual((self.profile / "routing.md").read_bytes(), b"new routing\r\nline 2\n")
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith(".AGENTS")], [])

    def test_already_equal_is_a_noop(self):
        self.assertEqual(self.run_tool("routing").returncode, 0)
        before = self.agents.stat().st_mtime_ns
        result = self.run_tool("routing")
        self.assertEqual(result.returncode, 0)
        self.assertIn("already matches", result.stdout)
        self.assertEqual(self.agents.stat().st_mtime_ns, before)

    def test_marker_problems_fail_without_writing(self):
        for label, data in (("missing", b"before\nafter\n"),
                            ("duplicate", self.original + START + b"\n" + END + b"\n"),
                            ("misordered", END + b"\n" + START + b"\nold\n"),
                            ("no newline", START),
                            ("unterminated start", b"<!-- pi-profile:routing:start\nold\n" + END + b"\n"),
                            ("inline end", START + b"\nold " + END + b"\n"),
                            ("prose start", self.original.replace(START, b"prose " + START)),
                            ("prose end", self.original.replace(END, END + b" prose")),
                            ("malformed start", self.original.replace(START, b"<!-- pi-profile:routing:start --> extra")),
                            ("malformed end", self.original.replace(END, b"<!-- pi-profile:routing:end")),
                            ("malformed duplicate", self.original + b"<!-- pi-profile:routing:end\n")):
            with self.subTest(label):
                self.agents.write_bytes(data)
                self.original = data
                self.assert_unchanged(self.run_tool("routing"))

    def test_actual_metadata_and_lf_or_crlf_outside_body(self):
        actual = b"<!-- pi-profile:routing:start (managed by ~/.pi/agent/bin/pi-profile; edit profiles/<name>/routing.md instead) -->"
        for newline in (b"\n", b"\r\n"):
            with self.subTest(newline=newline):
                head = b"before" + newline + actual + newline
                tail = END + newline + b"after" + newline
                self.agents.write_bytes(head + b"old\n" + tail)
                result = self.run_tool("routing")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.agents.read_bytes(), head + (self.profile / "routing.md").read_bytes() + tail)
                self.assertEqual(self.agents.stat().st_mode & 0o777, 0o640)

    def routing_command(self):
        command = runpy.run_path(str(TOOL))["cmd_routing"]
        command.__globals__.update(PROFILES=self.root / "profiles", ACTIVE=self.root / "profiles/ACTIVE", AGENTS_MD=self.agents)
        return command

    def test_predictable_temp_collision_and_symlink_are_untouched(self):
        command = self.routing_command()
        victim = self.root / "victim"
        victim.write_bytes(b"do not overwrite\n")
        victim.chmod(0o600)
        collision = self.root / ".AGENTS.md.routing-4242"
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                self.agents.write_bytes(self.original)
                if symlink:
                    collision.symlink_to(victim)
                else:
                    collision.write_bytes(b"existing collision\n")
                with patch("os.getpid", return_value=4242):
                    command()
                self.assertEqual(victim.read_bytes(), b"do not overwrite\n")
                self.assertEqual(victim.stat().st_mode & 0o777, 0o600)
                self.assertEqual(collision.is_symlink(), symlink)
                self.assertEqual(collision.read_bytes(), victim.read_bytes() if symlink else b"existing collision\n")
                collision.unlink()

    def test_private_temp_is_synced_and_cleaned_on_replace_failure(self):
        command = self.routing_command()
        fsync = os.fsync

        def check_fsync(fd):
            self.assertEqual(os.fstat(fd).st_mode & 0o777, 0o600)
            temps = list(self.root.glob(".AGENTS.md.routing-*"))
            self.assertEqual(len(temps), 1)
            self.assertIn(b"new routing", temps[0].read_bytes())
            fsync(fd)

        with patch("os.fsync", side_effect=check_fsync) as sync, patch("os.replace", side_effect=OSError("replace failed")):
            with self.assertRaisesRegex(OSError, "replace failed"):
                command()
            sync.assert_called_once()
        self.assertEqual(self.agents.read_bytes(), self.original)
        self.assertEqual(self.agents.stat().st_mode & 0o777, 0o640)
        self.assertEqual(list(self.root.glob(".AGENTS.md.routing-*")), [])

    def test_invalid_active_or_source_fails_without_writing(self):
        (self.profile / "routing.md").write_bytes(b"\xff\xfe")
        self.assert_unchanged(self.run_tool("routing"))
        (self.profile / "routing.md").write_bytes(END + b"\n")
        self.assert_unchanged(self.run_tool("routing"))
        (self.profile / "routing.md").unlink()
        self.assert_unchanged(self.run_tool("routing"))
        (self.root / "profiles/ACTIVE").write_text("../p\n")
        self.assert_unchanged(self.run_tool("routing"))
        (self.root / "profiles/ACTIVE").write_text("missing\n")
        self.assert_unchanged(self.run_tool("routing"))
        (self.root / "profiles/ACTIVE").unlink()
        self.assert_unchanged(self.run_tool("routing"))

    def test_takes_no_profile_argument(self):
        self.assert_unchanged(self.run_tool("routing", "other"))


if __name__ == "__main__":
    unittest.main()
