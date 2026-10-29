"""Shared, fail-closed bin-only planning for cleanup and sampled diagnostics."""
import json
import math
import os
from pathlib import Path
import re
import runpy
import shutil
import stat
import time

GIB = 1024 ** 3
RETAIN = runpy.run_path(str(Path(__file__).resolve().with_name('pi-retain')))
retained_reason = RETAIN['retained_reason']
delete_candidate = RETAIN['delete_candidate']


def threshold():
    try:
        config = json.loads((Path.home() / '.pi/agent/dev-doctor.json').read_text())
        value = config['disk']['bin_sweep_below_gib']
        if type(value) in (int, float) and math.isfinite(value) and value >= 0:
            return value
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return 50


def within(path, root):
    try:
        return os.path.commonpath([os.path.realpath(path), str(root)]) == str(root)
    except ValueError:
        return False


def guards(runner):
    """Unknown probe state blocks the entire sweep, not just a candidate."""
    output = runner(['lsof', '-nP', '-Fpcn'], timeout=10)
    if output is None:
        return None, 'lsof failed/unavailable'
    busy, opened, command = [], [], None
    for line in output.splitlines():
        if line.startswith('p'):
            command = None
        elif line.startswith('c'):
            command = line[1:]
        elif line.startswith('n') and line[1:].startswith('/'):
            if command is None:
                return None, 'lsof output unknown'
            opened.append(line[1:])
            if re.match(r'^(dotnet|testhost|VBCSCompiler|MSBuild|Microsoft\.)', command, re.I):
                busy.append(line[1:])
    phases = runner([str(Path.home() / '.pi/agent/bin/pi-phase'), 'status'], timeout=10)
    if phases is None:
        return None, 'pi-phase status failed/unavailable'
    parsed = runpy.run_path(str(Path(__file__).resolve().with_name('phase_status.py')))['active_phases'](phases)
    if parsed is None:
        return None, 'pi-phase status unknown'
    active = []
    for phase in parsed:
        if not phase['cwd'] or not os.path.isabs(phase['cwd']):
            return None, 'pi-phase cwd unknown'
        active.append(phase['cwd'])
    return (busy, active, opened), None


def candidates(root, runner, deadline, now):
    """A partial walk, recent file, tracked file or failed probe keeps the worktree."""
    bins, size, visited = [], 0, 0
    try:
        def walk_error(error):
            raise error
        for directory, dirs, files in os.walk(root, onerror=walk_error):
            visited += 1
            if visited > 100000 or time.monotonic() >= deadline:
                return [], 0, 'walk budget exhausted'
            dirs[:] = [d for d in dirs if d not in
                       ('.git', 'node_modules', 'obj', '.ai-work', '.worktrees',
                        '.venv', 'venv', '.tox', 'vendor', 'target', '__pycache__')
                       and not (Path(directory) / d).is_symlink()]
            for name in list(dirs):
                if name != 'bin':
                    continue
                path = Path(directory) / name
                dirs.remove(name)
                if not (any(Path(filename).suffix in ('.csproj', '.fsproj', '.vbproj')
                            and (Path(directory) / filename).is_file() for filename in files)
                        or (Path(directory) / 'obj/project.assets.json').is_file()):
                    continue
                bins.append(path)
                for subdir, subdirs, names in os.walk(path, onerror=walk_error):
                    visited += 1
                    if visited > 100000 or time.monotonic() >= deadline:
                        return [], 0, 'walk budget exhausted'
                    subdirs[:] = [d for d in subdirs if not (Path(subdir) / d).is_symlink()]
                    for filename in names:
                        visited += 1
                        if visited > 100000 or time.monotonic() >= deadline:
                            return [], 0, 'walk budget exhausted'
                        entry = (Path(subdir) / filename).lstat()
                        if entry.st_mtime > now - 3600:
                            return [], 0, 'bin write within 60 min'
                        if stat.S_ISREG(entry.st_mode):
                            size += entry.st_size
        if not bins:
            return [], 0, 'no bin directories'
        tracked = runner(['git', '-C', str(root), 'ls-files', '-z', '--'] +
                         [str(p.relative_to(root)) for p in bins], timeout=10)
        if tracked is None:
            return [], 0, 'git ls-files failed'
        if tracked:
            return [], 0, 'tracked files in bin'
    except OSError as error:
        return [], 0, f'bin scan failed: {error}'
    return bins, size, None


def bin_bytes(path, deadline):
    def failed(error):
        raise error
    total = 0
    for directory, dirs, files in os.walk(path, onerror=failed):
        if time.monotonic() >= deadline:
            raise OSError('walk budget exhausted')
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        for name in files:
            entry = (Path(directory) / name).lstat()
            if stat.S_ISREG(entry.st_mode):
                total += entry.st_size
    return total


def remove_bin(candidate):
    if candidate.is_symlink():
        raise OSError('bin identity changed to symlink')
    shutil.rmtree(candidate)


def sweep(roots, runner, apply=False, budget=60):
    limit = threshold()
    deadline = time.monotonic() + budget
    probe = runner
    def runner(cmd, timeout=10):
        remaining = deadline - time.monotonic()
        return probe(cmd, timeout=min(timeout, remaining)) if remaining > 0 else None
    state, error = guards(runner)
    rows = []
    for raw in roots:
        root = Path(raw).resolve()
        row = {'path': str(root), 'action': 'skipped', 'reason': '', 'bytes': 0, 'bytes_freed': 0}
        rows.append(row)
        reason = retained_reason(root, recursive=False) or error
        if not reason:
            try:
                if shutil.disk_usage(root).free >= limit * GIB:
                    reason = f'free ≥ {limit:g} GiB'
            except OSError:
                reason = 'free-space probe failed'
        if not reason:
            busy, phases, opened = state
            if any(within(p, root) for p in busy):
                reason = 'busy: build process has open files'
            elif any(within(p, root) for p in phases):
                reason = 'busy: pi-phase cwd inside worktree'
        if reason:
            row['reason'] = reason
            continue
        bins, size, reason = candidates(root, runner, deadline, time.time())
        if reason:
            row['reason'] = reason
            continue
        protected = [(path, retained_reason(path)) for path in bins]
        kept = [{'path': str(path), 'reason': reason} for path, reason in protected if reason]
        if kept:
            row['retained'] = kept
            bins = [path for path, reason in protected if not reason]
            try:
                size = sum(bin_bytes(path, deadline) for path in bins)
            except OSError as error:
                row['reason'] = f'bin scan failed: {error}'
                continue
            row['bytes'] = size
            if not bins:
                row['reason'] = kept[0]['reason']
                continue
        if any(within(p, path) for p in opened for path in bins):
            row['reason'] = 'busy: process has open files in bin'
            continue
        row.update(action='planned', reason='idle bins; obj kept', bytes=size)
        if apply:
            current, reason = guards(runner)  # recheck after the potentially long scan
            if not reason:
                busy, phases, opened = current
                if any(within(p, root) for p in busy + phases):
                    reason = 'busy: build files or phase cwd appeared before apply'
                elif any(within(p, path) for p in opened for path in bins):
                    reason = 'busy: process opened files in bin before apply'
            if reason:
                row.update(action='skipped', reason=reason, bytes=0)
                continue
            try:
                freed = size
                deleted = 0
                for path in bins:
                    reason = delete_candidate(path, remove_bin)
                    if reason:
                        row.setdefault('retained', []).append({'path': str(path), 'reason': reason})
                        freed -= bin_bytes(path, deadline)
                        continue
                    deleted += 1
                row.update(action='cleared' if deleted else 'skipped', bytes_freed=max(0, freed) if deleted else 0)
            except OSError as error:
                row.update(action='failed', reason=str(error))
    for row in rows:
        notes = [item['reason'] + ' ' + item['path'] for item in row.get('retained', [])]
        if notes:
            row['reason'] = '; '.join(filter(None, [row['reason'], *notes]))
    return rows


def sample_roots(root, deadline, maximum=40):
    roots = []
    visited = 0
    for directory, dirs, files in os.walk(root):
        visited += 1
        if time.monotonic() >= deadline or visited > 10000 or len(roots) >= maximum:
            break
        if '.git' in dirs or '.git' in files:
            roots.append(directory)
        dirs[:] = sorted((d for d in dirs if d not in
                          ('.git', 'bin', 'obj', 'node_modules', '.ai-work',
                           '.venv', 'venv', '.tox', 'vendor', 'target', '__pycache__')),
                         key=lambda d: (d != '.worktrees', d))
    return roots
