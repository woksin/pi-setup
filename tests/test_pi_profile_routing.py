"""pi-profile routing: active-profile-only splice of the managed routing block."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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
                            ("no newline", START)):
            with self.subTest(label):
                self.agents.write_bytes(data)
                self.original = data
                self.assert_unchanged(self.run_tool("routing"))

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
