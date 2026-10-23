import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { backupCopy, timestamp } from "./fsx.ts";
import { backupsDir, pinnedBackups, readManifest } from "./manifest.ts";

const RUN_DIR = /^(\d{8}-\d{6})(?:-(\d+))?$/;

/** One run's backup folder, created on the first file that needs backing up. */
export class BackupRun {
  private dir: string | undefined;
  private piDir: string;
  private home: string;
  private now: Date;

  constructor(piDir: string, home: string, now: Date) {
    this.piDir = piDir;
    this.home = home;
    this.now = now;
  }

  /** Copy abs into this run's folder; returns the path relative to .pi-setup/backups/. */
  backup(abs: string): string {
    const run = this.runDir();
    const inside = abs.startsWith(`${this.piDir}/`);
    const rel = inside ? relative(this.piDir, abs) : `_home/${relative(this.home, abs)}`;
    const target = join(run, rel);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      backupCopy(abs, target);
    }
    return `${relative(backupsDir(this.piDir), run)}/${rel}`;
  }

  private runDir(): string {
    if (this.dir) return this.dir;
    const base = backupsDir(this.piDir);
    mkdirSync(base, { recursive: true });
    const stamp = timestamp(this.now);
    for (let n = 1; ; n++) {
      const candidate = join(base, n === 1 ? stamp : `${stamp}-${n}`);
      try {
        mkdirSync(candidate);
        this.dir = candidate;
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
}

export interface BackupInfo {
  name: string;
  path: string;
  files: string[];
  pinned: boolean;
}

function filesBelow(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesBelow(dir, rel));
    else out.push(rel);
  }
  return out;
}

function order(name: string): [string, number] {
  const m = RUN_DIR.exec(name)!;
  return [m[1], m[2] ? Number(m[2]) : 1];
}

/** Run folders, newest first. */
export function listBackups(piDir: string, pinned: Set<string>): BackupInfo[] {
  const base = backupsDir(piDir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RUN_DIR.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x[0] === y[0] ? y[1] - x[1] : x[0] < y[0] ? 1 : -1;
    })
    .map((name) => {
      const files = filesBelow(join(base, name));
      return { name, path: join(base, name), files, pinned: files.some((f) => pinned.has(`${name}/${f}`)) };
    });
}

function pruneEmptyDirs(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmptyDirs(join(dir, e.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Delete all but the newest `keep` run folders. A pinned file (one the manifest points at) is never
 * deleted; its folder stays with only its pinned files. Returns the paths removed.
 */
export function prune(piDir: string, keep: number, pinned: Set<string>, dryRun: boolean): string[] {
  const removed: string[] = [];
  for (const info of listBackups(piDir, pinned).slice(keep)) {
    if (!info.pinned) {
      removed.push(info.path);
      if (!dryRun) rmSync(info.path, { recursive: true, force: true });
      continue;
    }
    for (const file of info.files) {
      if (pinned.has(`${info.name}/${file}`)) continue;
      removed.push(join(info.path, file));
      if (!dryRun) unlinkSync(join(info.path, file));
    }
    if (!dryRun) {
      for (const e of readdirSync(info.path, { withFileTypes: true })) if (e.isDirectory()) pruneEmptyDirs(join(info.path, e.name));
    }
  }
  return removed;
}

/** Remove empty folders below .pi-setup/backups, then the data folder itself when it is empty. */
export function tidy(piDir: string): void {
  const base = backupsDir(piDir);
  if (existsSync(base) && statSync(base).isDirectory()) pruneEmptyDirs(base);
  const data = dirname(base);
  if (existsSync(data) && readdirSync(data).length === 0) rmdirSync(data);
}

/** `backups list` and `backups prune`. */
export function backupsCommand(
  ctx: { home: string; out: (line: string) => void }, sub: "list" | "prune", keep: number, dryRun: boolean,
): number {
  const piDir = join(ctx.home, ".pi", "agent");
  const pinned = pinnedBackups(readManifest(piDir));
  if (sub === "list") {
    const all = listBackups(piDir, pinned);
    if (all.length === 0) ctx.out("No backups.");
    for (const b of all) ctx.out(`${b.name}  ${b.files.length} file(s)${b.pinned ? "  (pinned: uninstall restores from it)" : ""}`);
    return 0;
  }
  const removed = prune(piDir, keep, pinned, dryRun);
  for (const path of removed) ctx.out(`${dryRun ? "would remove" : "remove"} ${path}`);
  ctx.out(removed.length === 0 ? "Nothing to prune." : dryRun ? "Nothing was removed." : `Removed ${removed.length} item(s).`);
  return 0;
}
