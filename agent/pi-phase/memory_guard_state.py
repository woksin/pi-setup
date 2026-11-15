"""memory_guard state file, logs and the consumer view of the guard level."""
import json
import os
from pathlib import Path
import time

from memory_guard_config import STATE_NAME, number

SAMPLE_LOG_MAX = 5 * 1024 * 1024


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    os.replace(tmp, path)


def write_state(directory, state):
    atomic_write(Path(directory) / STATE_NAME, state)


def load_state(directory):
    try:
        data = json.loads((Path(directory) / STATE_NAME).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def state_fresh(data, now, stale_s):
    return number(data.get("t")) and 0 <= now - data["t"] <= stale_s and type(data.get("level")) is int


def read_level(directory, stale_s=180, now=None):
    """Guard state for consumers; missing or stale => level 1 and stale=True ("guard not running")."""
    now = time.time() if now is None else now
    data = load_state(directory)
    if not state_fresh(data, now, stale_s):
        return dict(data, level=1, stale=True, reasons=["guard not running (state missing or stale)"])
    return dict(data, stale=False)


def append_log(path, line):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        stream.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")


def rotate_append(path, record, limit=SAMPLE_LOG_MAX):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.stat().st_size > limit:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass
    with path.open("a") as stream:
        stream.write(json.dumps(record, separators=(",", ":")) + "\n")
