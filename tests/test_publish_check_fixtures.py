"""Exact synthetic pi-phase fixtures stay scanned; runtime work areas stay unpublished."""
import subprocess
import tempfile
import unittest
from pathlib import Path

import test_sync_publish as sp

REPO = Path(__file__).resolve().parents[1]
FIXTURE_PATHS = (
    "agent/pi-phase/.gitignore",
    *(f"agent/pi-phase/testdata/failure-logs/{name}.log" for name in (
        "MSB3027", "MSB4166", "NU1101", "analyzer-IDE-CA", "blame-hang",
        "msbuild-CS", "mtp", "noise", "vitest", "vstest")),
)
ALLOWED_LOG = "agent/pi-phase/testdata/failure-logs/noise.log"
PLANT_VALUE = "Sup3r" + "S3cret!x"
PLANT_PASSWORD = "MONGODB_" + "PASSWORD=" + PLANT_VALUE + "\n"


class PublishCheckFixtureTests(unittest.TestCase):
    def make_stage(self):
        directory = tempfile.TemporaryDirectory(prefix="publish-fixtures.")
        self.addCleanup(directory.cleanup)
        return Path(directory.name)

    def put(self, stage, rel, content):
        path = stage / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def scan(self, stage, library=None):
        return subprocess.run(
            ["python3", str(REPO / "tools/publish-check.py"), str(stage),
             str(library or REPO / "agent/lib/secret-mask.ts")],
            capture_output=True, text=True, timeout=30)

    def test_exact_fixture_paths_are_allowed_and_counted_as_text(self):
        stage = self.make_stage()
        for rel in FIXTURE_PATHS:
            self.put(stage, rel, (REPO / rel).read_bytes())
        result = self.scan(stage)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("11 text files checked", result.stdout)

    def test_password_at_allowed_path_still_fails_without_echoing_value(self):
        stage = self.make_stage()
        self.put(stage, ALLOWED_LOG, PLANT_PASSWORD.encode())
        result = self.scan(stage)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"{ALLOWED_LOG}:1: password-assignment", result.stderr)
        self.assertNotIn(PLANT_VALUE, result.stdout + result.stderr)

    def test_secret_mask_at_allowed_path_still_fails(self):
        stage = self.make_stage()
        self.put(stage, ALLOWED_LOG, b"SYNTHETIC_SCAN_MARKER\n")
        library = stage.parent / (stage.name + "-scanner.ts")
        self.addCleanup(library.unlink)
        library.write_text(
            "export function scan(text: string, allow: string[] = []) {\n"
            "  const hit = text.includes('SYNTHETIC_SCAN_MARKER');\n"
            "  return { text, kinds: hit ? ['fake'] : [], count: hit ? 1 : 0, skipped: false };\n}\n")
        result = self.scan(stage, library)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"{ALLOWED_LOG}: secret-mask (fake)", result.stderr)

    def test_binary_at_allowed_path_still_fails(self):
        stage = self.make_stage()
        self.put(stage, ALLOWED_LOG, b"synthetic\0binary")
        result = self.scan(stage)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"{ALLOWED_LOG}: binary content", result.stderr)

    def test_symlink_at_allowed_path_still_fails(self):
        stage = self.make_stage()
        target = self.put(stage, "target.txt", b"synthetic text\n")
        link = stage / ALLOWED_LOG
        link.parent.mkdir(parents=True)
        link.symlink_to(target)
        result = self.scan(stage)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"{ALLOWED_LOG}: file type not allowed", result.stderr)

    def test_near_misses_and_runtime_work_areas_are_rejected(self):
        paths = (
            "agent/pi-phase/testdata/failure-logs/nested/x.log",
            "agent/pi-phase/testdata/failure-logs/new.log",
            "agent/pi-phase/other.log", "agent/bin/run.log", "agent/bin/.gitignore",
            "agent/pi-phase/testdata/x.log", "agent/bin/.ai-work/registry/.lock",
        )
        for rel in paths:
            with self.subTest(path=rel):
                stage = self.make_stage()
                self.put(stage, rel, b"synthetic text\n")
                result = self.scan(stage)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(f"{rel}: file type not allowed", result.stderr)


class RuntimeWorkAreaStagingTests(unittest.TestCase):
    setUp = sp.SyncPublishTests.setUp
    run_command = sp.SyncPublishTests.run_command

    def test_runtime_work_areas_are_not_staged_and_tracked_fixtures_are_preserved(self):
        lock = self.pi / "bin/.ai-work/retain-tests/tmpX/registry/.lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.touch()
        notes = self.pi / "pi-phase/.ai-work/notes.md"
        notes.parent.mkdir(parents=True, exist_ok=True)
        notes.write_text(PLANT_PASSWORD)
        self.run_command("./sync.sh", cwd=self.scratch)
        for rel in ("agent/bin/.ai-work", "agent/pi-phase/.ai-work"):
            self.assertFalse((self.scratch / rel).exists(), rel)
        for rel in FIXTURE_PATHS:
            self.assertEqual((self.scratch / rel).read_bytes(), (REPO / rel).read_bytes(), rel)
