"""sync.sh stages, checks and only then writes the checkout (woksin/pi-setup#11)."""
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PLANT_PASSWORD = "MONGODB_PASSWORD=Sup3rS3cret!x\n"


def snapshot(root):
    """Relative path -> (mode, sha256, mtime_ns) for every file under the published subtrees."""
    result = {}
    for directory in ("agent", "skills", "tools"):
        for path in sorted((root / directory).rglob("*")):
            if path.is_file():
                result[str(path.relative_to(root))] = (path.stat().st_mode, hashlib.sha256(path.read_bytes()).hexdigest(),
                                                       path.stat().st_mtime_ns)
    return result


class SyncPublishTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pisync.", dir="/tmp")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name) / "home"
        self.home.mkdir()
        self.env = dict(os.environ, HOME=str(self.home), TMPDIR=self.directory.name, PYTHONDONTWRITEBYTECODE="1")
        self.run_command("./install.sh", "--repos-root", "/tmp/x/repos", "--user", "tester", cwd=REPO)
        self.pi = self.home / ".pi/agent"
        self.scratch = Path(self.directory.name) / "repo"
        shutil.copytree(REPO, self.scratch, ignore=shutil.ignore_patterns(".git", ".ai-work", "__pycache__", "node_modules"))
        self.run_command("git", "init", "-q", cwd=self.scratch)
        launchd = self.home / "Library/LaunchAgents"
        launchd.mkdir(parents=True)
        username = self.run_command("id", "-un").stdout.strip()
        for name in ("docker-guardian", "pi-cleanup"):
            template = (self.scratch / f"agent/launchd/com.example.{name}.plist").read_text()
            (launchd / f"com.{username}.{name}.plist").write_text(template.replace("__HOME__", str(self.home)))

    def run_command(self, *args, cwd=None, success=True):
        result = subprocess.run(args, cwd=cwd or REPO, env=self.env, input="", text=True, capture_output=True, timeout=120)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def assert_sync_refused(self, expected_path):
        before = snapshot(self.scratch)
        result = self.run_command("./sync.sh", cwd=self.scratch, success=False)
        output = result.stdout + result.stderr
        self.assertIn(expected_path, output)
        self.assertEqual(snapshot(self.scratch), before, "checkout changed although the sync failed")
        self.assertEqual(list(Path(self.directory.name).glob("pi-sync.*")), [], "stage left behind")

    def test_clean_sync_reports_no_leaks_and_matches_the_live_tree(self):
        result = self.run_command("./sync.sh", cwd=self.scratch)
        self.assertIn("no leaks found", result.stdout + result.stderr)
        self.assertIn("no findings", result.stdout)

    def test_unknown_file_type_fails_before_the_checkout_changes(self):
        (self.pi / "extensions/creds.bin").write_bytes(b"\x00\x01opaque")
        (self.pi / "agents/new-agent.md").write_text("changed so a copy would be visible\n")
        self.assert_sync_refused("agent/extensions/creds.bin")

    def test_extensionless_file_needs_exec_bit_and_shebang(self):
        plain = self.pi / "bin/notes"
        plain.write_text("#!/bin/sh\necho hi\n")  # shebang but not executable
        self.assert_sync_refused("agent/bin/notes")

    def test_planted_password_in_markdown_fails(self):
        (self.pi / "agents/leaky.md").write_text("notes\n" + PLANT_PASSWORD)
        self.assert_sync_refused("agent/agents/leaky.md")

    def test_planted_connection_string_fails(self):
        (self.pi / "templates").mkdir(exist_ok=True)
        (self.pi / "templates/db.md").write_text("mongodb://admin:Sup3rS3cret@db.internal:27017/app\n")
        self.assert_sync_refused("agent/templates/db.md")

    def test_planted_api_key_field_in_models_json_fails(self):
        path = self.pi / "models.json"
        data = json.loads(path.read_text())
        data["providers"] = {"x": {"apiKey": "abc123def456"}}
        path.write_text(json.dumps(data))
        result = self.run_command("./sync.sh", cwd=self.scratch, success=False)
        self.assertIn("agent/models.json: secret-like field providers.x.apiKey", result.stdout + result.stderr)
        self.assertNotIn("abc123def456", result.stdout + result.stderr)

    def test_models_json_checkout_unchanged_when_api_key_planted(self):
        path = self.pi / "models.json"
        path.write_text(json.dumps({"providers": {"x": {"apiKey": "abc123def456"}}}))
        self.assert_sync_refused("agent/models.json")

    def test_reference_values_and_token_budgets_are_not_secret_fields(self):
        path = self.pi / "models.json"
        path.write_text(json.dumps({"providers": {"x": {"apiKey": "env:X_KEY", "maxTokens": 4096}}}))
        self.run_command("./sync.sh", cwd=self.scratch)

    def test_fixtures_are_skipped_by_the_text_checks_only(self):
        (self.pi / "lib/example.test.ts").write_text(PLANT_PASSWORD)
        self.run_command("./sync.sh", cwd=self.scratch)
        (self.pi / "lib/creds.bin").write_bytes(b"x")
        self.run_command("./sync.sh", cwd=self.scratch, success=False)

    def test_secret_mask_scanner_runs_when_installed_and_is_skipped_otherwise(self):
        # install.sh now provides lib/secret-mask.ts in the fake live install; "not installed" means absent there
        (self.pi / "lib/secret-mask.ts").unlink()
        skipped = self.run_command("./sync.sh", cwd=self.scratch)
        self.assertIn("secret-mask scanner not installed; skipped", skipped.stdout + skipped.stderr)
        (self.pi / "lib/secret-mask.ts").write_text(
            "export function scan(text: string, allow: string[] = []) {\n"
            "  const hit = text.includes('FAKE_TOKEN_VALUE');\n"
            "  return { text, kinds: hit ? ['fake'] : [], count: hit ? 1 : 0, skipped: false };\n}\n")
        (self.pi / "agents/flagged.md").write_text("FAKE_TOKEN_VALUE\n")
        self.assert_sync_refused("agent/agents/flagged.md")


if __name__ == "__main__":
    unittest.main()
