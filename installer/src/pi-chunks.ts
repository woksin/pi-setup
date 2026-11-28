import { constants, copyFileSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { appendLog } from "./install-log.ts";
import { PI_PACKAGE } from "./prereqs.ts";
import type { Ctx, RunResult } from "./types.ts";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function chunkDir(prefix: string, packagePath: string): string {
  const pkg = realpathSync(packagePath);
  if (!inside(prefix, pkg)) throw new Error("pi package resolves outside the npm global prefix");
  const chunks = realpathSync(join(pkg, "dist/bundle/chunks"));
  if (!inside(pkg, chunks)) throw new Error("pi chunks resolve outside the pi package");
  return chunks;
}

async function npmGlobalModules(ctx: Ctx, prefix: string): Promise<string> {
  const result = await ctx.run("npm", ["root", "-g", "--prefix", prefix], { timeoutMs: 8000 });
  const modules = result.stdout.trim();
  if (result.code !== 0 || result.timedOut || !isAbsolute(modules)) throw new Error("could not resolve npm's global package directory");
  return modules;
}

async function locateOldChunks(ctx: Ctx, prefix: string) {
  if (!isAbsolute(prefix)) throw new Error("npm global prefix is not absolute");
  try {
    const resolvedPrefix = realpathSync(prefix);
    const packagePath = join(await npmGlobalModules(ctx, prefix), PI_PACKAGE);
    return { resolvedPrefix, packagePath, dir: chunkDir(resolvedPrefix, packagePath) };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // No existing global installation with chunks (for example, a first install).
    return undefined;
  }
}

interface Chunk { name: string; mtimeMs: number }

function snapshotChunks(dir: string, temp: string): Chunk[] {
  const files: Chunk[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = join(dir, entry.name);
    const { mtimeMs } = statSync(source);
    copyFileSync(source, join(temp, entry.name));
    files.push({ name: entry.name, mtimeMs });
  }
  return files;
}

function warn(ctx: Ctx, action: string, error: unknown): void {
  const message = `warning: could not ${action} pi bundle chunks: ${error instanceof Error ? error.message : String(error)}`;
  ctx.err(message);
  appendLog(ctx, `${message}\n`);
}

function restoreChunks(ctx: Ctx, dir: string, temp: string, files: Chunk[]): void {
  const cutoff = ctx.now().getTime() - MAX_AGE_MS;
  let preserved = 0;
  try {
    for (const { name, mtimeMs } of files) {
      // Expire only old copies: files shipped in the new tree are never pruned.
      if (mtimeMs < cutoff) continue;
      const dest = join(dir, name);
      try {
        copyFileSync(join(temp, name), dest, constants.COPYFILE_EXCL);
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        throw error;
      }
      preserved++;
      // Restoring a retained chunk must not restart its 30-day lifetime.
      utimesSync(dest, mtimeMs / 1000, mtimeMs / 1000);
    }
  } finally {
    appendLog(ctx, `[pi-chunks preserved=${preserved}]\n`);
  }
}

function removeSnapshot(ctx: Ctx, temp: string): void {
  try { rmSync(temp, { recursive: true, force: true }); }
  catch (error) { warn(ctx, "remove the snapshot of", error); }
}

async function takeSnapshot(ctx: Ctx, prefix: string) {
  let temp: string | undefined;
  try {
    const old = await locateOldChunks(ctx, prefix);
    if (!old) return undefined;
    temp = mkdtempSync(join(tmpdir(), "pi-setup-chunks-"));
    return { ...old, temp, files: snapshotChunks(old.dir, temp) };
  } catch (error) {
    warn(ctx, "snapshot", error);
    if (temp) removeSnapshot(ctx, temp);
    return undefined;
  }
}

/** Best effort around the global npm install; only a successful install gets old chunks back. */
export async function installWithPiChunks(ctx: Ctx, prefix: string, install: () => Promise<RunResult>): Promise<RunResult> {
  const old = await takeSnapshot(ctx, prefix);
  if (!old) return install();
  try {
    const result = await install();
    if (result.code === 0 && !result.timedOut) {
      try {
        restoreChunks(ctx, chunkDir(old.resolvedPrefix, old.packagePath), old.temp, old.files);
      } catch (error) {
        warn(ctx, "restore", error);
      }
    }
    return result;
  } finally {
    removeSnapshot(ctx, old.temp);
  }
}
