import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function hookScript(path, chained) {
  const runner = fileURLToPath(new URL('./train-hook-runner.mjs', import.meta.url));
  const chain = chained ? `\n${quote(path + '.pi-train-chained')} "$@" < "$refs" || exit $?\n` : '\n';
  return `#!/bin/sh\n${MARKER}\nrefs=$(mktemp) || exit 2\ntrap 'rm -f "$refs"' EXIT HUP INT TERM\ncat > "$refs" || exit 2\n${chain}${quote(process.execPath)} ${quote(runner)} guard --stdin --push-url "$2" < "$refs"\n`;
}

async function uninstallHook(hook, dryRun) {
  const { path, chained, existing, saved, owned } = hook;
  if (existing && !owned) throw new TrainError('pre-push is not a pi-train hook; refusing to remove it');
  if (dryRun || !owned) return;
  await rm(path);
  if (saved !== null) await rename(chained, path);
}

async function installHook(hook, dryRun) {
  const { path, chained, existing, saved, owned } = hook;
  if (owned) return;
  if (saved !== null) throw new TrainError('chained hook already exists; inspect before installing');
  if (dryRun) return;
  await mkdir(dirname(path), { recursive: true });
  if (existing !== null) await rename(path, chained);
  await writeFile(path, hookScript(path, existing !== null), { mode: 0o755, flag: 'wx' });
  await chmod(path, 0o755);
}

export async function manageHook(ctx, api, action, dryRun) {
  if (!['install', 'uninstall'].includes(action)) throw new TrainError('hook requires install or uninstall', 2);
  const path = await hookPath(ctx, api), chained = `${path}.pi-train-chained`;
  const existing = await contents(path), saved = await contents(chained);
  const owned = existing?.split('\n')[1] === MARKER;
  const perform = action === 'install' ? installHook : uninstallHook;
  await perform({ path, chained, existing, saved, owned }, dryRun);
  ctx.out(`${dryRun ? 'would ' : ''}${action} train hook: ${path}`);
}
