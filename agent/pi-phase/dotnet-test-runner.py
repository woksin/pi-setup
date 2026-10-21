"""Exit zero when the nearest global.json requests a non-MSBuild test runner."""
import json
from pathlib import Path
import sys


def uses_testing_platform():
    cwd = Path.cwd()
    for directory in (cwd, *cwd.parents):
        path = directory / "global.json"
        try:
            if path.exists():
                data = json.loads(path.read_text())
                return data.get("test", {}).get("runner") == "Microsoft.Testing.Platform"
        except (OSError, ValueError, AttributeError):
            return True  # Unknown runner: leave arguments unchanged for safety.
    return False


if __name__ == "__main__":
    sys.exit(0 if uses_testing_platform() else 1)
