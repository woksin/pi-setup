"""Bounded, best-effort attribution of recently modified allocated file sizes."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time


class Budget:
    """One deadline and entry cap shared by discovery, ranking and traversal."""

    def __init__(self, deadline, cap=100000):
        self.deadline = deadline
        self.cap = cap
        self.entries = 0
        self.partial = False
        self.shallow = set()

    def available(self):
        if time.monotonic() >= self.deadline or self.entries >= self.cap:
            self.partial = True
            return False
        return True

    def scan(self, path):
        if not self.available() or Path(path).is_symlink():
            return
        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    if not self.available():
                        break
                    self.entries += 1
                    if not entry.is_symlink():
                        yield entry
        except OSError:
            self.partial = True


def parse_cwds(output):
    result = {}
    command = ''
    for line in output.splitlines():
        if line.startswith('p'):
            command = ''
        elif line.startswith('c'):
            command = line[1:]
        elif line.startswith('n/') and command:
            result.setdefault(line[1:], set()).add(command)
    return result


def active_cwds(timeout=5):
    """Bound lsof by elapsed time and one MiB, including its output read."""
    try:
        with subprocess.Popen(['lsof', '-nP', '-w', '-a', '-u', str(os.getuid()), '-d', 'cwd', '-Fpcn'],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
            output = bytearray()
            deadline = time.monotonic() + timeout
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout, selectors.EVENT_READ)
                    while len(output) < 1048576:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not selector.select(remaining):
                            return {}
                        chunk = os.read(child.stdout.fileno(), min(65536, 1048576 - len(output)))
                        if not chunk:
                            return parse_cwds(output.decode(errors='replace'))
                        output.extend(chunk)
                return {}
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait()
    except (OSError, subprocess.SubprocessError):
        return {}


def ledger_cwds(since):
    path = Path.home() / '.pi/agent/pi-phase/state/ledger' / f'{datetime.now(timezone.utc):%Y-%m-%d}.jsonl'
    try:
        with path.open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            start = max(0, stream.tell() - 1048576)
            stream.seek(start)
            lines = stream.read(1048576).splitlines()[int(start > 0):]
    except OSError:
        return []
    cwds = []
    for line in lines:
        try:
            row = json.loads(line)
            ended = row.get('endedAt')
            if (not ended or datetime.fromisoformat(ended.replace('Z', '+00:00')).timestamp() >= since):
                if isinstance(row.get('cwd'), str):
                    cwds.append(row['cwd'])
        except (ValueError, TypeError, AttributeError):
            continue
    return cwds


def add_worktree_root(cwd, found):
    path = Path(cwd)
    for root in (path, *path.parents):
        if (root / '.git').exists():
            found.setdefault(str(root), None)
            break


def priority_units(active, since, budget=None):
    found = {}
    for cwd in [*active, *ledger_cwds(since)]:
        if budget and not budget.available():
            break
        add_worktree_root(cwd, found)
    return list(found)[:3000]


def discover_directory(entry, depth, budget, found):
    if entry.name == '.git':
        return
    worktrees = depth == 0 and (entry.name == '.worktrees' or entry.name.endswith('-worktrees'))
    if depth > 0 or worktrees:
        discover(entry.path, depth - 1, budget, found)
    else:
        found.append(entry.path)


def discover(path, depth, budget, found):
    has_files = False
    for entry in budget.scan(path):
        if len(found) >= 3000:
            budget.partial = True
            break
        if entry.is_dir(follow_symlinks=False):
            discover_directory(entry, depth, budget, found)
        else:
            has_files = has_files or entry.is_file(follow_symlinks=False)
    if has_files and len(found) < 3000:
        found.append(str(path))
        budget.shallow.add(str(path))


def units(root, repos_root, budget=None):
    budget = budget or Budget(time.monotonic() + 20)
    found = []
    depth = 1 if str(root) == str(repos_root) else -1
    try:
        discover(str(root), depth, budget, found)
    except OSError:
        budget.partial = True
    return found


def category(path):
    if path.suffix == '.dmp':
        return 'dumps'
    for name in ('TestResults', 'bin', 'obj', '.ai-work', 'node_modules'):
        if name in path.parts:
            return 'bin/obj' if name in ('bin', 'obj') else name
    return 'other'


def recent_file(entry, since):
    if not entry.is_file(follow_symlinks=False):
        return 0
    stat = entry.stat(follow_symlinks=False)
    return stat.st_blocks * 512 if stat.st_mtime >= since else 0


def walk_entry(entry, unit, since, budget, stack):
    try:
        if not entry.is_dir(follow_symlinks=False):
            return recent_file(entry, since)
        if entry.name != '.git' and str(unit) not in budget.shallow:
            stack.append(entry.path)
    except OSError:
        budget.partial = True
    return 0


def walk_unit(unit, since, deadline, budget=None):
    budget = budget or Budget(deadline)
    total, categories = 0, {}
    stack = [str(unit)]
    while stack and budget.available():
        for entry in budget.scan(stack.pop()):
            size = walk_entry(entry, unit, since, budget, stack)
            if size:
                name = category(Path(entry.path).relative_to(unit))
                total += size
                categories[name] = categories.get(name, 0) + size
    return total, categories, not budget.partial


def unit_rank(unit, active, budget):
    procs = sorted({command for cwd, commands in active.items()
                    if cwd == unit or cwd.startswith(unit + os.sep) for command in commands})
    freshest = 0
    try:
        freshest = os.stat(unit, follow_symlinks=False).st_mtime
        if unit not in budget.shallow:
            for entry in budget.scan(unit):
                if entry.is_dir(follow_symlinks=False):
                    freshest = max(freshest, entry.stat(follow_symlinks=False).st_mtime)
    except OSError:
        budget.partial = True
    return (not bool(procs), -freshest, unit), procs


def discover_roots(roots, repos_root, budget):
    found = []
    for root in roots:
        if not budget.available():
            break
        found.extend(units(root, repos_root, budget))
        if len(found) >= 3000:
            budget.partial = True
            break
    return list(dict.fromkeys(found[:3000]))


def rank_units(found, active, budget):
    ranked = []
    for unit in found:
        if not budget.available():
            break
        rank, procs = unit_rank(unit, active, budget)
        ranked.append((rank, unit, procs))
    return sorted(ranked)


def walk_ranked(ranked, since, budget):
    writers, walked = [], 0
    for index, (_, unit, procs) in enumerate(ranked):
        if not budget.available():
            break
        left = len(ranked) - index
        now = time.monotonic()
        share = Budget(now + (budget.deadline - now) / left, max(1, (budget.cap - budget.entries) // left))
        share.shallow = budget.shallow
        size, categories, complete = walk_unit(unit, since, share.deadline, share)
        budget.entries += share.entries
        budget.partial |= share.partial
        walked += int(complete)
        writers.append({'path': unit, 'bytes': size, 'categories': categories, 'procs': procs})
    return sorted(writers, key=lambda writer: (-writer['bytes'], writer['path'])), walked


def top_writers(roots, repos_root, since, deadline, active=None):
    budget = Budget(deadline)
    if active is None:
        active = active_cwds(max(0, min(5, deadline - time.monotonic()))) if budget.available() else {}
    first = priority_units(active, time.time() - 300, budget) if budget.available() else []
    ranked = [((0, index, unit), unit, sorted({command for cwd, commands in active.items()
               if cwd == unit or cwd.startswith(unit + os.sep) for command in commands}))
              for index, unit in enumerate(first)]
    writers, walked = walk_ranked(ranked, since, budget)
    found = [unit for unit in discover_roots(roots, repos_root, budget) if unit not in first]
    if len(first) + len(found) > 3000:
        budget.partial = True
        found = found[:3000 - len(first)]
    more, completed = walk_ranked(rank_units(found, active, budget), since, budget)
    writers = sorted(writers + more, key=lambda writer: (-writer['bytes'], writer['path']))
    return writers, {'walked': walked + completed, 'total': len(first) + len(found), 'partial': budget.partial}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    json.dump(top_writers(**request), sys.stdout)
