"""The installed lifecycle wrapper supports minimal-PATH callers without live files."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

WRAPPER = Path(__file__).resolve().parent.parent / "tools/bin/ai-work-lifecycle"


class LifecycleWrapperTests(unittest.TestCase):
    def run_wrapper(self, override):
        with tempfile.TemporaryDirectory(prefix="lifecycle home ") as home:
            script = Path(home, ".local/share/ai-work-lifecycle/ai-work-lifecycle.py")
            script.parent.mkdir(parents=True)
            script.write_text("import sys; print(repr(sys.argv[1:]))\n")
            bin_dir = Path(home, "bin")
            bin_dir.mkdir()
            python = bin_dir / "custom python"
            python.symlink_to(shutil.which("python3"))
            env = {**os.environ, "HOME": home}
            env.pop("AI_WORK_LIFECYCLE_PYTHON", None)
            if override:
                env.update(PATH=str(bin_dir), AI_WORK_LIFECYCLE_PYTHON=str(python))
            else:
                (bin_dir / "python3").symlink_to(python)
                env["PATH"] = str(bin_dir)
            result = subprocess.run(["/bin/sh", str(WRAPPER), "space arg", "--help"],
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "['space arg', '--help']\n")

    def test_absolute_override_with_minimal_path_and_spaces(self):
        self.run_wrapper(override=True)

    def test_default_python_from_path(self):
        self.run_wrapper(override=False)


if __name__ == "__main__":
    unittest.main()
