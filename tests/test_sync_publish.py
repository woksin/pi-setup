"""sync.sh stages, checks and only then writes the checkout (woksin/pi-setup#11)."""
import hashlib
import importlib.util
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


# Built at runtime so the fixture itself never looks like a committed key.
FAKE_KEY = "abc123" + "def456"

class ConfigBudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("publish_check", REPO / "tools/publish-check.py")
        cls.scanner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.scanner)

    def test_fallback_context_auto_and_number_are_non_secret_budgets(self):
        for value in ("auto", 150000):
            with self.subTest(value=value):
                node = {"maxContextTokensForFallback": value}
                self.assertEqual(list(self.scanner.config_key_findings("provider-fallback.json", node)), [])

    def test_fallback_context_real_credential_strings_and_containers_still_fail(self):
        for value in (FAKE_KEY, "auto-token-value", ["auto"], {"value": "auto"}):
            with self.subTest(value=value):
                node = {"maxContextTokensForFallback": value}
                self.assertTrue(list(self.scanner.config_key_findings("provider-fallback.json", node)))

    def test_exception_does_not_apply_to_other_files_fields_or_nested_budgets(self):
        for filename, node in (("models.json", {"maxContextTokensForFallback": "auto"}),
                               ("provider-fallback.json", {"apiKey": "auto"}),
                               ("provider-fallback.json", {"nested": {"maxContextTokensForFallback": "auto"}})):
            with self.subTest(filename=filename, node=node):
                self.assertTrue(list(self.scanner.config_key_findings(filename, node)))


class SyncPublishTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pisync.", dir="/tmp")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name) / "home"
        self.home.mkdir()
        self.env = dict(os.environ, HOME=str(self.home), TMPDIR=self.directory.name, PYTHONDONTWRITEBYTECODE="1")
        self.run_command("./install.sh", "--repos-root", "/tmp/x/repos", "--user", "tester", "--with", "cratis", "--with", "codescene", cwd=REPO)
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
        data["providers"] = {"x": {"apiKey": FAKE_KEY}}
        path.write_text(json.dumps(data))
        result = self.run_command("./sync.sh", cwd=self.scratch, success=False)
        self.assertIn("agent/models.json: secret-like field providers.x.apiKey", result.stdout + result.stderr)
        self.assertNotIn(FAKE_KEY, result.stdout + result.stderr)

    def test_models_json_checkout_unchanged_when_api_key_planted(self):
        path = self.pi / "models.json"
        path.write_text(json.dumps({"providers": {"x": {"apiKey": FAKE_KEY}}}))
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

    def fake_scanner(self, body):
        (self.pi / "lib/secret-mask.ts").write_text(body)

    def test_missing_scanner_fails_and_checkout_unchanged(self):
        (self.pi / "lib/secret-mask.ts").unlink()
        self.assert_sync_refused("secret-mask scanner missing")

    def test_scanner_findings_fail(self):
        self.fake_scanner(
            "export function scan(text: string, allow: string[] = []) {\n"
            "  const hit = text.includes('FAKE_TOKEN_VALUE');\n"
            "  return { text, kinds: hit ? ['fake'] : [], count: hit ? 1 : 0, skipped: false };\n}\n")
        (self.pi / "agents/flagged.md").write_text("FAKE_TOKEN_VALUE\n")
        self.assert_sync_refused("agent/agents/flagged.md")

    def test_skipped_scan_fails_naming_the_file_without_content(self):
        big = '{"name":"DATABASE_PASSWORD","value":"sensitive-literal"}\n' + " " * (2 * 1024 * 1024 + 10)
        (self.pi / "workflows").mkdir(exist_ok=True)
        (self.pi / "workflows/big.json").write_text(big)
        before = snapshot(self.scratch)
        result = self.run_command("./sync.sh", cwd=self.scratch, success=False)
        output = result.stdout + result.stderr
        self.assertIn("agent/workflows/big.json: secret-mask scan skipped", output)
        self.assertNotIn("sensitive-literal", output)
        self.assertEqual(snapshot(self.scratch), before)

    def test_credential_key_with_container_value_fails(self):
        for value in (["ordinary-password"], {"nested": {"v": "ordinary-password"}}):
            with self.subTest(value=value):
                (self.pi / "models.json").write_text(json.dumps({"providers": {"x": {"apiKey": value}}}))
                result = self.run_command("./sync.sh", cwd=self.scratch, success=False)
                self.assertIn("agent/models.json: secret-like field", result.stdout + result.stderr)
                self.assertNotIn("ordinary-password", result.stdout + result.stderr)
        (self.pi / "models.json").write_text(json.dumps({"providers": {"x": {"apiKey": ["env:A", "$B"]}}}))
        self.run_command("./sync.sh", cwd=self.scratch)

    def test_scanner_stderr_is_never_echoed(self):
        self.fake_scanner("console.error('SENTINEL_SECRET_ECHO');\nthrow new Error('SENTINEL_SECRET_ECHO');\n"
                          "export function scan() { return { text: '', kinds: [], count: 0, skipped: false }; }\n")
        result = self.run_command("./sync.sh", cwd=self.scratch, success=False)
        self.assertIn("secret-mask scanner failed", result.stdout + result.stderr)
        self.assertNotIn("SENTINEL_SECRET_ECHO", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
