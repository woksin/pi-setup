"""Host-only acceptance specs for the checksummed release bootstrap (no network)."""
import hashlib
import io
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP = ROOT / "bootstrap.sh"
ASSETS = ROOT / "tools/release-asset.sh"
TAG = "v0.0.0-test"
STUB = b'''#!/bin/sh
printf '%s\\n' "$PWD" > "$OUT/pwd"
printf '%s\\n' "$@" > "$OUT/args"
if [ -t 0 ]; then echo tty; else echo not-tty; fi > "$OUT/stdin"
cat > "$OUT/input"
exit "${STUB_EXIT:-0}"
'''


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.out = self.base / "observed"
        self.out.mkdir()
        self.release = self.base / "releases/download" / TAG
        self.release.mkdir(parents=True)
        self.archive = self.release / f"pi-setup-{TAG}.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            info = tarfile.TarInfo(f"pi-setup-{TAG}/install.sh")
            info.size = len(STUB)
            info.mode = 0o755
            archive.addfile(info, io.BytesIO(STUB))
        self.sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        sums = f"{self.sha}  {self.archive.name}\n"
        (self.release / "SHA256SUMS").write_text(sums)
        self.latest = self.base / "releases/latest/download"
        self.latest.mkdir(parents=True)
        (self.latest / "SHA256SUMS").write_text(sums)
        self.rendered = self.base / "bootstrap.sh"
        self.env = {**os.environ, "HOME": str(self.home), "OUT": str(self.out),
                    "TMPDIR": str(self.base), "PI_SETUP_RELEASES_URL": (self.base / "releases").as_uri()}
        for key in ("PI_SETUP_DIR", "PI_SETUP_BOOTSTRAP_SRC", "STUB_EXIT"):
            self.env.pop(key, None)
        self.render(self.rendered)

    def render(self, output, source=BOOTSTRAP, tag=TAG, sha=None):
        return subprocess.run(["sh", str(ASSETS), "render", tag, sha or self.sha,
                               str(source), str(output)], capture_output=True, text=True, check=True)

    def run_bootstrap(self, *args, script=None, env=None):
        return subprocess.run(["/bin/sh", "-s", "--", *args],
                              input=(script or self.rendered).read_text(), text=True,
                              capture_output=True, env={**self.env, **(env or {})},
                              cwd=self.base, start_new_session=True)

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def passed_args(self):
        return (self.out / "args").read_text().splitlines()

    def test_rendered_pin_passes_flags_and_exit_status(self):
        # No metadata is needed when the release script embeds the pin.
        (self.release / "SHA256SUMS").unlink()
        (self.latest / "SHA256SUMS").unlink()
        args = ["--yes", "--with", "lanes", "--repos-root", "/tmp/a b", "--install-prereqs"]
        result = self.run_bootstrap(*args, env={"STUB_EXIT": "3"})
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.passed_args(), args)
        self.assertEqual(Path((self.out / "pwd").read_text().strip()), self.home / "pi-setup")
        self.assertEqual((self.home / "pi-setup/.pi-setup-release").read_text(), TAG + "\n")
        self.assertIn("To update, run the same curl command again", result.stderr)

    def test_directory_flag_and_environment(self):
        for flag in (False, True):
            with self.subTest(flag=flag):
                dest = self.base / ("chosen dir" if flag else "env dir")
                args = ["--yes", "--dir", str(dest), "--with", "lanes"] if flag else ["--yes"]
                result = self.run_bootstrap(*args, env={"PI_SETUP_DIR": str(self.base / "ignored" if flag else dest)})
                self.assert_ok(result)
                self.assertEqual(self.passed_args(), ["--yes", "--with", "lanes"] if flag else ["--yes"])
                self.assertEqual(Path((self.out / "pwd").read_text().strip()), dest)
        self.assertFalse((self.home / "pi-setup").exists())

    def test_dry_run_and_plan_leave_home_unchanged_and_remove_temp_tree(self):
        for flag in ("--dry-run", "--plan"):
            with self.subTest(flag=flag):
                result = self.run_bootstrap(flag)
                self.assert_ok(result)
                self.assertEqual(self.passed_args(), [flag])
                tree = Path((self.out / "pwd").read_text().strip())
                self.assertFalse(tree.exists())
                self.assertEqual(list(self.home.iterdir()), [])
                self.assertIn("Next: run the same command without --dry-run.", result.stderr)

    def test_unrendered_resolves_latest(self):
        (self.release / "SHA256SUMS").unlink()
        self.assert_ok(self.run_bootstrap("--yes", script=BOOTSTRAP))

    def test_version_resolves_requested_metadata_even_for_rendered_script(self):
        (self.latest / "SHA256SUMS").unlink()
        self.assert_ok(self.run_bootstrap("--version", TAG, "--yes"))
        self.assertEqual(self.passed_args(), ["--yes"])

    def test_checksum_mismatch_preserves_existing_destination(self):
        dest = self.home / "pi-setup"
        dest.mkdir()
        (dest / ".pi-setup-release").write_text("old")
        (dest / "keep").write_text("unchanged")
        for existing in (True, False):
            with self.subTest(existing=existing):
                if not existing:
                    shutil.rmtree(dest)
                self.archive.write_bytes(b"corrupted")
                result = self.run_bootstrap()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("checksum", result.stderr)
                self.assertFalse((self.out / "args").exists())
                if existing:
                    self.assertEqual((dest / "keep").read_text(), "unchanged")
                else:
                    self.assertFalse(dest.exists())

    def test_native_windows_refusal(self):
        bindir = self.base / "bin"
        bindir.mkdir()
        uname = bindir / "uname"
        for platform in ("MINGW64_NT-10.0", "MSYS_NT", "CYGWIN_NT"):
            with self.subTest(platform=platform):
                uname.write_text(f"#!/bin/sh\nprintf '%s\\n' '{platform}'\n")
                uname.chmod(0o755)
                result = self.run_bootstrap(env={"PATH": str(bindir), "PI_SETUP_RELEASES_URL": "file:///missing"})
                self.assertEqual(result.returncode, 1)
                self.assertIn("WSL2", result.stderr)
                self.assertIn("https://learn.microsoft.com/windows/wsl/install", result.stderr)
                self.assertEqual(list(self.home.iterdir()), [])

    def isolated_path(self):
        bindir = self.base / "bin"
        bindir.mkdir()
        for name in ("uname", "mktemp", "rm", "grep", "tar", "gzip", "cut", "sed", "dirname",
                     "mkdir", "rmdir", "mv", "cat", "sh", "shasum"):
            tool = shutil.which(name)
            if tool:
                (bindir / name).symlink_to(tool)
        return bindir

    def test_wget_fallback(self):
        bindir = self.isolated_path()
        wget = bindir / "wget"
        wget.write_text('''#!/bin/sh
[ "$1" = -q ] && [ "$2" = -O ] || exit 2
printf called > "$OUT/wget"
/bin/cp "${4#file://}" "$3"
''')
        wget.chmod(0o755)
        self.assert_ok(self.run_bootstrap("--yes", env={"PATH": str(bindir)}))
        self.assertEqual((self.out / "wget").read_text(), "called")

    def test_missing_download_tools(self):
        bindir = self.isolated_path()
        result = self.run_bootstrap(env={"PATH": str(bindir)})
        self.assertEqual(result.returncode, 1)
        self.assertIn("curl or wget", result.stderr)
        self.assertFalse((self.home / "pi-setup").exists())

    def test_git_checkout_is_refused(self):
        dest = self.home / "pi-setup"
        dest.mkdir()
        (dest / ".git").write_text("gitdir: elsewhere")
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn("./install.sh update", result.stderr)
        self.assertEqual((dest / ".git").read_text(), "gitdir: elsewhere")

    def test_foreign_directory_is_preserved(self):
        dest = self.home / "pi-setup"
        dest.mkdir()
        (dest / ".hidden").write_text("mine")
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn("not empty", result.stderr)
        self.assertEqual(list(dest.iterdir()), [dest / ".hidden"])

    def test_bootstrap_owned_directory_is_replaced(self):
        dest = self.home / "pi-setup"
        dest.mkdir()
        (dest / ".pi-setup-release").write_text("old")
        (dest / "old").write_text("old")
        self.assert_ok(self.run_bootstrap("--yes"))
        self.assertFalse((dest / "old").exists())
        self.assertEqual((dest / ".pi-setup-release").read_text(), TAG + "\n")

    def test_empty_destination_is_used(self):
        dest = self.home / "pi-setup"
        dest.mkdir()
        self.assert_ok(self.run_bootstrap("--yes"))
        self.assertTrue((dest / "install.sh").is_file())

    def test_symlink_destination_is_refused(self):
        (self.home / "pi-setup").symlink_to(self.release, target_is_directory=True)
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn("symlink", result.stderr)
        self.assertTrue(self.archive.exists())

    def test_noninteractive_stdin_is_dev_null_not_script_pipe(self):
        self.assert_ok(self.run_bootstrap())
        self.assertEqual((self.out / "stdin").read_text(), "not-tty\n")
        self.assertEqual((self.out / "input").read_text(), "")

    def test_missing_values_fail_before_download(self):
        for args, flag in ((["--dir"], "--dir"), (["--dir", "--yes"], "--dir"),
                           (["--version"], "--version")):
            with self.subTest(args=args):
                result = self.run_bootstrap(*args, env={"PI_SETUP_RELEASES_URL": "file:///missing"})
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"Missing value for {flag}", result.stderr)

    def test_help_needs_no_download(self):
        result = self.run_bootstrap("--help", env={"PATH": "", "PI_SETUP_RELEASES_URL": "file:///missing"})
        self.assert_ok(result)
        self.assertIn("Usage:", result.stderr)
        self.assertEqual(list(self.home.iterdir()), [])

    def test_invalid_tag_is_refused(self):
        result = self.run_bootstrap("--version", "v../bad")
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid release tag", result.stderr)

    def test_ambiguous_checksum_metadata_is_refused(self):
        sums = self.latest / "SHA256SUMS"
        sums.write_text(sums.read_text() * 2)
        result = self.run_bootstrap(script=BOOTSTRAP)
        self.assertEqual(result.returncode, 1)
        self.assertIn("expected one", result.stderr)

    def test_render_validates_markers_tag_and_checksum(self):
        source = self.base / "bad.sh"
        for text, tag, sha in (("PIN_TAG=\"\"\n", TAG, self.sha),
                               (BOOTSTRAP.read_text(), "v/bad", self.sha),
                               (BOOTSTRAP.read_text(), TAG, "bad")):
            with self.subTest(tag=tag, sha=sha, text=text[:20]):
                source.write_text(text)
                result = subprocess.run(["sh", str(ASSETS), "render", tag, sha,
                                         str(source), str(self.base / "bad-render.sh")], capture_output=True)
                self.assertNotEqual(result.returncode, 0)

    def build_fixture(self, include_bootstrap):
        repo = self.base / "repo"
        repo.mkdir()
        (repo / "install.sh").write_bytes(STUB)
        if include_bootstrap:
            shutil.copyfile(BOOTSTRAP, repo / "bootstrap.sh")
        for args in (["init", "-q"], ["add", "."],
                     ["-c", "user.name=Bootstrap Test", "-c", "user.email=test@example.invalid",
                      "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]):
            subprocess.run(["git", *args], cwd=repo, env=self.env, check=True, capture_output=True)
        return repo

    def check_assets(self, out):
        archive = out / f"pi-setup-{TAG}.tar.gz"
        sha = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual((out / "SHA256SUMS").read_text(), f"{sha}  {archive.name}\n")
        rendered = out / "bootstrap.sh"
        self.assertIn(f'PIN_TAG="{TAG}"', rendered.read_text())
        self.assertIn(f'PIN_SHA256="{sha}"', rendered.read_text())
        subprocess.run(["sh", "-n", str(rendered)], check=True)
        if shutil.which("shellcheck"):
            subprocess.run(["shellcheck", "-s", "sh", str(rendered)], check=True, capture_output=True)
        with tarfile.open(archive) as tar:
            self.assertIn(f"pi-setup-{TAG}/install.sh", tar.getnames())

    def test_build_assets_from_tree(self):
        repo = self.build_fixture(include_bootstrap=True)
        # The tagged source, not an override or working-tree edit, supplies the template.
        (repo / "bootstrap.sh").write_text("not the committed template")
        out = self.base / "built"
        subprocess.run(["sh", str(ASSETS), "build", TAG, str(out), "HEAD"], cwd=repo,
                       env=self.env, check=True, capture_output=True)
        self.check_assets(out)

    def test_build_bootstrap_source_override_for_older_tag(self):
        repo = self.build_fixture(include_bootstrap=False)
        out = self.base / "built"
        subprocess.run(["sh", str(ASSETS), "build", TAG, str(out), "HEAD"], cwd=repo,
                       env={**self.env, "PI_SETUP_BOOTSTRAP_SRC": str(BOOTSTRAP)},
                       check=True, capture_output=True)
        self.check_assets(out)
        with tarfile.open(out / f"pi-setup-{TAG}.tar.gz") as tar:
            self.assertNotIn(f"pi-setup-{TAG}/bootstrap.sh", tar.getnames())


if __name__ == "__main__":
    unittest.main()
