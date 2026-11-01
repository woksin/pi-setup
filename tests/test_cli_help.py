"""Every shipped CLI answers -h and --help in one format, with no side effects.

Discovery fails when a new tool is in neither TOOLS nor EXEMPT, so future tools stay covered.
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REFERENCE = ROOT / "docs" / "reference.md"

# name -> (path relative to the repo, subcommand words the help must mention)
TOOLS = {
    "ci-feedback": ("agent/bin/ci-feedback", []),
    "cratis-local-run": ("agent/bin/cratis-local-run", []),
    "dev-doctor": ("agent/bin/dev-doctor", []),
    "disk-growth": ("agent/bin/disk-growth", []),
    "docker-guardian": ("agent/bin/docker-guardian", []),
    "gpt-meter": ("agent/bin/gpt-meter", []),
    "inbox-watch": ("agent/bin/inbox-watch", []),
    "lane-status": ("agent/bin/lane-status", ["set", "clear", "get"]),
    "pi-account": ("agent/bin/pi-account", ["save", "use", "next", "list"]),
    "pi-cleanup": ("agent/bin/pi-cleanup", []),
    "pi-phase": ("agent/bin/pi-phase", ["status", "run", "withdraw", "report"]),
    "pi-profile": ("agent/bin/pi-profile", ["list", "use", "save"]),
    "pi-publish": ("agent/bin/pi-publish", ["check"]),
    "pi-retain": ("agent/bin/pi-retain", ["add", "release", "list", "status"]),
    "pi-setup-tests": ("agent/bin/pi-setup-tests", []),
    "pi-train": ("agent/bin/pi-train", ["init", "fold", "status", "ship"]),
    "pi-usage": ("agent/bin/pi-usage", []),
    "provider-restore": ("agent/bin/provider-restore", []),
    "reap-build-servers": ("agent/bin/reap-build-servers", []),
    "renice-builders": ("agent/bin/renice-builders", []),
    "secret-sweep": ("agent/bin/secret-sweep", []),
    "session-watchdog": ("agent/bin/session-watchdog", []),
    "publish-check": ("tools/publish-check.py", []),
    "release-check": ("tools/release-check.sh", []),
    "release-asset": ("tools/release-asset.sh", ["build", "render"]),
    "ai-work-lifecycle": ("tools/ai-work-lifecycle/ai-work-lifecycle.py", ["start", "sweep", "inventory"]),
    "sweep-known-roots": ("tools/ai-work-lifecycle/sweep-known-roots.py", []),
}

# path -> reason it has no help of its own
EXEMPT = {
    "agent/bin/bin_sweep.py": "library, no __main__",
    "agent/bin/package_cache.py": "library, no __main__",
    "agent/bin/phase_status.py": "library, no __main__",
    "agent/bin/disk_growth_probe.py": "internal; reads a JSON request on stdin",
    "agent/bin/test_lane_status.py": "test",
    "agent/bin/test_retain.py": "test",
    "agent/bin/test_session_watchdog.py": "test",
    "tools/skills.test.mjs": "test",
    "tools/bin/ai-work-lifecycle": "3-line wrapper that execs the installed copy; the source script is covered instead",
}

# Tools that ACT when run without a help flag: (help check marker, first side effect marker).
# The marker order is proven in the source before the tool is ever executed.
GUARDS = {
    "docker-guardian": ('-h|--help', 'export PATH='),
    "renice-builders": ('sys.argv[1:2]', 'sys.exit(main())'),
    "reap-build-servers": ('sys.argv[1:2]', 'sys.exit(main())'),
    "provider-restore": ('args[0] === "-h"', 'const providers'),
    "release-check": ('-h|--help', 'cd "$(dirname'),
    "pi-setup-tests": ('-h|--help', 'agent="$(cd'),
}

REQUIRED = [r"(?i)usage:", r"Examples:", r"Exit codes:", r"See also:"]

# Tools whose first argument is data (a lane, directory, provider, kind or day count): a bare
# `help` there is valid input, so only -h/--help may select help.
POSITIONAL_DATA = ["inbox-watch", "pi-setup-tests", "publish-check", "provider-restore", "cratis-local-run", "pi-usage", "renice-builders", "reap-build-servers", "docker-guardian", "release-check"]
BARE_HELP = re.compile(r"--help\|help\)|\"--help\", \"help\"|=== \"help\"")


def discovered():
    found = set()
    for pattern in ("agent/bin/*", "tools/*.py", "tools/*.sh", "tools/*.mjs", "tools/ai-work-lifecycle/*.py", "tools/bin/*"):
        found.update(p.relative_to(ROOT).as_posix() for p in ROOT.glob(pattern) if p.is_file())
    return found


def snapshot(home):
    return sorted((p.relative_to(home).as_posix(), p.lstat().st_mtime_ns, p.lstat().st_size) for p in Path(home).rglob("*"))


def run_help(relative, flag, home):
    state = Path(home, "state")
    path = ":".join(dict.fromkeys(
        [str(Path(shutil.which(tool) or "/usr/bin/" + tool).parent) for tool in ("python3", "node", "bash")] + ["/usr/bin", "/bin"]))
    env = {
        "HOME": home, "PATH": path, "PYTHONDONTWRITEBYTECODE": "1", "TMPDIR": home,
        "PI_CODING_AGENT_DIR": str(state / "agent"), "INBOX_DIR": str(state / "inbox"),
        "DOCKER_GUARDIAN_STATE": str(state / "dg"), "DOCKER_GUARDIAN_LOG": str(state / "dg.log"),
        "PI_PROVIDER_FALLBACK_STATE": str(state / "limits.json"),
    }
    return subprocess.run([str(ROOT / relative), flag], cwd=home, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=20)


class CliHelpSpecs(unittest.TestCase):
    def test_every_tool_is_covered(self):
        listed = {path for path, _ in TOOLS.values()} | set(EXEMPT)
        self.assertEqual(sorted(discovered() - listed), [], "add new tools to TOOLS (or EXEMPT with a reason)")
        self.assertEqual(sorted(listed - discovered()), [], "TOOLS/EXEMPT names a file that does not exist")

    def test_dangerous_tools_check_help_before_acting(self):
        for name, (help_marker, action_marker) in GUARDS.items():
            with self.subTest(name):
                source = (ROOT / TOOLS[name][0]).read_text()
                self.assertIn(help_marker, source)
                self.assertIn(action_marker, source)
                self.assertLess(source.index(help_marker), source.index(action_marker), f"{name}: help check must come first")

    def test_positional_help_stays_data(self):
        for name in POSITIONAL_DATA:
            with self.subTest(name):
                source = (ROOT / TOOLS[name][0]).read_text()
                self.assertIsNone(BARE_HELP.search(source), f"{name}: a bare `help` argument must stay data")

    def test_help_format_and_no_side_effects(self):
        for name, (relative, subcommands) in TOOLS.items():
            if name in GUARDS:
                source = (ROOT / relative).read_text()
                markers = GUARDS[name]
                if source.find(markers[0]) < 0 or source.find(markers[0]) > source.find(markers[1]):
                    self.fail(f"{name}: no help guard before the first side effect; not executing it")
            for flag in ("-h", "--help"):
                with self.subTest(name=name, flag=flag), tempfile.TemporaryDirectory() as home:
                    home = os.path.realpath(home)
                    before = snapshot(home)
                    result = run_help(relative, flag, home)
                    self.assertEqual(result.returncode, 0, result.stderr[-500:])
                    for pattern in REQUIRED:
                        self.assertRegex(result.stdout, pattern)
                    for word in subcommands:
                        self.assertRegex(result.stdout, rf"\b{re.escape(word)}\b")
                    self.assertEqual(snapshot(home), before, "help must not write to HOME")

    @unittest.skipUnless(REFERENCE.exists(), "written by brief B")
    def test_reference_lists_every_tool(self):
        text = REFERENCE.read_text()
        for name in TOOLS:
            with self.subTest(name):
                self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()
