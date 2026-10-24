#!/usr/bin/env python3
# Copyright (c) Cratis. All rights reserved.
# Licensed under the MIT license. See LICENSE file in the project root for full license information.
"""Explicit, local-only lifecycle for disposable .ai-work task resources.

Not a security boundary against a hostile process with the same filesystem rights.
See Documentation/ai-work-lifecycle.md before integrating with a host.
"""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import signal
import stat
import struct
import subprocess
import sys
import time
import uuid

MAX_RECORD = 32 * 1024 * 1024
MAX_ENTRIES = 50000
MAX_TASKS = 1000
SAFE_SUFFIXES = {".cache", ".tmp", ".log", ".stdout", ".stderr", ".pyc", ".out"}
BUILD_SUFFIXES = {".dll", ".pdb", ".exe", ".so", ".dylib", ".a", ".o", ".obj", ".lib", ".class", ".wasm", ".resources"}
PACKAGE_SUFFIXES = {".nupkg", ".jar"}
KINDS = {"scratch", "build", "package"}
# Exact generated binary leaves only; never exempt a directory or an ancestor.
GENERATED_LEAVES = {"system.data.common.dll"}
PROTECTED = re.compile(
    r"(^|[._-])(backup[s]?|cert[s]?|certificate[s]?|secret[s]?|credential[s]?|"
    r"data|database[s]?|db|dump[s]?|patch[es]*|source|src|doc[s]?|documentation|"
    r"worktree[s]?|reversal[s]?|escrow)([._-]|$)", re.I
)
NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
# Former hostnames of THIS machine, deliberately listed by its owner. gethostname()
# on macOS follows DHCP/network naming, so records written before the stable
# machine identity was introduced carry whatever name the network gave at the time.
HOST_ALIASES = Path.home() / ".config/ai-work-lifecycle/host-aliases.json"
_MACHINE = []


class Refusal(Exception):
    """An unsafe or unverifiable precondition; never bypass automatically."""


def require(condition, message):
    if not condition:
        raise Refusal(message)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


def measurements(entries):
    files = [entry for entry in entries if entry["kind"] == "file"]
    return {"files": len(files), "directories": len(entries) - len(files),
            "logical_bytes": sum(entry["stat"][3] for entry in files)}


def run(argv):
    try:
        return subprocess.run(argv, capture_output=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Refusal(f"inspection unavailable: {argv[0]}: {error}") from error


def require_local_user():
    require(os.getuid() != 0 and os.geteuid() == os.getuid(),
            "root/elevated execution refused; use the resource-owning normal user")


def machine_identity():
    """Stable host identity: hardware UUID (macOS) or machine-id (Linux), else hostname."""
    if not _MACHINE:
        value = None
        if sys.platform == "darwin":
            try:
                result = run(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
                found = re.search(rb'"IOPlatformUUID" = "([0-9A-Fa-f-]{36})"', result.stdout)
                value = found and "machine:" + found.group(1).decode().upper()
            except Refusal:
                value = None
        else:
            try:
                text = Path("/etc/machine-id").read_text().strip()
                value = re.fullmatch(r"[0-9a-f]{32}", text) and "machine:" + text
            except OSError:
                value = None
        _MACHINE.append(value or socket.gethostname())
    return _MACHINE[0]


def host_aliases():
    """Owner-maintained, private list of former (legacy) hostnames of this machine.

    Absent file = no aliases. Ancestors must be owned, real, non-shared-writable
    directories; the file is opened without following symlinks and validated on
    the open descriptor. Stable `machine:` identities are never aliasable.
    """
    for directory in (HOST_ALIASES.parent.parent, HOST_ALIASES.parent):
        try:
            info = directory.lstat()
        except FileNotFoundError:
            return set()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o022,
                f"host alias directory must be an owned, non-shared-writable real directory: {directory}")
    try:
        fd = os.open(HOST_ALIASES, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return set()
    except OSError as error:
        raise Refusal(f"host alias file refused (symlink or unreadable): {error}") from error
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o022
                and info.st_size <= 65536, "host alias file must be a private, owned regular file <= 64 KiB")
        document = json.loads(stream.read(65537))
    aliases = document.get("aliases", []) if isinstance(document, dict) else None
    require(isinstance(aliases, list) and all(isinstance(a, str) and a and not a.startswith("machine:")
                                              for a in aliases),
            "invalid host aliases (legacy hostnames only; machine: identities are not aliasable)")
    return set(aliases)


def same_machine(host):
    return host in {machine_identity(), socket.gethostname()} or host in host_aliases()


def same_process(left, right, high_resolution=False):
    """Same process: PID, user, machine and start time. With high_resolution, both
    identities must carry the microsecond start time and it must match."""
    if left is None or right is None or not (same_machine(left["host"]) and same_machine(right["host"])):
        return False
    if not all(left[key] == right[key] for key in ("pid", "uid", "started")):
        return False
    if high_resolution or ("started_us" in left and "started_us" in right):
        return isinstance(left.get("started_us"), int) and left.get("started_us") == right.get("started_us")
    return True


def start_time_us(pid):
    """Microsecond process start time from kern.proc.pid (macOS kinfo_proc), else None.

    kinfo_proc.kp_proc (extern_proc) begins with p_starttime (struct timeval) and
    has p_pid at offset 40 on 64-bit macOS; p_pid is checked as a layout guard.
    """
    if sys.platform != "darwin":
        return None
    try:
        import ctypes
        import ctypes.util
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        mib = (ctypes.c_int * 4)(1, 14, 1, pid)  # CTL_KERN, KERN_PROC, KERN_PROC_PID
        size = ctypes.c_size_t(0)
        if libc.sysctl(mib, 4, None, ctypes.byref(size), None, 0) != 0 or size.value < 48:
            return None
        buffer = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 4, buffer, ctypes.byref(size), None, 0) != 0 or size.value < 48:
            return None
        seconds, micros = struct.unpack_from("=qi", buffer.raw, 0)
        (reported_pid,) = struct.unpack_from("=i", buffer.raw, 40)
        if reported_pid != pid or seconds <= 0 or not 0 <= micros < 1_000_000:
            return None
        return seconds * 1_000_000 + micros
    except (OSError, AttributeError, ValueError, struct.error):
        return None


def parent_pid(pid):
    result = run(["ps", "-p", str(pid), "-o", "ppid="])
    text = result.stdout.decode().strip()
    return int(text) if result.returncode == 0 and text.isdigit() else None


def is_ancestor(candidate, pid=None):
    """True when CANDIDATE is a (transitive) parent of PID (default: this process)."""
    current = os.getpid() if pid is None else pid
    for _ in range(64):
        current = parent_pid(current)
        if current is None or current <= 1:
            return False
        if current == candidate:
            return True
    return False


def process_identity(pid):
    require(isinstance(pid, int) and pid > 0, "PID must be positive")
    result = run(["ps", "-p", str(pid), "-o", "uid=", "-o", "lstart="])
    require(not result.stderr, "process inspection produced diagnostics")
    if result.returncode == 1 and not result.stdout.strip():
        return None
    require(result.returncode == 0 and bool(result.stdout.strip()), "process inspection failed")
    uid, started = result.stdout.decode().strip().split(maxsplit=1)
    require(int(uid) == os.getuid(), "process belongs to another user")
    identity = {"pid": pid, "uid": int(uid), "started": started, "host": machine_identity()}
    micros = start_time_us(pid)
    if micros is not None:
        identity["started_us"] = micros
    return identity


def is_live(identity):
    require(same_machine(identity["host"]), "process owner belongs to another host")
    require(identity["uid"] == os.getuid(), "process owner belongs to another user")
    # Even PID reuse blocks. Start identity is retained for review, not used to
    # assume a reused PID is harmless (ps timestamps can have coarse resolution).
    return process_identity(identity["pid"]) is not None


def assert_no_open_handles(paths):
    """Own-user snapshot including cwd/mappings, under a no-sharing contract.

    This intentionally does NOT inspect other users. Private owned task scopes
    and cooperative same-user producers are mandatory. Diagnostics fail closed.
    """
    require_local_user()
    result = run(["lsof", "-a", "-u", str(os.getuid()), "-nP", "-Fpn"])
    require(result.returncode == 0 and not result.stderr and result.stdout.startswith(b"p"),
            "own-user open-handle inspection failed or was incomplete")
    for line in result.stdout.splitlines():
        if not line.startswith(b"n/"):
            continue
        name = os.fsdecode(line[1:])
        for path in paths:
            text = str(path)
            require(name != text and not name.startswith(text + "/"),
                    f"open process handle: {text}")


def secure_path(path, directory=None):
    """lstat every component: no lexical traversal, symlink, or special leaf."""
    require(path.is_absolute() and ".." not in path.parts, "absolute, non-traversing path required")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode), f"symlink refused: {current}")
    info = path.lstat()
    if directory is not None:
        require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),
                f"unexpected path type: {path}")
    return info


def _int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _identity_ok(value):
    return (isinstance(value, dict) and _int(value.get("pid")) and _int(value.get("uid"))
            and isinstance(value.get("started"), str) and isinstance(value.get("host"), str)
            and ("started_us" not in value or _int(value["started_us"])))


def validate_schema(record):
    """Explicit field types, so a malformed record is refused (and blocks only itself)."""
    def check(condition, field):
        require(condition, f"malformed task record: {field}")
    check(isinstance(record, dict), "record")
    check(_int(record.get("version")), "version")
    for field in ("task", "repository", "scope", "state"):
        check(isinstance(record.get(field), str), field)
    check(record.get("exclusive_disposable") is True, "exclusive_disposable")
    check(_int(record.get("uid")), "uid")
    check(_identity_ok(record.get("owner")), "owner")
    identity = record.get("scope_identity")
    check(isinstance(identity, list) and len(identity) in (2, 3) and all(_int(v) for v in identity), "scope_identity")
    check("created" not in record or _int(record["created"]), "created")
    paths, kinds, leases = record.get("paths"), record.get("kinds"), record.get("leases")
    check(isinstance(paths, list) and all(isinstance(p, str) for p in paths), "paths")
    check(isinstance(kinds, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in kinds.items()), "kinds")
    check(isinstance(leases, dict) and all(
        isinstance(k, str) and isinstance(v, dict) and _identity_ok(v.get("process")) and _int(v.get("expires"))
        for k, v in leases.items()), "leases")
    completed = record.get("completed")
    check(completed is None or (
        isinstance(completed, dict) and _int(completed.get("at")) and isinstance(completed.get("manifest"), list)
        and isinstance(completed.get("fingerprint"), str)
        and (completed.get("authorization") is None or isinstance(completed.get("authorization"), str))
        and (completed.get("owner_release") is None or isinstance(completed.get("owner_release"), dict))
        and all(isinstance(e, dict) and isinstance(e.get("path"), str) and e.get("kind") in {"file", "directory"}
                and isinstance(e.get("stat"), list) and len(e["stat"]) == 8 and all(_int(s) for s in e["stat"])
                for e in completed["manifest"])), "completed")
    receipt = record.get("receipt")
    check(receipt is None or (isinstance(receipt, dict) and isinstance(receipt.get("status"), str)), "receipt")


def stamp(info):
    return [info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink, info.st_uid]


class Lifecycle:
    def __init__(self, repository):
        require_local_user()
        require(Path(repository).is_absolute() and ".." not in Path(repository).parts,
                "repository must be absolute without traversal")
        self.repo = Path(repository)
        repo_info = secure_path(self.repo, True)
        require(repo_info.st_uid == os.getuid() and not repo_info.st_mode & 0o022,
                "repository must be owned by current user and not shared writable")
        result = run(["git", "-C", str(self.repo), "rev-parse", "--show-toplevel"])
        require(result.returncode == 0 and not result.stderr, "repository inspection failed")
        require(Path(os.fsdecode(result.stdout).strip()) == self.repo, "--repo must be the exact Git root")
        require(all(32 <= ord(c) < 127 and c != "\\" for c in str(self.repo)), "unsupported repository path characters")
        self.root = self.repo / ".ai-work"
        root_info = secure_path(self.root, True)
        require(root_info.st_uid == os.getuid() and not root_info.st_mode & 0o022,
                ".ai-work must be owned by current user and not shared writable")
        self.meta = self.root / ".lifecycle"
        self.validate_git()

    def validate_git(self):
        result = run(["git", "-C", str(self.repo), "ls-files", "--cached", "-z", "--", ".ai-work"])
        require(result.returncode == 0 and not result.stderr, "Git tracked-file inspection failed")
        require(not result.stdout, "tracked .ai-work content exists: report and obtain manual authorization")
        result = run(["git", "-C", str(self.repo), "check-ignore", "-q", ".ai-work/.lifecycle/probe"])
        require(result.returncode == 0 and not result.stderr, ".ai-work lifecycle records must be Git-ignored")

    def metadata_safe(self, path, directory):
        info = secure_path(path, directory)
        require(info.st_uid == os.getuid(), "foreign metadata owner")
        require(stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600), "metadata must remain private")
        require(directory or info.st_nlink == 1, "hardlinked metadata refused")
        return info

    @contextmanager
    def locked(self, initialize=False):
        if not self.meta.exists():
            require(not self.meta.is_symlink(), "symlink metadata refused")
            if not initialize:
                yield False
                return
            self.meta.mkdir(mode=0o700)
        self.metadata_safe(self.meta, True)
        lock = self.meta / "lock"
        if initialize and not lock.exists():
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        self.metadata_safe(lock, False)
        fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Refusal("lifecycle is locked by another operation") from error
            self.validate_git()
            yield True
        finally:
            os.close(fd)

    def record_path(self, task):
        require(isinstance(task, str) and NAME.fullmatch(task), "invalid task/worker name")
        return self.meta / f"task-{task}.json"

    def read_record(self, task):
        path = self.record_path(task)
        require(self.metadata_safe(path, False).st_size <= MAX_RECORD, "oversized task record")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            try:
                record = json.loads(stream.read(MAX_RECORD + 1))
            except ValueError as error:
                raise Refusal(f"malformed task record JSON: {error}") from error
        validate_schema(record)
        require(record["version"] == 2 and record["task"] == task
                and record["repository"] == str(self.repo)
                and record["scope"] == f"tasks/{task}"
                and record["exclusive_disposable"] is True
                and record["uid"] == os.getuid() and record["owner"]["uid"] == os.getuid(),
                "invalid/foreign task ownership record (v2 required)")
        require(same_machine(record["owner"]["host"]),
                f"task owner host {record['owner']['host']!r} is not this machine; if it is a former "
                f"name of this machine, list it in {HOST_ALIASES}")
        require(record["state"] in {"active", "paused", "completed"}, "invalid task state")
        require(len(record["leases"]) <= 64 and len(record["paths"]) <= 64, "oversized task resources")
        require(len(set(record["paths"])) == len(record["paths"]), "duplicate registered paths")
        require(set(record["kinds"]) == set(record["paths"]) and all(k in KINDS for k in record["kinds"].values()),
                "invalid resource classification")
        for value in record["paths"]:
            self.resource_path(record, value, exists=False)
        return record

    def save(self, record):
        payload = encode(record) + b"\n"
        require(len(payload) <= MAX_RECORD, "task record exceeds bounded size")
        destination = self.record_path(record["task"])
        if destination.exists() or destination.is_symlink():
            self.metadata_safe(destination, False)
        temporary = self.meta / f".write-{uuid.uuid4().hex}"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            directory = os.open(self.meta, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary.exists():
                temporary.unlink()

    def tasks(self, strict=True):
        """Strict: every record must validate. Non-strict (reports): names only;
        each unreadable record is reported as blocked by plan_task instead of
        failing the whole registry."""
        tasks = []
        for path in sorted(self.meta.iterdir()):
            if path.name == "lock":
                continue
            if not strict and not (path.name.startswith("task-") and path.suffix == ".json"):
                continue
            require(path.name.startswith("task-") and path.suffix == ".json", "unexpected metadata; manual review required")
            task = path.name[5:-5]
            if strict:
                self.read_record(task)
            elif not NAME.fullmatch(task):
                continue
            tasks.append(task)
        require(len(tasks) <= MAX_TASKS, "task record limit reached; review retained records manually")
        return tasks

    def readable(self, names):
        records = []
        for name in names:
            try:
                records.append(self.read_record(name))
            except (Refusal, OSError, ValueError, KeyError, TypeError):
                pass
        return records

    def create(self, task, pid, declaration):
        require(declaration, "explicit exclusive disposable resource declaration required")
        path = self.record_path(task)
        require(not path.exists() and not path.is_symlink(), "task already exists")
        require(len(self.tasks(strict=False)) < MAX_TASKS, "task record limit reached")
        owner = process_identity(pid)
        require(owner is not None, "owner process is not running")
        tasks = self.root / "tasks"
        if not tasks.exists() and not tasks.is_symlink():
            tasks.mkdir(mode=0o700)
        tasks_info = secure_path(tasks, True)
        require(tasks_info.st_uid == os.getuid() and not tasks_info.st_mode & 0o022, "unsafe tasks container")
        scope = tasks / task
        require(not scope.exists() and not scope.is_symlink(), "existing task scope is report-only; choose a new task ID")
        scope.mkdir(mode=0o700)
        info = scope.lstat()
        # Inode plus (where available) creation time identify the container; the device
        # number is recorded but may be renumbered by the OS (see validate_scope).
        identity = [info.st_dev, info.st_ino] + (
            [int(info.st_birthtime * 1_000_000_000)] if hasattr(info, "st_birthtime") else [])
        record = {"version": 2, "task": task, "repository": str(self.repo), "scope": f"tasks/{task}",
                  "uid": os.getuid(), "scope_identity": identity, "created": int(time.time()),
                  "exclusive_disposable": True, "owner": owner, "state": "active", "paths": [], "kinds": {},
                  "leases": {}, "completed": None, "receipt": None}
        self.validate_scope(record)
        self.save(record)
        return record

    def start(self, task, pid):
        """Invocation declares new cache/output disposable; keep is never registered."""
        record = self.create(task, pid, True)
        scope = self.root / record["scope"]
        paths = {name: str(scope / name) for name in ("keep", "cache", "output")}
        for path in paths.values():
            Path(path).mkdir(mode=0o700)
        for name, kind in (("cache", "package"), ("output", "build")):
            self.register(task, f"{record['scope']}/{name}", kind)
        return {"task": task, **paths, "declaration": "exclusive disposable cache/output; retained keep"}

    def finish(self, task, apply=False):
        original = self.read_record(task)
        if not apply:
            if original["state"] == "completed":
                plan = self.plan_task(task, authorized=True)
                return {"mode": "dry-run", "registered_paths": len(original["paths"]),
                        **{key: value for key, value in plan.items() if key != "manifest"}}
            preview = {"mode": "dry-run", "task": task, "paths": sorted(original["paths"]),
                       "registered_paths": len(original["paths"]), "status": "blocked"}
            try:
                entries = self.snapshot(original)
                preview.update(measurements(entries))
                self.check_leases(original)
                assert_no_open_handles([self.resource_path(original, p) for p in original["paths"]])
                require(self.snapshot(original) == entries, "resources changed during preview")
                require(original["paths"], "no disposable paths registered")
                preview["status"] = "ready-to-finish"
            except (Refusal, OSError) as error:
                preview["reason"] = str(error)[:512]
            return preview
        try:
            self.complete(task, authorize_cleanup=True, release_owner=True)
            result = self.sweep(True, task, apply=True, authorized=True)
            require(all(p["status"] == "already-cleaned" for p in result["skipped"]),
                    "finish blocked: " + "; ".join(p.get("reason", p["status"]) for p in result["skipped"]))
            return result
        except (Refusal, OSError, KeyboardInterrupt):
            # A failed immediate cleanup must not leave NEW standing authorization.
            if original["state"] != "completed" and not self.read_record(task)["receipt"]:
                self.save(original)
            raise

    def validate_scope(self, record):
        """Returns (current_dev, recorded_dev) when the volume was renumbered, else None.

        macOS assigns st_dev per mount, so an APFS volume can come back with a
        different device number after a reboot/remount while every inode is intact.
        A renumbered device is accepted only when the container's inode (and, for
        newer records, its creation time) still match AND it lives on the same
        device as this registry's .ai-work today. A recreated container gets a new
        inode/birth time and still blocks.
        """
        tasks_dir = self.root / "tasks"
        require(tasks_dir.exists() or tasks_dir.is_symlink(),
                "tasks/ container missing: task scope was removed outside the lifecycle (report-only)")
        scope = self.root / record["scope"]
        require(scope.exists() or scope.is_symlink(),
                "task scope missing: removed outside the lifecycle (report-only)")
        info = secure_path(scope, True)
        require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
                "task scope must remain owned by current user and exactly 0700 (no sharing)")
        recorded = record["scope_identity"]
        require(isinstance(recorded, list) and len(recorded) in (2, 3), "invalid task container identity")
        require(info.st_ino == recorded[1], "private task container identity changed (inode)")
        if len(recorded) == 3:
            require(hasattr(info, "st_birthtime") and int(info.st_birthtime * 1_000_000_000) == recorded[2],
                    "private task container identity changed (creation time)")
        remap = None
        if info.st_dev != recorded[0]:
            require(info.st_dev == secure_path(self.root, True).st_dev,
                    "private task container identity changed (device)")
            remap = (info.st_dev, recorded[0])
        # chmod(0700) alone does not exclude macOS inherited ACL grants.
        if sys.platform == "darwin":
            result = run(["/bin/ls", "-lde", str(scope)])
            require(result.returncode == 0 and not result.stderr and result.stdout.split(), "ACL inspection failed")
            require(b"+" not in result.stdout.split()[0] and len(result.stdout.splitlines()) == 1,
                    "task container ACL refused")
        elif sys.platform.startswith("linux"):
            require(not any(name.startswith("system.posix_acl_") for name in os.listxattr(scope)),
                    "task container ACL refused")
        else:
            raise Refusal("private-scope ACL inspection unsupported on this platform")
        return remap

    def resource_path(self, record, value, exists=True, generated_leaf=False):
        require(isinstance(value, str) and len(value) <= 1024, "invalid resource path")
        parts = PurePosixPath(value).parts
        require(value == "/".join(parts) and len(parts) >= 3 and parts[:2] == ("tasks", record["task"])
                and parts[2] in {"cache", "output"} and not any(p in {".", "..", ".git"} for p in parts),
                "path must be a literal tasks/TASK/cache or tasks/TASK/output descendant")
        checked = parts[:-1] if generated_leaf and parts[-1].lower() in GENERATED_LEAVES else parts
        require(not any(PROTECTED.search(p) for p in checked), "protected resource name")
        path = self.root.joinpath(*parts)
        if exists:
            secure_path(path, True)
        return path

    def snapshot(self, record):
        remap = self.validate_scope(record)
        entries = []
        root_device = self.root.stat().st_dev

        def visit(path, kind):
            require(len(entries) < MAX_ENTRIES, "manifest entry limit reached")
            info = secure_path(path)
            require(info.st_dev == root_device and not os.path.ismount(path), "mount boundary refused")
            relative = path.relative_to(self.root).as_posix()
            require(all(32 <= ord(c) < 127 and c != "\\" for c in relative), "unsupported resource path characters")
            parts = path.relative_to(self.root).parts
            if kind == "build" and stat.S_ISREG(info.st_mode) and path.name.lower() in GENERATED_LEAVES:
                parts = parts[:-1]
            require(not any(p == ".git" or PROTECTED.search(p) for p in parts), f"protected path: {relative}")
            require(not info.st_mode & 0o022, f"shared writable resource: {relative}")
            require(info.st_uid == os.getuid(), f"foreign resource owner: {relative}")
            entry = {"path": relative, "stat": stamp(info), "kind": "directory"}
            entries.append(entry)
            if stat.S_ISDIR(info.st_mode):
                for child in sorted(path.iterdir()):
                    visit(child, kind)
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, f"special or hardlinked file: {relative}")
                suffix, name = path.suffix.lower(), path.name.lower()
                allowed = suffix in SAFE_SUFFIXES
                if kind == "build":
                    allowed |= suffix in BUILD_SUFFIXES or name.endswith(
                        (".deps.json", ".runtimeconfig.json", ".runtimeconfig.dev.json"))
                elif kind == "package":
                    allowed |= suffix in PACKAGE_SUFFIXES or name.endswith(
                        (".nupkg.sha512", ".jar.sha256", ".jar.sha512"))
                require(allowed, f"non-disposable {kind} file type: {relative}")
                entry["kind"] = "file"
                sha = hashlib.sha256()
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, "rb") as stream:
                    require(stamp(os.fstat(stream.fileno())) == entry["stat"], "file changed during inspection")
                    first = stream.read(8192)
                    require(not any(marker in first for marker in
                                    (b"-----BEGIN ", b"SQLite format 3", b"PGDMP", b"diff --git ", b"--- ")),
                            f"protected content signature: {relative}")
                    sha.update(first)
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        sha.update(block)
                    require(stamp(os.fstat(stream.fileno())) == entry["stat"], "file changed during inspection")
                entry["sha256"] = sha.hexdigest()
            require(stamp(path.lstat()) == entry["stat"], "resource changed during inspection")

        for value in sorted(record["paths"]):
            path = self.resource_path(record, value)
            # A .git sibling in an ancestor makes this a nested repository/worktree,
            # even when .git is outside the registered subtree.
            for parent in [path, *path.parents]:
                if parent == self.root:
                    break
                require(not (parent / ".git").exists() and not (parent / ".git").is_symlink(),
                        "nested repository/worktree refused")
            visit(path, record["kinds"][value])
        if remap:
            # Express stamps in the record's device numbering so sealed manifests and
            # fingerprints stay exact; mount boundaries were checked on live values.
            for entry in entries:
                require(entry["stat"][0] == remap[0], "mount boundary refused")
                entry["stat"][0] = remap[1]
        return entries

    def register(self, task, value, kind="scratch"):
        record = self.read_record(task)
        require(record["state"] == "active", "registration requires active task")
        self.resource_path(record, value)
        require(len(record["paths"]) < 64, "registered path limit reached")
        require(not any(value == p or value.startswith(p + "/") or p.startswith(value + "/")
                        for p in record["paths"]), "duplicate or overlapping registration")
        require(kind in KINDS, "unknown resource classification")
        record["paths"].append(value)
        record["kinds"][value] = kind
        self.snapshot(record)
        self.save(record)
        return record

    def state(self, task, state, pid=None):
        record = self.read_record(task)
        require(record["state"] != "completed", "completion is final; create a new task")
        if state == "active":
            require(pid is not None, "activation requires --owner-pid")
            owner = process_identity(pid)
            require(owner is not None, "new owner is not running")
            require(same_process(owner, record["owner"]) or not is_live(record["owner"]),
                    "previous owner is still running")
            record["owner"] = owner
        record["state"] = state
        self.save(record)
        return record

    def lease(self, task, worker, pid, seconds):
        self.record_path(worker)
        record = self.read_record(task)
        require(record["state"] == "active", "leases require active task")
        require(1 <= seconds <= 86400, "lease seconds must be 1..86400")
        require(worker in record["leases"] or len(record["leases"]) < 64, "worker lease limit reached")
        identity = process_identity(pid)
        require(identity is not None, "worker is not running")
        previous = record["leases"].get(worker)
        require(previous is None or same_process(previous["process"], identity) or not is_live(previous["process"]),
                "previous worker is still running")
        record["leases"][worker] = {"process": identity, "expires": int(time.time()) + seconds}
        self.save(record)
        return record

    def release(self, task, worker):
        record = self.read_record(task)
        require(record["state"] != "completed", "completed leases are sealed")
        lease = record["leases"].get(worker)
        if lease:
            require(not is_live(lease["process"]), "worker must exit before lease release")
            del record["leases"][worker]
            self.save(record)
        return record

    def check_leases(self, record):
        for worker, lease in record["leases"].items():
            require(not is_live(lease["process"]) and lease["expires"] <= time.time(),
                    f"live or unexpired worker lease: {worker}")

    def authorization(self, record):
        return digest({key: record[key] for key in
                       ("version", "task", "repository", "scope", "uid", "scope_identity", "exclusive_disposable",
                        "owner", "paths", "kinds", "leases")} |
                      {"completed_at": record["completed"]["at"], "owner_release": record["completed"]["owner_release"],
                       "manifest": record["completed"]["fingerprint"]})

    def owner_released(self, record):
        release = record["completed"].get("owner_release")
        if release is None:
            return False
        require(release == {"identity": record["owner"], "at": record["completed"]["at"],
                            "manifest": record["completed"]["fingerprint"], "no_further_resource_use": True},
                "invalid explicit owner release")
        return True

    def complete(self, task, authorize_cleanup=False, release_owner=False):
        record = self.read_record(task)
        if record["state"] == "completed":
            require(not release_owner or self.owner_released(record), "completion sealed without owner release")
            require(not authorize_cleanup or record["completed"].get("authorization") == self.authorization(record),
                    "completion sealed without cleanup authorization; use an exact reviewed sweep")
            return record
        self.check_leases(record)
        require(record["paths"], "no disposable paths registered")
        entries = self.snapshot(record)
        if release_owner:
            assert_no_open_handles([self.resource_path(record, p) for p in record["paths"]])
            require(self.snapshot(record) == entries, "resources changed during owner-release inspection")
        record["state"] = "completed"
        record["completed"] = {"at": int(time.time()), "manifest": entries,
                               "fingerprint": digest({"paths": sorted(record["paths"]), "entries": entries}),
                               "authorization": None, "owner_release": None}
        if release_owner:
            record["completed"]["owner_release"] = {
                "identity": record["owner"], "at": record["completed"]["at"],
                "manifest": record["completed"]["fingerprint"], "no_further_resource_use": True}
        if authorize_cleanup:
            record["completed"]["authorization"] = self.authorization(record)
        self.save(record)
        return record

    def plan_task(self, task, authorized=False):
        try:
            record = self.read_record(task)
        except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
            # One unreadable/foreign record is reported, never cleaned, and does not
            # hide the rest of the registry.
            return {"task": task, "paths": [], "record": None, "status": "blocked",
                    "reason": f"unreadable task record: {str(error)[:480]}"}
        plan = {"task": task, "paths": sorted(record["paths"]), "record": digest(record), "status": "blocked"}
        try:
            require(record["state"] == "completed" and record["completed"], "task not explicitly completed")
            self.validate_scope(record)
            receipt = record["receipt"]
            if receipt and receipt["status"] == "cleaned":
                require(not any(self.resource_path(record, p, False).exists()
                                or self.resource_path(record, p, False).is_symlink() for p in record["paths"]),
                        "cleaned path recreated; never delete without a new task")
                plan.update({key: receipt[key] for key in ("files", "directories", "logical_bytes") if key in receipt})
                plan["status"] = "already-cleaned"
                return plan
            require(not receipt, "previous cleanup interrupted/failed; manual review required")
            if authorized:
                require(record["completed"].get("authorization") == self.authorization(record),
                        "no matching explicit completion cleanup authorization")
            self.check_leases(record)
            require(self.owner_released(record) or not is_live(record["owner"]), "owner process is still running")
            entries = self.snapshot(record)
            plan.update(measurements(entries))
            sealed = record["completed"]
            require(entries == sealed["manifest"] and
                    digest({"paths": sorted(record["paths"]), "entries": entries}) == sealed["fingerprint"],
                    "completed manifest drift; manual review required")
            assert_no_open_handles([self.resource_path(record, p) for p in record["paths"]])
            plan.update(status="eligible", fingerprint=sealed["fingerprint"], entries=len(entries), manifest=entries)
        except (Refusal, OSError) as error:
            plan["reason"] = str(error)[:512]
        except (KeyError, TypeError, ValueError) as error:
            plan["reason"] = f"malformed task record: {type(error).__name__}: {str(error)[:400]}"
        return plan

    def summary(self, names):
        records = self.readable(names)
        cleaned = [r["receipt"] for r in records if r["receipt"] and r["receipt"]["status"] == "cleaned"]
        return {**{state: sum(r["state"] == state for r in records) for state in ("active", "paused", "completed")},
                "cleaned": len(cleaned),
                "cleaned_logical_bytes": sum(r["logical_bytes"] for r in cleaned if _int(r.get("logical_bytes"))),
                "unreadable": len(names) - len(records)}

    def task_age(self, record):
        if isinstance(record.get("created"), int):
            return int(time.time()) - record["created"]
        try:
            info = (self.root / record["scope"]).lstat()
            created = getattr(info, "st_birthtime", None)
        except OSError:
            created = None
        if created is None:
            created = self.record_path(record["task"]).lstat().st_mtime
        return int(time.time() - created)

    def unfinished(self, initialized, older_than=0):
        """Read-only: active/paused tasks at least OLDER_THAN seconds old."""
        found = []
        for record in self.readable(self.tasks(strict=False) if initialized else []):
            if record["state"] in {"active", "paused"}:
                age = self.task_age(record)
                if age >= older_than:
                    found.append({"task": record["task"], "state": record["state"], "age_seconds": age,
                                  "owner_pid": record["owner"]["pid"]})
        return {"repository": str(self.repo), "unfinished": sorted(found, key=lambda t: -t["age_seconds"])}

    def finish_owned(self, initialized, pid, apply=False):
        """Manual command: finish ACTIVE, lease-free tasks owned by the live process PID.

        Never invoked automatically by any host. It authenticates the supplied PID,
        not the caller: the caller must run inside that process's tree (PID is an
        ancestor of this process), and each record must carry a microsecond start
        identity matching the live process (records without one are refused).
        Paused, other-owner and leased tasks are skipped. Each candidate goes through
        finish(apply=True) with all fresh safety checks; keep/ is never removed.
        """
        owner = process_identity(pid)
        require(owner is not None, "owner process is not running; cannot prove session ownership")
        require(is_ancestor(pid), "owner PID is not an ancestor of this process; run from within that session")
        require("started_us" in owner, "high-resolution process start identity unavailable on this platform")
        results = []
        for record in self.readable(self.tasks(strict=False) if initialized else []):
            if record["owner"]["pid"] != pid:
                continue
            entry = {"task": record["task"], "state": record["state"]}
            if "started_us" not in record["owner"]:
                entry.update(status="skipped", reason="record lacks high-resolution owner start identity; use finish TASK")
            elif not same_process(record["owner"], owner, high_resolution=True):
                entry.update(status="skipped", reason="owned by an earlier process with a reused PID")
            elif record["state"] != "active":
                entry.update(status="skipped", reason=f"task is {record['state']}")
            elif record["leases"]:
                entry.update(status="skipped", reason="worker leases outstanding: " + ", ".join(sorted(record["leases"])))
            elif not apply:
                entry.update(status="would-finish")
            else:
                try:
                    result = self.finish(record["task"], apply=True)
                    entry.update(status="finished", receipts=[
                        {k: r.get(k) for k in ("status", "files", "directories", "logical_bytes")}
                        for r in result["receipts"]])
                except (Refusal, OSError) as error:
                    entry.update(status="retained", reason=str(error)[:512])
            results.append(entry)
        return {"repository": str(self.repo), "owner_pid": pid, "apply": apply, "tasks": results}

    def inventory(self, initialized, task=None, authorized=False):
        names = self.tasks(strict=False) if initialized else []
        if task:
            require(task in names, "unknown task")
            names = [task]
        plans = [self.plan_task(name, authorized) for name in names]
        # Only shallow names, never recursively discover/register old artifacts.
        unregistered = []
        for child in sorted(self.root.iterdir()):
            if child.name == ".lifecycle":
                continue
            if child.name == "tasks" and child.is_dir() and not child.is_symlink():
                for scope in sorted(child.iterdir()):
                    unregistered.append(scope.relative_to(self.root).as_posix())
            else:
                unregistered.append(child.name)
            require(len(unregistered) <= MAX_ENTRIES, "inventory limit reached; narrow manually")
        result = {"repository": str(self.repo), "mode": "dry-run", "tasks": plans,
                  "policy": "completion-authorized" if authorized else "exact-plan",
                  "report_only_containers": unregistered,
                  "note": "Only exact registered paths are candidates; all other content is report-only."}
        result["summary"] = self.summary(names) | {status: sum(p["status"] == status for p in plans)
                                                   for status in ("eligible", "blocked", "already-cleaned")}
        result["summary"]["logical_bytes"] = sum(p.get("logical_bytes", 0) for p in plans if p["status"] == "eligible")
        result["fingerprint"] = digest(result)
        return result

    def remove_manifest(self, record):
        """Only unlink exact sealed entries, using no-follow directory descriptors.

        No rmtree, shell rm, glob deletion, or symlink-following traversal.
        Directory stat times change as children are removed, so compare identity
        for directories and the full stat stamp for files at each unlink.
        """
        remap = self.validate_scope(record)
        for entry in reversed(record["completed"]["manifest"]):
            parts = PurePosixPath(entry["path"]).parts
            build_leaf = entry["kind"] == "file" and any(
                entry["path"].startswith(p + "/") and record["kinds"][p] == "build" for p in record["paths"])
            self.resource_path(record, entry["path"], exists=False, generated_leaf=build_leaf)
            # Anchor traversal at / rather than following any absolute-path ancestor.
            fd = os.open(self.root.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                for part in (*self.root.parts[1:], *parts[:-1]):
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = child
                info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                expected = list(entry["stat"])
                if remap and expected[0] == remap[1]:
                    expected[0] = remap[0]  # Same renumbered volume validated above.
                if entry["kind"] == "directory":
                    require(stamp(info)[:3] == expected[:3], "directory identity drift during cleanup")
                    os.rmdir(parts[-1], dir_fd=fd)
                else:
                    require(stamp(info) == expected, "file identity drift during cleanup")
                    os.unlink(parts[-1], dir_fd=fd)
            finally:
                os.close(fd)

    def sweep(self, initialized, task=None, apply=False, expect=None, authorized=False):
        require(not (authorized and expect), "--authorized and --expect are mutually exclusive")
        plan = self.inventory(initialized, task, authorized)
        if not apply:
            require(expect is None, "--expect requires --apply")
            return plan
        if not authorized:
            require(expect and expect == plan["fingerprint"], "dry-run fingerprint missing or changed")
            require(all(p["status"] != "blocked" for p in plan["tasks"]), "sweep contains blocked tasks; scope --task")
        receipts = []
        skipped = []
        for candidate in plan["tasks"]:
            if candidate["status"] != "eligible":
                skipped.append(candidate)
                continue
            self.validate_git()
            require(self.plan_task(candidate["task"], authorized) == candidate, "preconditions changed before cleanup")
            record = self.read_record(candidate["task"])
            receipt = {"status": "started", "at": int(time.time()), "plan": plan["fingerprint"],
                       "authorization": record["completed"].get("authorization") if authorized else None,
                       "manifest": record["completed"]["fingerprint"], "entries": candidate["entries"],
                       **{key: candidate[key] for key in ("files", "directories", "logical_bytes")}}
            record["receipt"] = receipt
            self.save(record)  # Write-ahead receipt: interrupted cleanup is never retried blindly.
            try:
                self.remove_manifest(record)
                receipt["status"] = "cleaned"
                record["completed"]["manifest"] = []  # Retain identity/digest, not a growing file inventory.
            except (OSError, Refusal) as error:
                receipt.update(status="failed", error=str(error)[:512])
                self.save(record)
                raise Refusal("partial cleanup; bounded receipt retained; manual review required") from error
            self.save(record)
            receipts.append({"task": record["task"], **receipt})
        return {"mode": "apply", "repository": str(self.repo), "policy": plan["policy"],
                "receipts": receipts, "skipped": skipped, "summary": self.summary([p["task"] for p in plan["tasks"]])}


def run_task(lifecycle, task, command):
    require(command, "run-task requires -- COMMAND [args...]")
    with lifecycle.locked(initialize=True):
        paths = lifecycle.start(task, os.getpid())
    print(json.dumps(paths, sort_keys=True), file=sys.stderr)
    environment = os.environ | {"AI_WORK_TASK": task, **{
        f"AI_WORK_{name.upper()}": paths[name] for name in ("keep", "cache", "output")}}
    child, code = None, 2
    gate_read, gate_write = os.pipe()
    try:
        # One child, gated until its lease is durable. Exec retains the leased PID.
        # No shell, argv/env recording, detached workers, or cache-default overrides.
        interrupted = []
        previous = signal.signal(signal.SIGINT, lambda *_: interrupted.append(True))
        try:
            child = subprocess.Popen([sys.executable, "-c",
                "import os,sys; fd=int(sys.argv[1]); go=os.read(fd,1); os.close(fd); "
                "os.execvp(sys.argv[2],sys.argv[2:]) if go == b'1' else sys.exit(2)",
                str(gate_read), *command], pass_fds=(gate_read,), env=environment, start_new_session=True)
        finally:
            signal.signal(signal.SIGINT, previous)
        if interrupted:
            raise KeyboardInterrupt
        with lifecycle.locked():
            lifecycle.lease(task, "foreground", child.pid, 86400)
        os.write(gate_write, b"1")
        code = child.wait()
        code = code if code >= 0 else 128 - code
    except KeyboardInterrupt:
        code = 130
    except (Refusal, OSError):
        # Do not print exceptions containing executable names/arguments (potential secrets).
        print(json.dumps({"task": task, "error": "foreground launch/lease failed; retained"}), file=sys.stderr)
    finally:
        # Ignore repeated Ctrl-C only while reaping this exact Popen child, never killpg.
        previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            os.close(gate_read)
            os.close(gate_write)
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            with lifecycle.locked():
                lifecycle.release(task, "foreground")
                lifecycle.state(task, "paused")
                output = lifecycle.finish(task, apply=True) if code == 0 else {"task": task, "state": "paused", "retained": True}
            print(json.dumps(output, sort_keys=True), file=sys.stderr)
        except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
            print(json.dumps({"task": task, "error": str(error)[:512], "retained": True}), file=sys.stderr)
        finally:
            signal.signal(signal.SIGINT, previous)
    return code


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    location = result.add_mutually_exclusive_group(required=True)
    location.add_argument("--repo", help="exact absolute Git repository root (no symlink components)")
    location.add_argument("--root", help="exact absolute repository/.ai-work directory (no symlink components)")
    commands = result.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start", help="declare NEW private cache/output disposable; retain keep (never adopt)",
                                description="Invocation explicitly declares exclusive disposable cache/output ownership; keep is retained.")
    start.add_argument("task")
    start.add_argument("--owner-pid", type=int, required=True)
    finish = commands.add_parser("finish", help="read-only preview; --apply completes/releases/authorizes and cleans only TASK")
    finish.add_argument("task")
    finish.add_argument("--apply", action="store_true")
    foreground = commands.add_parser("run-task", help="declare new task; run one foreground command; never detach workers")
    foreground.add_argument("task")
    foreground.add_argument("argv", nargs=argparse.REMAINDER)
    create = commands.add_parser("create", help="create a new exclusively owned disposable task scope")
    create.add_argument("task")
    create.add_argument("--owner-pid", type=int, required=True)
    create.add_argument("--declare-exclusive-disposable", action="store_true", required=True)
    register = commands.add_parser("register", help="register an existing cache/output directory")
    register.add_argument("task")
    register.add_argument("path", help="literal path relative to .ai-work")
    register.add_argument("--kind", choices=sorted(KINDS), default="scratch", help="explicit disposable resource classification")
    state = commands.add_parser("state", help="explicitly pause or activate a task")
    state.add_argument("task")
    state.add_argument("state", choices=["active", "paused"])
    state.add_argument("--owner-pid", type=int)
    complete = commands.add_parser("complete", help="explicitly seal the completed manifest")
    complete.add_argument("task")
    complete.add_argument("--release-owner", action="store_true",
                          help="explicitly relinquish ALL use of these resources while retaining the owner identity")
    complete.add_argument("--authorize-cleanup", action="store_true",
                          help="explicitly authorize later scheduled deletion of this exact completed manifest")
    lease = commands.add_parser("lease", help="create/renew a worker lease")
    lease.add_argument("task")
    lease.add_argument("worker")
    lease.add_argument("--pid", type=int, required=True)
    lease.add_argument("--seconds", type=int, default=3600)
    release = commands.add_parser("release", help="release a lease only after the worker exits")
    release.add_argument("task")
    release.add_argument("worker")
    owned = commands.add_parser("finish-owned", help="host session end: finish ACTIVE lease-free tasks owned by the exact live PID")
    owned.add_argument("--owner-pid", type=int, required=True)
    owned.add_argument("--apply", action="store_true")
    unfinished = commands.add_parser("unfinished", help="report only: active/paused tasks, optionally older than N seconds")
    unfinished.add_argument("--older-than", type=int, default=0)
    inventory = commands.add_parser("inventory", help="report only; same plan as sweep")
    inventory.add_argument("--task")
    sweep = commands.add_parser("sweep", help="dry-run by default; apply requires exact-plan or completion authorization")
    sweep.add_argument("--task")
    sweep.add_argument("--apply", action="store_true")
    sweep.add_argument("--expect", help="exact SHA-256 fingerprint from a fresh sweep dry-run")
    sweep.add_argument("--authorized", action="store_true",
                       help="only completion-authorized tasks; skip blocked tasks; dry-run unless --apply")
    return result


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    arguments = parser().parse_args(argv)
    try:
        if arguments.root is not None:
            root = Path(arguments.root)
            require(root.is_absolute() and root.name == ".ai-work" and ".." not in root.parts,
                    "--root must be absolute repository/.ai-work")
            repository = root.parent
        else:
            require(Path(arguments.repo).is_absolute(), "--repo must be absolute")
            repository = arguments.repo
        lifecycle = Lifecycle(repository)
        if arguments.command == "run-task":
            require(arguments.argv and argv[-len(arguments.argv) - 1] == "--",
                    "run-task requires -- COMMAND [args...]")
            return run_task(lifecycle, arguments.task, arguments.argv)
        with lifecycle.locked(initialize=arguments.command in {"create", "start"}) as initialized:
            if arguments.command in {"inventory", "sweep"}:
                output = lifecycle.sweep(initialized, arguments.task,
                                         getattr(arguments, "apply", False), getattr(arguments, "expect", None),
                                         getattr(arguments, "authorized", False))
            elif arguments.command == "finish-owned":
                output = lifecycle.finish_owned(initialized, arguments.owner_pid, arguments.apply)
            elif arguments.command == "unfinished":
                output = lifecycle.unfinished(initialized, arguments.older_than)
            else:
                require(initialized, "no registry; use create first")
                kwargs = vars(arguments).copy()
                for key in ("repo", "root", "command"):
                    del kwargs[key]
                if "owner_pid" in kwargs:
                    kwargs["pid"] = kwargs.pop("owner_pid")
                if "declare_exclusive_disposable" in kwargs:
                    kwargs["declaration"] = kwargs.pop("declare_exclusive_disposable")
                if "path" in kwargs:
                    kwargs["value"] = kwargs.pop("path")
                output = getattr(lifecycle, arguments.command)(**kwargs)
            print(json.dumps(output, sort_keys=True, indent=2))
        return 0
    except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error)[:1024]}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
