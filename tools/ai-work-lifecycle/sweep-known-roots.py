#!/usr/bin/env python3
"""Registered-task sweep plus a bounded local usage report; no deletion by age.

Roots come from the allowlist plus auto-enrolment of EXISTING task registries
(`<git-root>/.ai-work/.lifecycle`) under the discovery base. Enrolment never
creates a registry and never adopts unregistered content: only tasks explicitly
completed and authorized in a registry are ever cleaned.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time

HOME = Path.home()
DISCOVERY_BASE = Path('{{REPOS_ROOT}}')
DISCOVERY_DEPTH = 6        # base/org/repo/.worktrees/name/.ai-work fits comfortably
DISCOVERY_MAX_DIRS = 200000
DISCOVERY_SECONDS = 60
PRUNE = {'node_modules', 'bin', 'obj', '.git', 'dist', 'target', 'packages', '.venv', '.nuget',
         '.gradle', '.next', 'build', 'Library', 'tasks', 'keep', 'cache', 'output'}
LOW_FREE_BYTES = 40 * 1024 ** 3
NOTIFY_EVERY = 6 * 3600
MAX_LOG = 1024 * 1024


def discover(base):
    """Bounded walk for existing registries; prunes build/package trees and task scopes."""
    found, visited, deadline, truncated = set(), 0, time.monotonic() + DISCOVERY_SECONDS, False
    if not base.is_dir() or base.is_symlink() or base.resolve() != base:
        return found, 'discovery base missing or not a real directory'
    stack = [(base, 0)]
    uid = os.getuid()
    while stack:
        directory, depth = stack.pop()
        visited += 1
        if visited > DISCOVERY_MAX_DIRS or time.monotonic() > deadline:
            truncated = True
            break
        try:
            entries = list(os.scandir(directory))
        except OSError:
            continue
        for entry in entries:
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            path = Path(entry.path)
            if entry.name == '.ai-work':
                registry = path / '.lifecycle'
                try:
                    info = registry.lstat()
                    git = directory / '.git'
                    if (stat.S_ISDIR(info.st_mode) and info.st_uid == uid
                            and path.lstat().st_uid == uid and (git.exists() or git.is_symlink())):
                        found.add(str(path))
                except OSError:
                    pass
                # Worktrees kept under .ai-work/worktrees may carry their own registry.
                if depth + 2 <= DISCOVERY_DEPTH and (path / 'worktrees').is_dir() \
                        and not (path / 'worktrees').is_symlink():
                    stack.append((path / 'worktrees', depth + 1))
                continue
            if entry.name in PRUNE or (entry.name.startswith('.') and entry.name not in {'.worktrees', '.claude'}):
                continue
            if depth + 1 < DISCOVERY_DEPTH:
                stack.append((path, depth + 1))
    return found, ('discovery truncated by bounds' if truncated else None)


# Blocked-task reasons from the CLI, by prefix. Unknown reasons are safety (fail closed).
EXPECTED = ('task not explicitly completed', 'no matching explicit completion cleanup authorization',
            'owner process is still running', 'live or unexpired worker lease', 'open process handle',
            'lifecycle is locked')
STALE = ('tasks/ container missing', 'task scope missing')
PARTIAL = ('previous cleanup interrupted/failed', 'partial cleanup')
SAFETY_REALERT = 24 * 3600


def classify(reason):
    reason = reason or ''
    for name, prefixes in (('expected', EXPECTED), ('stale', STALE), ('partial', PARTIAL)):
        if reason.startswith(prefixes):
            return name
    return 'safety'


def new_safety_keys(state, keys, apply):
    """Safety blocks alert once per task/reason per day while unchanged."""
    path = state / '.safety-alerted.json'
    try:
        seen = json.loads(path.read_text()) if path.exists() and not path.is_symlink() else {}
        seen = seen if isinstance(seen, dict) else {}
    except (OSError, ValueError):
        seen = {}
    now = int(time.time())
    fresh = sorted(k for k in keys if now - seen.get(k, 0) >= SAFETY_REALERT)
    if apply:
        save(path, {k: (now if k in fresh else seen[k]) for k in keys})
    return fresh


def enroll(config, document, discovered):
    roots = document['roots']
    added = sorted(set(discovered) - set(roots))
    if added:
        save(config, {**document, 'roots': sorted(set(roots) | set(added))}, mode=0o644)
    return added


def log_line(state, text):
    path = state / 'sweep.log'
    if path.is_symlink():
        return
    if path.exists() and path.stat().st_size > MAX_LOG:
        os.replace(path, state / 'sweep.log.1')
    with open(path, 'a') as stream:
        stream.write(time.strftime('%Y-%m-%dT%H:%M:%S%z ') + text + '\n')


def notify(state, message):
    """Best effort, non-fatal; identical alerts at most once per NOTIFY_EVERY seconds."""
    marker = state / '.last-alert.json'
    try:
        last = json.loads(marker.read_text()) if marker.exists() and not marker.is_symlink() else {}
    except (OSError, ValueError):
        last = {}
    if last.get('message') == message and time.time() - last.get('at', 0) < NOTIFY_EVERY:
        return 'throttled'
    script = 'display notification {} with title "ai-work-lifecycle sweep"'.format(json.dumps(message[:240]))
    try:
        subprocess.run(['/usr/bin/osascript', '-e', script], capture_output=True, timeout=15, check=True)
        save(marker, {'message': message, 'at': int(time.time())})
        return 'sent'
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        return f'failed: {str(error)[:200]}'


def save(path, value, mode=None):
    if path.is_symlink():
        raise RuntimeError('Refusing symlink receipt')
    fd, temporary = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    if mode is not None:
        os.fchmod(fd, mode)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    os.replace(temporary, path)


def sweep(config, state, apply=False, discovery_base=DISCOVERY_BASE):
    document = json.loads(config.read_text())
    roots = document['roots']
    if not isinstance(roots, list) or not all(isinstance(p, str) and Path(p).is_absolute()
                                             and Path(p).name == '.ai-work' for p in roots):
        raise ValueError('Invalid explicit root allowlist')
    if state.resolve() != state or state.is_symlink():
        raise ValueError('Unsafe receipt path')
    state.mkdir(parents=True, exist_ok=True)
    discovered, discovery_note = discover(discovery_base) if discovery_base else (set(), None)
    new_roots = sorted(discovered - set(roots))
    enrolled = []
    if apply and new_roots:
        try:
            enrolled = enroll(config, document, discovered)
        except (OSError, RuntimeError) as error:
            discovery_note = f'enrolment failed: {str(error)[:300]}'
    results, measured, totals, missing = [], [], {}, []
    registered = 0
    # Newly discovered registries are swept this run too (dry-run previews them).
    for raw in sorted(set(roots) | set(new_roots)):
        root = Path(raw)
        if not root.exists():
            missing.append(raw)
            continue
        if root.is_symlink() or root.resolve() != root:
            results.append({'root': raw, 'error': 'Symlink root refused'})
            continue
        # Measurement is read-only. Never adopt legacy resources for cleanup.
        measured.append(raw)
        if not (root / '.lifecycle').exists():
            continue
        registered += 1
        argv = [str(HOME / '.local/bin/ai-work-lifecycle'), '--root', raw, 'sweep', '--authorized']
        try:
            response = subprocess.run(argv + (['--apply'] if apply else []), capture_output=True,
                                      text=True, timeout=300)
            if response.returncode:
                raise RuntimeError(response.stderr[-2000:])
            payload = json.loads(response.stdout)
            tasks = payload.get('skipped', payload.get('tasks', []))
            blocked = [{'task': t['task'], 'reason': t.get('reason'), 'class': classify(t.get('reason'))}
                       for t in tasks if t.get('status') == 'blocked']
            receipts = payload.get('receipts', [])
            classes = {}
            for item in blocked:
                classes[item['class']] = classes.get(item['class'], 0) + 1
            results.append({'root': raw, 'cleaned_this_run': len(receipts),
                            'cleaned_bytes_this_run': sum(r.get('logical_bytes', 0) for r in receipts),
                            'eligible': sum(t.get('status') == 'eligible' for t in tasks),
                            'blocked_count': len(blocked), 'blocked_classes': classes,
                            'attention': [b for b in blocked if b['class'] in ('safety', 'partial')][:200],
                            'blocked': blocked[:50], 'blocked_omitted': max(0, len(blocked) - 50)})
            for key, value in payload.get('summary', {}).items():
                if isinstance(value, int) and not isinstance(value, bool):
                    totals[key] = totals.get(key, 0) + value
        except (OSError, ValueError, subprocess.TimeoutExpired, RuntimeError) as error:
            results.append({'root': raw, 'error': str(error)[:2000]})
    measurement_error, allocated = None, 0
    if measured:
        try:
            usage = subprocess.run(['du', '-sk', *measured], capture_output=True, text=True,
                                   timeout=120, check=True)
            if usage.stderr:
                raise RuntimeError(usage.stderr[:1000])
            allocated = sum(int(line.split(maxsplit=1)[0]) * 1024 for line in usage.stdout.splitlines())
        except (OSError, ValueError, subprocess.SubprocessError, RuntimeError) as error:
            allocated, measurement_error = None, str(error)[:1000]
    fs = os.statvfs(HOME)
    blocked_reasons = {}
    for result in results:
        for item in result.get('blocked', []):
            key = (item.get('reason') or '?').split(':')[0][:80]
            blocked_reasons[key] = blocked_reasons.get(key, 0) + 1
    class_totals = {}
    for result in results:
        for name, count in result.get('blocked_classes', {}).items():
            class_totals[name] = class_totals.get(name, 0) + count
    sample = {'at': int(time.time()), 'configured_roots': len(set(roots) | set(enrolled)),
              'blocked_classes': class_totals,
              'registered_roots': registered, 'summary': totals,
              'ai_work_allocated_bytes': allocated, 'home_free_bytes': fs.f_bavail * fs.f_frsize,
              'measurement_error': measurement_error,
              'cleanup_errors': sum('error' in r for r in results),
              'cleaned_bytes_this_run': sum(r.get('cleaned_bytes_this_run', 0) for r in results),
              'blocked_total': sum(r.get('blocked_count', 0) for r in results),
              'missing_roots': len(missing), 'discovered_new_roots': len(new_roots),
              'enrolled_roots': len(enrolled)}
    if not registered:
        sample['adoption_warning'] = 'No task registries found: the cleaner cannot reclaim unregistered work.'
    report = {'apply': apply, **sample, 'roots': results, 'blocked_reasons': blocked_reasons,
              'missing': missing, 'new_roots': new_roots, 'discovery_note': discovery_note,
              'note': 'Logical bytes in task receipts are not guaranteed APFS savings. Disk changes include other sessions.'}
    save(state / 'last-sweep.json', report)
    history_path = state / 'usage-history.json'
    if history_path.is_symlink():
        raise ValueError('Symlink history refused')
    if history_path.exists() and history_path.stat().st_size > 1024 * 1024:
        raise ValueError('Oversized history; retained for review')
    history = json.loads(history_path.read_text()) if history_path.exists() else []
    if not isinstance(history, list):
        raise ValueError('Invalid history; retained for review')
    # At most one sample/hour, and 168 samples total. No ever-growing telemetry log.
    history = [s for s in history if s['at'] // 3600 != sample['at'] // 3600]
    save(history_path, (history + [sample])[-168:])
    alerts = []
    failed = [r['root'] for r in results if 'error' in r]
    if failed:
        alerts.append(f"{len(failed)} root(s) failed: {', '.join(Path(p).parent.name for p in failed[:5])}")
    partial = [(r['root'], a['task']) for r in results for a in r.get('attention', []) if a['class'] == 'partial']
    if partial:
        alerts.append(f"{len(partial)} task(s) with failed/partial cleanup need manual review")
    safety = {f"{r['root']}|{a['task']}|{(a['reason'] or '')[:60]}"
              for r in results for a in r.get('attention', []) if a['class'] == 'safety'}
    fresh = new_safety_keys(state, safety, apply)
    if fresh:
        alerts.append(f"{len(fresh)} new safety block(s) (identity/record checks), e.g. "
                      + ', '.join(k.split('|')[1] for k in fresh[:3]))
    if sample['home_free_bytes'] < LOW_FREE_BYTES:
        alerts.append(f"home free space {sample['home_free_bytes'] / 1024 ** 3:.1f} GiB < 40 GiB")
    if discovery_note:
        alerts.append(discovery_note)
    log_line(state, f"{'apply' if apply else 'dry-run'} roots={registered} cleaned_bytes={sample['cleaned_bytes_this_run']} "
                    f"blocked={sample['blocked_total']} {json.dumps(class_totals, sort_keys=True)} "
                    f"errors={sample['cleanup_errors']} enrolled={len(enrolled)} "
                    f"free={sample['home_free_bytes'] / 1024 ** 3:.1f}GiB")
    if alerts:
        message = '; '.join(alerts)
        status = notify(state, message) if apply else 'not sent (dry-run)'
        log_line(state, f'ALERT {message} (see {state / "last-sweep.json"}; notification {status})')
    print(json.dumps({**sample, 'alerts': alerts, 'receipt': str(state / 'last-sweep.json')}))
    # All roots are always processed. Exit 2 (degraded) only for operational root
    # failures or failed/partial cleanups; expected, stale and (alerted) safety
    # blocks keep exit 0 so a stable set does not mark every hourly run failed.
    return 2 if failed or partial else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, epilog="""Examples:
  sweep-known-roots.py                 # dry run over the known roots
  sweep-known-roots.py --apply         # state-changing: cleans completed, authorized tasks; enrols discovered registries
Exit codes:
  0 sweep finished (blocks are reported, not failures)
  1 another sweep holds the lock (error)
  2 degraded: a root failed or a cleanup failed/was partial
See also: docs/reference.md, tools/ai-work-lifecycle/README.md
""")
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--config', type=Path, default=HOME / '.config/ai-work-lifecycle/roots.json')
    parser.add_argument('--state-dir', type=Path, default=HOME / '.ai-work/ai-work-lifecycle')
    parser.add_argument('--discover', type=Path, default=DISCOVERY_BASE,
                        help='base directory searched for existing registries (enrolled only with --apply)')
    parser.add_argument('--no-discover', action='store_true')
    args = parser.parse_args()
    if args.state_dir.resolve() != args.state_dir:
        raise SystemExit('Unsafe state directory')
    args.state_dir.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.state_dir / '.sweep.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raise SystemExit(sweep(args.config, args.state_dir, args.apply,
                               None if args.no_discover else args.discover))
    finally:
        os.close(fd)
