"""Operator configuration and isolated install/sync regressions (no live HOME)."""
import importlib.util
import json
import re
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("setup_user", REPO / "setup-user.py")
setup_user = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup_user)


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="pisetup-einari.", dir="/tmp")
        self.addCleanup(self.scratch.cleanup)
        self.path = Path(self.scratch.name) / "user.json"

    def test_saved_settings_and_flag_overrides(self):
        self.path.write_text(json.dumps({"githubUser": "saved", "reposRoot": "/saved/repos"}))
        with patch.object(setup_user.shutil, "which", side_effect=AssertionError("unexpected gh")):
            self.assertEqual(setup_user.resolve(self.path, "", ""),
                             {"githubUser": "saved", "reposRoot": "/saved/repos"})
            self.assertEqual(setup_user.resolve(self.path, "einari", "/tmp/x/repos"),
                             {"githubUser": "einari", "reposRoot": "/tmp/x/repos"})

    def test_authenticated_gh_and_default_root(self):
        with patch.object(setup_user.shutil, "which", return_value="gh"), \
             patch.object(setup_user.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "einari\n")) as gh, \
             patch.object(setup_user.sys.stdin, "isatty", return_value=False):
            self.assertEqual(setup_user.resolve(self.path, "", ""),
                             {"githubUser": "einari", "reposRoot": str(Path.home() / "repos")})
            gh.assert_called_once_with(["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True)

    def test_missing_or_unauthenticated_gh_fails_noninteractively(self):
        for available in (None, "gh"):
            with self.subTest(available=available), \
                 patch.object(setup_user.shutil, "which", return_value=available), \
                 patch.object(setup_user.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "")), \
                 patch.object(setup_user.sys.stdin, "isatty", return_value=False):
                with self.assertRaisesRegex(ValueError, "pass --user"):
                    setup_user.resolve(self.path, "", "")

    def test_interactive_prompts_and_default(self):
        with patch.object(setup_user.shutil, "which", return_value=None), \
             patch.object(setup_user.sys.stdin, "isatty", return_value=True), \
             patch("builtins.input", side_effect=["einari", ""]):
            self.assertEqual(setup_user.resolve(self.path, "", "")["reposRoot"], str(Path.home() / "repos"))
        with patch.object(setup_user.sys.stdin, "isatty", return_value=True), \
             patch("builtins.input", return_value="/tmp/custom repos"):
            self.assertEqual(setup_user.resolve(self.path, "einari", "")["reposRoot"], "/tmp/custom repos")

    def test_invalid_config_or_login_fails_clearly(self):
        for contents in ("[]", '{"githubUser": 42}', '{"reposRoot": ""}', "{"):
            self.path.write_text(contents)
            with self.subTest(contents=contents), self.assertRaises(ValueError):
                setup_user.resolve(self.path, "einari", "/tmp/repos")
        self.path.unlink()
        with self.assertRaisesRegex(ValueError, "Invalid GitHub login"):
            setup_user.resolve(self.path, "--bad", "/tmp/repos")

    def test_legacy_sync_fallback_and_provenance(self):
        # Exercise sync's actual fallback arguments without touching the live install.
        command = next(line for line in (REPO / "sync.sh").read_text().splitlines()
                       if line.startswith("python3 setup-user.py normalize "))
        _, _, _, _, user, root = shlex.split(command)
        scratch = Path(self.scratch.name)
        templates = [Path(p) for p in setup_user.TEMPLATES]
        templates += [p.relative_to(REPO) for p in (REPO / "agent/loose-threads").rglob("*") if p.is_file()]
        templates += [Path("agent/lane-policy/README.md")]
        originals = {}
        for relative in templates:
            text = (REPO / relative).read_text()
            originals[relative] = text
            live = setup_user.render(text, {"githubUser": user, "reposRoot": root})
            if relative == Path("agent/AGENTS.md"):
                live = live.replace("(2026-10-20", f"({user}, 2026-10-20")
                live = live.replace("(2026-10-21", f"({user}, 2026-10-21")
            elif relative == Path("agent/bin/docker-guardian"):
                live = live.replace("Authorised (", f"Authorised by {user} (")
            dest = scratch / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(live)
        relative = Path("agent/agents/provenance.md")
        expected = "(2026-10-21)\n(2026-10-21: note)\n(2026-10-21; between 25 and 40 GiB keep going and mention it)\n{{GITHUB_USER}} {{REPOS_ROOT}}"
        originals[relative] = expected
        agent = scratch / relative
        agent.parent.mkdir(parents=True, exist_ok=True)
        agent.write_text(setup_user.render(expected, {"githubUser": user, "reposRoot": root}).replace(
            "(2026-10-21", f"({user}, 2026-10-21"))
        excluded = scratch / "agent/loose-threads/__pycache__/fixture.pyc"
        excluded.parent.mkdir()
        excluded.write_bytes(b"\xff\xfe")
        unrelated = scratch / "agent/lib/fixture.test.ts"
        unrelated.parent.mkdir()
        unrelated.write_text(f"{user} {root}")
        absent = scratch / "user.json"
        result = subprocess.run(["python3", str(REPO / "setup-user.py"), "normalize", str(absent), user, root],
                                cwd=scratch, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(absent.exists())
        self.assertEqual(excluded.read_bytes(), b"\xff\xfe")
        self.assertEqual(unrelated.read_text(), f"{user} {root}")
        for relative, text in originals.items():
            self.assertEqual((scratch / relative).read_text(), text, str(relative))

    def test_neutral_provenance_all_date_delimiters(self):
        for user in ("woksin", "einari", "some-user"):
            for suffix in (")", ": note)", "; between 25 and 40 GiB keep going and mention it)"):
                with self.subTest(user=user, suffix=suffix):
                    self.assertEqual(setup_user.normalize(f"({user}, 2026-10-21{suffix}", user, "/tmp/repos"),
                                     f"(2026-10-21{suffix}")

    def test_literal_render_and_standalone_reverse_mapping(self):
        settings = {"githubUser": "einari", "reposRoot": "/tmp/a & b/repos"}
        text = "`{{GITHUB_USER}}` --add-assignee {{GITHUB_USER}} {{REPOS_ROOT}}/owner/repo"
        rendered = setup_user.render(text, settings)
        self.assertIn("/tmp/a & b/repos/owner/repo", rendered)
        self.assertEqual(setup_user.normalize(rendered, "einari", settings["reposRoot"]), text)
        protected = "einari/repo @einari/pkg com.einari.test https://github.com/einari my-einari einari-other"
        self.assertEqual(setup_user.normalize(protected, "einari", "/tmp/repos"), protected)
        self.assertEqual(setup_user.normalize("Einari, `einari` (einari, 2026-10-20) Authorised by einari (2026-10-20)",
                                             "einari", "/tmp/repos"),
                         "{{GITHUB_USER}}, `{{GITHUB_USER}}` (2026-10-20) Authorised (2026-10-20)")


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pisetup-einari.", dir="/tmp")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.temp = tempfile.TemporaryDirectory(prefix="pisetup-einari.", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.env = dict(os.environ, HOME=str(self.home), TMPDIR=self.temp.name, PYTHONDONTWRITEBYTECODE="1")

    def run_command(self, *args, cwd=REPO, success=True):
        result = subprocess.run(args, cwd=cwd, env=self.env, input="", text=True, capture_output=True, timeout=60)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def install(self, *args):
        return self.run_command("./install.sh", *args)

    def test_argument_errors_write_nothing(self):
        for args in (("--user",), ("--repos-root", "--dry-run"), ("--unknown",), ("--user", "")):
            with self.subTest(args=args):
                self.run_command("./install.sh", *args, success=False)
                self.assertEqual(list(self.home.iterdir()), [])

    def clean_install(self):
        self.install("--dry-run", "--user", "einari", "--repos-root", "/tmp/x/repos")
        self.assertEqual(list(self.home.iterdir()), [], "dry run wrote to HOME")
        self.install("--repos-root", "/tmp/x/repos", "--user", "einari")
        pi = self.home / ".pi/agent"
        self.assertEqual(json.loads((pi / "user.json").read_text()),
                         {"githubUser": "einari", "reposRoot": "/tmp/x/repos"})
        self.assertIn("--add-assignee einari", (pi / "AGENTS.md").read_text())
        self.assertIn("--add-assignee einari", (self.home / ".agents/skills/github-issue-hygiene/SKILL.md").read_text())
        author = (REPO / "LICENSE").read_text().splitlines()[2].split()[-1]
        residuals = self.run_command("grep", "-rIn", "-i", author, str(self.home)).stdout.splitlines()
        for line in residuals:
            licence = ("/LICENSE:" in line and ":Copyright (c) " in line) or ("/package.json:" in line and '"author":' in line)  # package authorship stays
            self.assertTrue(licence or "issue-work.test.ts:" in line or f"{author}/" in line or f"com.{author}." in line, line)
        roots = self.run_command("grep", "-rIn", "/Volumes/" + "sourcecode", str(self.home), success=False)
        self.assertEqual(roots.returncode, 1, roots.stderr)
        self.assertEqual(roots.stdout, "")
        again = self.install()
        self.assertFalse(any(line.startswith("install ") for line in again.stdout.splitlines()), again.stdout)
        self.assertFalse(any(pi.rglob("*.bak-*")))
        for path in (REPO / "agent").rglob("*"):
            if path.is_file() and path.stat().st_mode & 0o111 and (pi / path.relative_to(REPO / "agent")).exists():
                self.assertEqual(path.stat().st_mode & 0o777,
                                 (pi / path.relative_to(REPO / "agent")).stat().st_mode & 0o777, str(path))
        return pi

    def test_clean_install_and_rendered_backups(self):
        pi = self.clean_install()
        original = (pi / "AGENTS.md").read_bytes()
        (pi / "settings.json").write_text('{"keep": true}\n')
        self.install("--user", "another-user", "--repos-root", "/tmp/other repos")
        self.assertIn("--add-assignee another-user", (pi / "AGENTS.md").read_text())
        self.assertEqual(next(pi.glob("AGENTS.md.bak-*")).read_bytes(), original)
        self.assertEqual(json.loads((pi / "settings.json").read_text()),
                         {"keep": True, "packages": ["./local-packages/pi-questions"]})
        self.assertEqual(json.loads(next(pi.glob("user.json.bak-*")).read_text())["githubUser"], "einari")

    def test_sync_round_trip_in_scratch_copy(self):
        self.clean_install()
        scratch = Path(self.temp.name) / "repo"
        shutil.copytree(REPO, scratch, ignore=shutil.ignore_patterns(".git", ".ai-work", "__pycache__", "node_modules"))
        self.run_command("git", "init", "-q", cwd=scratch)
        launchd = self.home / "Library/LaunchAgents"
        launchd.mkdir(parents=True)
        username = self.run_command("id", "-un").stdout.strip()
        for name in ("docker-guardian", "pi-cleanup"):
            template = scratch / f"agent/launchd/com.example.{name}.plist"
            (launchd / f"com.{username}.{name}.plist").write_text(template.read_text().replace("__HOME__", str(self.home)))
        templates = {p.relative_to(scratch): p.read_bytes() for p in scratch.rglob("*")
                     if p.is_file() and (b"{{GITHUB_USER}}" in p.read_bytes() or b"{{REPOS_ROOT}}" in p.read_bytes())}
        result = self.run_command("./sync.sh", cwd=scratch)
        self.assertIn("no leaks found", result.stdout + result.stderr)
        for path, original in templates.items():
            self.assertEqual((scratch / path).read_bytes(), original, str(path))
        for directory in ("agent", "skills", "tools"):
            for path in (scratch / directory).rglob("*"):
                if path.is_file():
                    # "einari-issues" is a fixture project/path name, not the rendered user
                    self.assertIsNone(re.search(rb"einari(?!-issues)", path.read_bytes()), str(path))
                    self.assertNotIn(b"/tmp/x/repos", path.read_bytes(), str(path))
        self.assertEqual((scratch / "agent/lib/issue-work.test.ts").read_bytes(),
                         (REPO / "agent/lib/issue-work.test.ts").read_bytes())
        print("Clean install, installed residuals (links/npm/labels + issue-work.test.ts), no old root, repeat install and byte-identical sync round-trip: passed")


if __name__ == "__main__":
    unittest.main()
