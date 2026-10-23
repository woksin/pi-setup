import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TrainError } from './train-gh.mjs';

export const slug = branch => branch.replace(/[^A-Za-z0-9._-]/g, '_');
export const trainHome = env => env.PI_TRAIN_DIR || join(env.HOME || homedir(), '.pi', 'trains');

const validRepo = repo => /^[\w.-]+\/[\w.-]+$/.test(repo);
const validBranch = branch => !!branch && !['.', '..'].includes(slug(branch));

export function repoKey(remote) {
  const match = remote.trim().match(/(?:[:/])([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!match) throw new TrainError('origin must identify an owner/repo', 2);
  const repo = `${match[1]}/${match[2]}`;
  if (!validRepo(repo)) throw new TrainError('origin must identify an owner/repo', 2);
  return repo;
}

export function manifestPath(env, repo, branch) {
  if (!validRepo(repo) || !validBranch(branch)) throw new TrainError('invalid repository or train branch', 2);
  return join(trainHome(env), repo.replace('/', '__'), `${slug(branch)}.json`);
}

export async function loadManifest(path, branch) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const manifest = JSON.parse(text);
  if (manifest.v !== 1) throw new TrainError(`unsupported train manifest version: ${manifest.v}`);
  if (branch && manifest.train !== branch) throw new TrainError(`train slug collision: ${branch} and ${manifest.train}`);
  return manifest;
}

async function entries(path) {
  try { return await readdir(path); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function listManifests(env, repo) {
  const home = trainHome(env);
  const dirs = repo ? [repo.replace('/', '__')] : await entries(home);
  const result = [];
  for (const dir of dirs) {
    for (const name of await entries(join(home, dir))) {
      if (!name.endsWith('.json')) continue;
      const path = join(home, dir, name);
      result.push({ path, manifest: await loadManifest(path) });
    }
  }
  return result;
}

export async function saveManifest(path, manifest) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

function dead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function staleLock(lock) {
  try {
    const age = Date.now() - (await stat(lock)).mtimeMs;
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    return age > 600_000 || (Number.isInteger(owner.pid) && owner.pid > 0 && dead(owner.pid));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      try { return Date.now() - (await stat(lock)).mtimeMs > 600_000; }
      catch { return false; }
    }
    throw error;
  }
}

async function reapStaleLock(lock) {
  const reaper = `${lock}.reap`;
  try { await mkdir(reaper); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    if (await staleLock(lock)) await rm(lock, { recursive: true, force: true });
  } finally { await rm(reaper, { recursive: true, force: true }); }
}

export async function withManifestLock(path, action) {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await reapStaleLock(lock);
    if (Date.now() >= deadline) throw new TrainError(`train is locked: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const ownerPath = join(lock, 'owner.json');
  try {
    const owner = await open(ownerPath, 'wx', 0o600);
    try { await owner.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token })); }
    finally { await owner.close(); }
    return await action();
  } finally {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (owner.token === token) await rm(lock, { recursive: true, force: true });
  }
}
