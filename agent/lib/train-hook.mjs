import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TrainError } from './train-gh.mjs';

const MARKER = '# pi-train pre-push v1';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function contents(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function hookPath(ctx, api) {
  const configured = await api.git(ctx.cwd, ['config', '--get', 'core.hooksPath'], { allowFailure: true });
  if (configured.status > 1) throw new TrainError(configured.stderr || 'cannot read core.hooksPath', 2);
  const common = (await api.git(ctx.cwd, ['rev-parse', '--git-common-dir'])).stdout.trim();
  return join(resolve(ctx.cwd, configured.stdout.trim() || join(common, 'hooks')), 'pre-push');
}

function chainedScript(path) {
  const saved = quote(path + '.pi-train-chained');
  return `if [ -x ${saved} ]; then\n  ${saved} "$@" < "$refs" || exit $?\nelse\n  printf '%s\\n' 'pi-train: existing hook is not executable; not chained' >&2\nfi\n`;
}

function hookScript(path, chained) {
  const runner = new URL('./train-hook-runner.mjs', import.meta.url).href;
  // Catch import/startup failures too: only the guard's positive match may return 1.
  const start = 'try { await import(process.argv[1]); } catch (error) { console.error(error.message); process.exitCode = 2; }';
  const chain = chained ? chainedScript(path) : '';
  return `#!/bin/sh
${MARKER}
unavailable() { printf '%s\\n' 'pi-train guard unavailable; push allowed' >&2; exit 0; }
refs=$(mktemp) || unavailable
trap 'rm -f "$refs"' EXIT HUP INT TERM
cat > "$refs" || unavailable
${chain}node=$(command -v node 2>/dev/null)
if [ ! -x "$node" ]; then node=${quote(process.execPath)}; fi
[ -x "$node" ] || unavailable
"$node" --input-type=module -e ${quote(start)} ${quote(runner)} guard --stdin --push-url "$2" < "$refs"
status=$?
case "$status" in
  0) exit 0 ;;
  1) exit 1 ;;
  *) unavailable ;;
esac
`;
}

async function uninstallHook(hook, dryRun) {
  const { path, chained, existing, saved, owned } = hook;
  if (existing && !owned) throw new TrainError('pre-push is not a pi-train hook; refusing to remove it');
  if (dryRun || !owned) return;
  await rm(path);
  if (saved !== null) await rename(chained, path);
}

async function isExecutable(path) {
  try { await access(path, constants.X_OK); return true; }
  catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) return false; throw error; }
}

async function chainOriginal(hook, ctx) {
  if (hook.existing === null) return false;
  const executable = await isExecutable(hook.path);
  if (!executable) ctx.err('pi-train: existing hook is not executable; not chained');
  return executable;
}

async function writeInstalledHook(hook, chain) {
  const { path, chained, existing } = hook;
  await mkdir(dirname(path), { recursive: true });
  if (existing !== null) await rename(path, chained);
  await writeFile(path, hookScript(path, chain), { mode: 0o755, flag: 'wx' });
  await chmod(path, 0o755);
}

async function installHook(hook, dryRun, ctx) {
  if (hook.owned) return;
  if (hook.saved !== null) throw new TrainError('chained hook already exists; inspect before installing');
  const chain = await chainOriginal(hook, ctx);
  if (!dryRun) await writeInstalledHook(hook, chain);
}

async function canonicalDirectory(directory) {
  try { return await realpath(directory); }
  catch (error) { if (error.code === 'ENOENT') return directory; throw error; }
}

function outsideRepo(path) {
  return isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`);
}

async function checkHookDirectory(ctx, api, path) {
  const directory = await canonicalDirectory(dirname(path));
  if (basename(directory) === '_' && basename(dirname(directory)) === '.husky') {
    throw new TrainError('refusing to install into a husky-managed hooks directory');
  }
  const top = (await api.git(ctx.cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const root = await realpath(top), local = relative(root, directory);
  if (outsideRepo(local)) return;
  const tracked = (await api.git(root, ['ls-files', '--', local || '.'])).stdout.trim();
  if (tracked) throw new TrainError('refusing to install into a tracked hooks directory; choose an untracked core.hooksPath');
}

async function hookState(path) {
  const chained = `${path}.pi-train-chained`;
  const existing = await contents(path), saved = await contents(chained);
  return { path, chained, existing, saved, owned: existing?.split('\n')[1] === MARKER };
}

export async function manageHook(ctx, api, action, dryRun) {
  if (!['install', 'uninstall'].includes(action)) throw new TrainError('hook requires install or uninstall', 2);
  const path = await hookPath(ctx, api);
  if (action === 'install') await checkHookDirectory(ctx, api, path);
  const perform = action === 'install' ? installHook : uninstallHook;
  await perform(await hookState(path), dryRun, ctx);
  ctx.out(`${dryRun ? 'would ' : ''}${action} train hook: ${path}`);
}
