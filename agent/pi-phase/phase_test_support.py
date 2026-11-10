"""Infrastructure ceilings and release-controlled producers for subprocess specs."""
import math
import os
from pathlib import Path
import sys


def wait_seconds(seconds):
    """Scale infrastructure waits only; behavior-under-test deadlines stay explicit."""
    try:
        scale = float(os.environ.get("PI_TEST_TIME_SCALE", "1"))
    except ValueError:
        scale = 1
    if not math.isfinite(scale):
        scale = 1
    return seconds * max(1, min(10, scale))


def held_job(root, label):
    """Record an interval, but do not finish until the test creates .release."""
    script = ("import json,pathlib,sys,time; p=pathlib.Path(sys.argv[1]); start=time.time(); "
              "p.with_suffix('.started').touch()\n"
              "while not p.with_suffix('.release').exists(): time.sleep(.02)\n"
              "p.write_text(json.dumps([start,time.time()]))")
    return [sys.executable, "-c", script, str(Path(root) / (label + ".json"))]
