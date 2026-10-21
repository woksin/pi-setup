"""Package-volume diagnostics and explicitly requested, bounded cache changes."""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile

GIB = 1024 ** 3
RSYNC_TIMEOUT = 4 * 60 * 60
MOVE_MARKER = '.pi-setup-nuget-move.json'
PROPERTIES = (
    'CreateHardLinksForCopyLocalIfPossible',
    'CreateHardLinksForCopyFilesToOutputDirectoryIfPossible',
    'CreateHardLinksForCopyAdditionalFilesIfPossible',
    'CreateHardLinksForPublishFilesIfPossible',
)
CAVEAT = ('Rare tools that rewrite a bin file in place would modify the cached package. '
          'Reversible by deleting the added Directory.Build.rsp (or restoring its backup).')


def cache_path():
    return Path(os.environ.get('NUGET_PACKAGES') or '~/.nuget/packages').expanduser().absolute()


def move_commands(source, target):
    old = source.parent / (source.name + '.old')
    q = lambda p: shlex.quote(str(p))
    return [f'rsync -a {q(str(source) + "/")} {q(str(target) + "/")}',
            '# Wait until builds are idle, then repeat:',
            f'rsync -a {q(str(source) + "/")} {q(str(target) + "/")}',
            f'mv {q(source)} {q(old)}', f'ln -s {q(target)} {q(source)}',
            f'rsync -a --ignore-existing {q(str(old) + "/")} {q(str(target) + "/")}',
            '# Only after a verified build:', f'rm -rf -- {q(old)}']


def rsp_properties(root):
    enabled = set()
    for directory in (root, *root.parents):
        path = directory / 'Directory.Build.rsp'
        try:
            if path.stat().st_size > 1024 * 1024:
                continue
            text = path.read_text()
        except (OSError, UnicodeError):
            continue
        for prop in PROPERTIES:
            if re.search(r'(?im)^\s*-p:' + prop + r'=true\s*$', text):
                enabled.add(prop)
    return enabled


def check(runner, root, stat=os.stat):
    """Return plain finding fields; stat is injectable for cross-volume tests."""
    if root is None:
        return [('info', 'Skipped: repositories root unavailable', 'State is unknown.', 'Set --repos-root.')]
    root = Path(root).resolve()
    source = cache_path()
    target = root / '.nuget-packages'
    missing = [p for p in PROPERTIES if p not in rsp_properties(root)]
    suggestion = ('Outside any git checkout, create/append ' + str(root / 'Directory.Build.rsp') + ':\n'
                  + '\n'.join('-p:' + p + '=true' for p in missing) if missing else
                  'Hard-link properties already set in repos-root/ancestor Directory.Build.rsp.')
    suggestion += '\n' + CAVEAT + '\n' + '\n'.join(move_commands(source, target))
    rows = []

    def compare(name, path, suggest):
        try:
            resolved = Path(path).expanduser().resolve()
            different = stat(resolved).st_dev != stat(root).st_dev
            rows.append(('warn' if different else 'info', f'{name}: {resolved}',
                         ('copy-local cannot hard-link; every worktree bin holds full package copies'
                          if name == 'NuGet' else 'Different device: copies instead of hard links or clones.')
                         if different else 'Cache and repositories share a filesystem; hard links are possible.', suggest))
        except (OSError, ValueError):
            rows.append(('info', f'Skipped: {name} cache/device unavailable', 'State is unknown.', suggest))

    compare('NuGet', source, suggestion)
    pnpm = runner(['pnpm', 'store', 'path'], timeout=3)
    if pnpm and len(pnpm.strip().splitlines()) == 1 and Path(pnpm.strip()).is_absolute():
        compare('pnpm', pnpm.strip(), 'Suggest-only: configure the pnpm store on the source volume; verify a fresh install.')
    version = runner(['yarn', '--version'], timeout=3)
    if version and re.fullmatch(r'(?:[2-9]|\d{2,})\.\d+\.\d+(?:[-+][\w.-]+)?', version.strip()):
        yarn = runner(['yarn', 'config', 'get', 'cacheFolder'], timeout=3)
        if yarn and len(yarn.strip().splitlines()) == 1 and Path(yarn.strip()).is_absolute():
            compare('yarn berry', yarn.strip(), 'Suggest-only: configure cacheFolder on the source volume; verify a fresh install.')
    return rows


def outside_git(root):
    """A failed/missing Git probe is not permission to write into a checkout."""
    try:
        result = subprocess.run(['git', '-C', str(root), 'rev-parse', '--is-inside-work-tree'],
                                capture_output=True, text=True, timeout=5)
        return (result.returncode == 128 and 'not a git repository' in result.stderr.lower()
                and not any((p / '.git').exists() for p in (root, *root.parents)))
    except (OSError, subprocess.SubprocessError):
        return False


def write_rsp(root, git_probe=outside_git):
    if root is None or not Path(root).is_dir():
        return False, 'apply refused: repositories root unavailable'
    root = Path(root).resolve()
    path = root / 'Directory.Build.rsp'
    if not git_probe(root) or path.is_symlink():
        return False, 'apply refused: repos root is inside a git work tree or Git/path safety is unknown'
    missing = [p for p in PROPERTIES if p not in rsp_properties(root)]
    if not missing:
        return True, 'Hard-link properties already set; no write needed'
    try:
        existing = path.read_text() if path.exists() else ''
        backup = None
        if path.exists():
            with tempfile.NamedTemporaryFile(prefix=path.name + '.backup-', dir=root, delete=False) as stream:
                backup = Path(stream.name)
            shutil.copy2(path, backup)
        with path.open('a') as stream:
            stream.write(('\n' if existing and not existing.endswith('\n') else '')
                         + ''.join('-p:' + p + '=true\n' for p in missing))
        return True, f'action taken: wrote {path}' + (f'; backup: {backup}' if backup else '') + '; ' + CAVEAT
    except (OSError, UnicodeError) as error:
        return False, f'apply failed: {error}'


def cache_size(source, runner):
    output = runner(['du', '-sk', str(source)], timeout=120)
    match = re.fullmatch(r'(\d+)\s+[^\n]+', (output or '').strip())
    if match is None:
        raise OSError('cache size scan failed/timed out (du -sk, 120 s); use the manual commands below')
    return int(match[1]) * 1024


def prepare_target(target, source, create=False):
    """Only a matching marker from an earlier run authorizes resuming a copy."""
    marker = target / MOVE_MARKER
    expected = {'version': 1, 'source': str(source.resolve()), 'target': str(target)}
    if not os.path.lexists(target):
        if create:
            target.mkdir()
            with marker.open('x') as stream:
                json.dump(expected, stream)
        return
    try:
        if target.is_symlink() or not target.is_dir() or marker.is_symlink() or marker.stat().st_size > 4096:
            raise OSError('unsafe target or marker')
        if json.loads(marker.read_text()) != expected:
            raise OSError('marker does not match this move')
    except (OSError, ValueError, UnicodeError) as error:
        raise OSError('target already exists without a matching move marker; review it manually') from error


def idle(runner, phase_state):
    if phase_state(runner) != []:
        raise OSError('running phase or unknown pi-phase status')
    ps = runner(['ps', '-axo', 'comm=,args='], timeout=3)
    if ps is None or not ps.strip():
        raise OSError('process state unknown')
    if re.search(r'(?i)(?:^|[\s/])(dotnet|msbuild|vbcscompiler|testhost)(?:[.\s/]|$)', ps):
        raise OSError('dotnet/MSBuild/VBCSCompiler/testhost process is running')


def move(root, runner, phase_state, progress=None):
    """Never delete the old cache. Partial-copy failures leave both trees intact."""
    logs = []

    def log(message):
        logs.append(message)
        if progress is not None:
            progress(message)

    source = cache_path()
    old = source.parent / (source.name + '.old')
    try:
        if not source.name:
            raise OSError('filesystem root cannot be a package cache')
        if root is None or not Path(root).is_dir():
            raise OSError('repositories root unavailable')
        target = Path(root).resolve() / '.nuget-packages'
        if source.is_symlink() or not source.is_dir():
            raise OSError('cache is missing, not a directory, or already a symlink')
        if os.path.lexists(old):
            raise OSError('packages.old already exists; review it manually')
        if source.resolve() in (target, *target.parents) or target in source.resolve().parents:
            raise OSError('source and target overlap')
        prepare_target(target, source)
        log('step: verify idle phases/processes')
        idle(runner, phase_state)
        log('step: bounded cache size and target free-space check (du -sk, up to 120 s)')
        size = cache_size(source, runner)
        if shutil.disk_usage(target.parent).free < size + 10 * GIB:
            raise OSError('target needs cache size plus 10 GiB free')
        prepare_target(target, source, create=True)
        for label in ('initial copy', 'idle second copy'):
            idle(runner, phase_state)
            cmd = ['rsync', '-a', '--progress', str(source) + '/', str(target) + '/']
            log(f'step: {label} (up to 4 h): ' + shlex.join(cmd))
            if runner(cmd, timeout=RSYNC_TIMEOUT) is None:
                raise OSError('rsync failed/timed out; source untouched; review partial target before retry')
        idle(runner, phase_state)
        log('step: ' + shlex.join(['mv', str(source), str(old)]))
        source.rename(old)
        try:
            log('step: ' + shlex.join(['ln', '-s', str(target), str(source)]))
            source.symlink_to(target, target_is_directory=True)
        except OSError:
            old.rename(source)
            raise
        idle(runner, phase_state)
        cmd = ['rsync', '-a', '--progress', '--ignore-existing', str(old) + '/', str(target) + '/']
        log('step: final copy (up to 4 h): ' + shlex.join(cmd))
        if runner(cmd, timeout=RSYNC_TIMEOUT) is None:
            raise OSError('final rsync failed/timed out; symlink and packages.old retained')
        log('action taken: cache moved; verify a build before deleting the retained old cache')
        log('After a verified build only: ' + shlex.join(['rm', '-rf', '--', str(old)]))
        return True, '\n'.join(logs)
    except OSError as error:
        log(f'move refused/failed: {error}; never delete {old} before a verified build')
        if root is not None:
            log('Manual commands (review existing partial targets before running):\n'
                + '\n'.join(move_commands(source, Path(root).resolve() / '.nuget-packages')))
        return False, '\n'.join(logs)
