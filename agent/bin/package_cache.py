"""Package-volume diagnostics and explicitly requested, bounded cache changes."""
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import time

GIB = 1024 ** 3
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
    old = source.with_name(source.name + '.old')
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


def cache_size(source, timeout=5, max_entries=250000):
    deadline = time.monotonic() + timeout
    total = entries = 0
    def fail(error):
        raise error
    for directory, dirs, files in os.walk(source, followlinks=False, onerror=fail):
        for name in dirs + files:
            entries += 1
            if entries > max_entries or time.monotonic() > deadline:
                raise OSError('cache size scan exceeded its bound')
            path = Path(directory) / name
            if not path.is_symlink():
                total += path.stat().st_size
    return total


def idle(runner, phase_state):
    if phase_state(runner) != []:
        raise OSError('running phase or unknown pi-phase status')
    ps = runner(['ps', '-axo', 'comm=,args='], timeout=3)
    if ps is None or not ps.strip():
        raise OSError('process state unknown')
    if re.search(r'(?i)(?:^|[\s/])(dotnet|msbuild|vbcscompiler|testhost)(?:[.\s/]|$)', ps):
        raise OSError('dotnet/MSBuild/VBCSCompiler/testhost process is running')


def move(root, runner, phase_state):
    """Never delete the old cache. Partial-copy failures leave both trees intact."""
    logs = []
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
        if os.path.lexists(old) or os.path.lexists(target):
            raise OSError('packages.old or target already exists; review it manually')
        if source.resolve() in (target, *target.parents) or target in source.resolve().parents:
            raise OSError('source and target overlap')
        logs.append('step: verify idle phases/processes')
        idle(runner, phase_state)
        logs.append('step: bounded cache size and target free-space check')
        size = cache_size(source)
        if shutil.disk_usage(target.parent).free < size + 10 * GIB:
            raise OSError('target needs cache size plus 10 GiB free')
        target.mkdir()
        for label in ('initial copy', 'idle second copy'):
            idle(runner, phase_state)
            cmd = ['rsync', '-a', str(source) + '/', str(target) + '/']
            logs.append(f'step: {label}: ' + shlex.join(cmd))
            if runner(cmd, timeout=30) is None:
                raise OSError('rsync failed/timed out; source untouched; review partial target before retry')
        idle(runner, phase_state)
        logs.append('step: ' + shlex.join(['mv', str(source), str(old)]))
        source.rename(old)
        try:
            logs.append('step: ' + shlex.join(['ln', '-s', str(target), str(source)]))
            source.symlink_to(target, target_is_directory=True)
        except OSError:
            old.rename(source)
            raise
        idle(runner, phase_state)
        cmd = ['rsync', '-a', '--ignore-existing', str(old) + '/', str(target) + '/']
        logs.append('step: ' + shlex.join(cmd))
        if runner(cmd, timeout=30) is None:
            raise OSError('final rsync failed/timed out; symlink and packages.old retained')
        logs.append('action taken: cache moved; verify a build before deleting the retained old cache')
        logs.append('After a verified build only: ' + shlex.join(['rm', '-rf', '--', str(old)]))
        return True, '\n'.join(logs)
    except OSError as error:
        logs.append(f'move refused/failed: {error}; never delete {old} before a verified build')
        return False, '\n'.join(logs)
