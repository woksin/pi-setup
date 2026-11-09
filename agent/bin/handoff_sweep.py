"""Fail-closed planning for ageing out context-budget handoff files (woksin/pi-setup#176).

Library only: it plans, it never deletes. `plan()` returns rows for every
`<repo>/.ai-work/handoffs/<sessionId>-<n>[.launch-prompt].(md|json)` file and decides
"remove" only when the unit (all files of one `n`) is older than the retention window,
is not among the newest N units of its session chain, and no live signal protects it.
Anything that cannot be read or classified is kept; an unreadable shared source
(status dir, lane dir, too many status files) skips the whole step.
"""
import json
import os
import re

NAME = re.compile(r'^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)'
                  r'(\.launch-prompt)?\.(md|json)$')
LIVE_WINDOW_S = 2 * 86400
PARSE_CAP = 8000
TEXT_LIMIT = 1024 * 1024
KEEP_DIR_ENTRIES = 400000
KEEP_DEPTH = 6
KEEP_SKIP_DIRS = {'node_modules', '.git', 'bin', 'obj', 'dist', 'packages', '.nuget', 'TestResults'}
KEEP_TEXT_LIMIT = 256 * 1024
KEEP_TEXT_SUFFIXES = ('.md', '.txt', '.json', '.log', '.yml', '.yaml')
DAY = 86400


class Unknown(Exception):
    """A liveness source could not be read; the caller keeps (or skips) everything."""


def pid_alive(pid):
    """True unless the pid is known not to exist; any other doubt counts as alive."""
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def real(path):
    return os.path.realpath(path)


def read_json(path):
    with open(path, encoding='utf-8') as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError('not an object')
    return value


def read_text(path):
    if os.path.getsize(path) > TEXT_LIMIT:
        raise Unknown(f'{path} too large to scan')
    with open(path, encoding='utf-8', errors='replace') as stream:
        return stream.read()


def marker_paths(marker):
    """Absolute handoff/launch-prompt paths named by an existing relaunch marker."""
    try:
        data = read_json(marker)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as error:
        raise Unknown(f'relaunch marker {marker}: {error}')
    return [real(data[key]) for key in ('handoff', 'launchPrompt') if isinstance(data.get(key), str)]


def status_paths(data):
    paths = []
    if isinstance(data.get('lastHandoffPath'), str):
        paths.append(real(data['lastHandoffPath']))
    if isinstance(data.get('relaunchMarker'), str):
        paths += marker_paths(data['relaunchMarker'])
    return paths


def chain_reason(data, mtime, now, alive):
    """Why a session chain counts as live, or None when its status proves it is not."""
    try:
        if alive(data.get('pid')):
            return f"live session (pid {data.get('pid')})"
    except Exception:
        return 'liveness check failed'
    if now - mtime < LIVE_WINDOW_S:
        return 'session status updated within 2 days'
    return None


def read_status(entry, sessions, recent):
    """(data, error): a recent status that is not ours and cannot be read is fatal (Unknown)."""
    try:
        return read_json(entry.path), None
    except (OSError, ValueError) as error:
        if recent and entry.name[:-5] not in sessions:
            raise Unknown(f'recent status {entry.name} unreadable: {error}')
        return None, f'status unreadable: {error}'


def status_mtime(entry):
    try:
        return entry.stat().st_mtime, None
    except OSError as error:
        return None, f'status unreadable: {error}'


def load_status(status_dir, sessions, now, alive):
    """One scan: chain -> reason (None = not live), plus protected paths from recent statuses."""
    try:
        entries = [e for e in os.scandir(status_dir) if e.name.endswith('.json')]
    except OSError as error:
        raise Unknown(f'status dir unreadable: {error}')
    chains, paths, parsed = {}, set(), 0
    for entry in entries:
        session = entry.name[:-5]
        mtime, error = status_mtime(entry)
        recent = error is None and now - mtime < LIVE_WINDOW_S
        if error or not (recent or session in sessions):
            if error and session in sessions:
                chains[session] = error
            continue
        parsed += 1
        if parsed > PARSE_CAP:
            raise Unknown(f'more than {PARSE_CAP} status files to read')
        data, error = read_status(entry, sessions, recent)
        if error:
            chains[session] = error
            continue
        paths.update(status_paths(data))
        if session in sessions:
            chains[session] = chain_reason(data, mtime, now, alive)
    return chains, paths


def scan_text(directory):
    """Concatenate small text files; a missing dir means nothing is running there."""
    parts = []
    try:
        entries = list(os.scandir(directory))
    except FileNotFoundError:
        return ''
    except OSError as error:
        raise Unknown(f'{directory} unreadable: {error}')
    for entry in entries:
        if entry.is_file():
            try:
                parts.append(read_text(entry.path))
            except OSError as error:
                raise Unknown(f'{entry.path} unreadable: {error}')
    return '\n'.join(parts)


def raise_error(error):
    raise error


def keep_entry_text(path, name):
    parts = [name]
    if os.path.islink(path):
        parts.append(os.readlink(path))
    if name.endswith(KEEP_TEXT_SUFFIXES) and os.path.isfile(path) and os.path.getsize(path) <= KEEP_TEXT_LIMIT:
        parts.append(read_text(path))
    return parts


def keep_dir_text(handoffs_dir):
    """Names, link targets and small text files under <repo>/.ai-work/keep/ (a reference there
    protects a handoff); large or binary files are matched by name only,
    and the walk stops at KEEP_DEPTH and skips build/vendor dirs."""
    keep = os.path.join(os.path.dirname(handoffs_dir), 'keep')
    if not os.path.lexists(keep):
        return ''
    parts, seen = [], 0
    for directory, dirs, files in os.walk(keep, onerror=raise_error):
        if directory[len(keep):].count(os.sep) >= KEEP_DEPTH:
            dirs[:] = []
        dirs[:] = [name for name in dirs if name not in KEEP_SKIP_DIRS]
        parts.extend(dirs)
        seen += len(files)
        if seen > KEEP_DIR_ENTRIES:
            raise Unknown('keep/ has too many entries')
        for name in files:
            parts += keep_entry_text(os.path.join(directory, name), name)
    return '\n'.join(parts)


def folder_units(directory):
    """(units, error): {(session, n): [(name, lstat)]} for context-budget files only."""
    units = {}
    try:
        entries = list(os.scandir(directory))
    except FileNotFoundError:
        return {}, None
    except OSError as error:
        return {}, f'unreadable: {error}'
    for entry in entries:
        match = NAME.match(entry.name)
        if not match:
            continue
        try:
            stat = entry.stat(follow_symlinks=False)
        except OSError:
            stat = None
        units.setdefault((match.group(1), int(match.group(2))), []).append((entry.name, stat))
    return units, None


def not_regular(members, directory):
    for name, stat in members:
        path = os.path.join(directory, name)
        if stat is None or os.path.islink(path) or not os.path.isfile(path):
            return True
    return False


def protected_reason(members, directory, protect):
    paths = {real(os.path.join(directory, name)) for name, _ in members}
    if paths & protect['paths']:
        return 'referenced by a live session or relaunch marker'
    if any(name in protect['text'] for name, _ in members):
        return 'referenced by lane status or keep/'
    return None


def unit_reason(members, directory, protect, newest, cutoff):
    """Why this unit stays, or None when it may go. protect['retained'](path) is the KEEP hook."""
    if newest:
        return 'newest handoffs of the session'
    if not_regular(members, directory):
        return 'not a regular file'
    if max(stat.st_mtime for _, stat in members) >= cutoff:
        return 'within retention window'
    reasons = (protect['retained'](os.path.join(directory, name)) for name, _ in members)
    return protected_reason(members, directory, protect) or next((r for r in reasons if r), None)


def add_row(folder, row):
    folder['rows'].append(row)
    if row['action'] == 'keep':
        folder['kept'] += 1
        folder['kept_reasons'][row['reason']] = folder['kept_reasons'].get(row['reason'], 0) + 1
    else:
        folder['files'] += 1
        folder['bytes'] += row['size']


def newest_units(units, keep_newest):
    by_session = {}
    for session, n in units:
        by_session.setdefault(session, []).append(n)
    return {(s, n) for s, ns in by_session.items() for n in sorted(ns, reverse=True)[:keep_newest]}


def unit_rows(members, directory, reason, age_days):
    for name, stat in members:
        yield {'path': os.path.join(directory, name), 'size': stat.st_size if stat else 0,
               'mtime': stat.st_mtime if stat else 0, 'action': 'keep' if reason else 'remove',
               'reason': reason or f'older than {age_days:g} days'}


def plan_folder(directory, now, age_days, keep_newest, protect, retained):
    folder = {'path': directory, 'files': 0, 'bytes': 0, 'kept': 0, 'kept_reasons': {},
              'rows': [], 'skip': None}
    units, error = folder_units(directory)
    if error:
        folder['skip'] = error
        return folder
    try:
        text = protect['lanes'] + '\n' + keep_dir_text(directory)
    except (OSError, Unknown) as error:
        folder['skip'] = f'keep/ unreadable, folder kept: {error}'
        return folder
    local = {'paths': protect['paths'], 'text': text, 'retained': retained}
    top = newest_units(units, keep_newest)
    for key in sorted(units):
        members = sorted(units[key], key=lambda member: member[0])
        reason = protect['chains'].get(key[0]) or unit_reason(
            members, directory, local, key in top, now - age_days * DAY)
        for row in unit_rows(members, directory, reason, age_days):
            add_row(folder, row)
    return folder


def handoff_dirs(checkouts):
    """Existing <checkout>/.ai-work/handoffs dirs; a symlinked .ai-work or handoffs is skipped."""
    found = []
    for root in checkouts:
        ai_work = os.path.join(root, '.ai-work')
        directory = os.path.join(ai_work, 'handoffs')
        if os.path.islink(ai_work) or os.path.islink(directory) or not os.path.isdir(directory):
            continue
        found.append(directory)
    return found


def plan(checkouts, now, age_days, keep_newest, status_dir, lane_dir, retained,
         alive=pid_alive, items=lambda values: values):
    """Plan handoff removal. `retained(path)` returns a keep reason or None.

    Returns {"folders": [...], "skip": reason|None}; a skip means liveness is unknown and
    nothing may be removed."""
    directories = handoff_dirs(checkouts)
    scanned = {directory: folder_units(directory)[0] for directory in directories}
    sessions = {session for units in scanned.values() for session, _ in units}
    if not sessions:
        return {'folders': [], 'skip': None}
    try:
        chains, paths = load_status(status_dir, sessions, now, alive)
        lanes = scan_text(lane_dir) if lane_dir else ''
    except (Unknown, OSError) as error:
        return {'folders': [], 'skip': f'liveness unknown: {error}'}
    protect = {'chains': chains, 'paths': paths, 'lanes': lanes}
    return {'folders': [plan_folder(directory, now, age_days, keep_newest, protect, retained)
                        for directory in items(directories)], 'skip': None}
