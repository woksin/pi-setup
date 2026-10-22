import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "./fsx.ts";
import { BackupRun, prune } from "./backups.ts";
import {
  emptyManifest, homeRel, noSource, pinnedBackups, recordArrayAdd, recordSet, saveIfChanged, sha256,
} from "./manifest.ts";
import type { FileEntry, JsonEntry, Manifest, Source } from "./manifest.ts";
import type { Action, Ctx, JsonOp } from "./types.ts";

const KEEP_RUNS = 10;

export interface ApplyOptions {
  dryRun: boolean;
  skipNpm: boolean;
  /** Run npm install even when package.json and the lock file are unchanged. */
  reinstallNpm?: boolean;
  /** Pass npm's output straight through (not in a spinner, not in --json). */
  inheritNpm: boolean;
  /** Profile to make live, and whether ACTIVE existed before this run. */
  profile: string;
  activeBefore: string | undefined;
  spinner?: { start(message: string): void; stop(message: string): void };
}

export interface ApplyResult {
  code: number;
  /** Whether this run changed anything on disk besides the manifest and backups. */
  wrote: boolean;
}

export function describe(action: Action): string | undefined {
  if (action.op === "install") return `install ${action.path}`;
  if (action.op === "keep") return `keep ${action.path} (changed since install; new version in ${action.newPath})`;
  if (action.op === "register") return `register ./local-packages/pi-questions in ${action.path}`;
  return undefined;
}

const hashFile = (path: string): string => sha256(readFileSync(path));
const modeOf = (path: string): number => statSync(path).mode & 0o7777;

async function sourceOf(ctx: Ctx): Promise<Source> {
  const git = async (args: string[]): Promise<string | null> => {
    const r = await ctx.run("git", ["-C", ctx.repoDir, ...args], { timeoutMs: 5000 });
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  return { release: await git(["describe", "--tags", "--exact-match", "HEAD"]), commit: await git(["rev-parse", "HEAD"]) };
}

/** Performs the writes of one run and keeps the next manifest in step with them. */
class Run {
  readonly backups: BackupRun;
  readonly next: Manifest;
  readonly touched = new Set<string>();
  wrote = false;
  source: Source;
  private dirs = new Set<string>();
  private ctx: Ctx;
  private piDir: string;
  private old: Manifest | undefined;

  constructor(ctx: Ctx, piDir: string, old: Manifest | undefined, source: Source) {
    this.ctx = ctx;
    this.piDir = piDir;
    this.old = old;
    this.source = source;
    this.backups = new BackupRun(piDir, ctx.home, ctx.now());
    this.next = old ? structuredClone(old) : emptyManifest(ctx.now());
  }

  private ensureDir(dir: string): void {
    const missing: string[] = [];
    for (let d = dir; d.startsWith(`${this.ctx.home}/`) && !existsSync(d); d = dirname(d)) missing.push(d);
    mkdirSync(dir, { recursive: true });
    for (const m of missing) this.dirs.add(homeRel(this.ctx.home, m));
  }

  private backupIfThere(path: string): string | undefined {
    return existsSync(path) && statSync(path).isFile() ? this.backups.backup(path) : undefined;
  }

  private rel(path: string): string {
    return homeRel(this.ctx.home, path);
  }

  /** Write one action, then record it. */
  execute(action: Action): void {
    if (action.op === "install") this.install(action);
    else if (action.op === "register") this.register(action);
    else if (action.op === "keep") this.keep(action);
    else if (action.op === "adopt") this.adopt(action.path);
    else if (action.op === "symlink") this.symlink(action);
    else this.chmodX(action.path);
  }

  private install(a: Extract<Action, { op: "install" }>): void {
    const backup = a.existed ? this.backupIfThere(a.path) : undefined;
    this.ensureDir(dirname(a.path));
    if (a.path.endsWith("/user.json") || a.path.endsWith("/settings.json")) {
      atomicWrite(a.path, a.content, a.mode);
    } else {
      writeFileSync(a.path, a.content);
      chmodSync(a.path, a.mode);
    }
    if (a.mtimeMs !== undefined) utimesSync(a.path, a.mtimeMs / 1000, a.mtimeMs / 1000);
    this.wrote = true;
    if (a.merge === "user-json") this.recordJson(a.path, !a.existed, backup, a.jsonOps ?? []);
    else this.recordFile(a.path, backup);
  }

  private recordFile(path: string, backup: string | undefined): void {
    const rel = this.rel(path);
    const entry: FileEntry = this.next.files[rel] ?? { sha256: "", mode: 0, source: this.source, origin: backup ? "replaced" : "new", ...(backup ? { backup } : {}) };
    entry.sha256 = hashFile(path);
    entry.mode = modeOf(path);
    entry.source = this.source;
    delete entry.pending;
    this.next.files[rel] = entry;
    this.touched.add(path);
  }

  private recordJson(path: string, created: boolean, backup: string | undefined, ops: JsonOp[]): void {
    const rel = this.rel(path);
    const entry: JsonEntry = this.next.json[rel] ?? { created, sha256After: "", ops: [] };
    if (backup && !entry.created && !entry.backup) entry.backup = backup;
    for (const op of ops) {
      if (op.op === "set") recordSet(entry, op);
      else recordArrayAdd(entry, op);
    }
    entry.sha256After = hashFile(path);
    this.next.json[rel] = entry;
  }

  private register(a: Extract<Action, { op: "register" }>): void {
    const file = this.next.files[this.rel(a.path)];
    const unmodified = Boolean(file) && existsSync(a.path) && hashFile(a.path) === file.sha256;
    const backup = a.existed ? this.backupIfThere(a.path) : undefined;
    this.ensureDir(dirname(a.path));
    atomicWrite(a.path, a.content, a.mode);
    this.wrote = true;
    if (file && (unmodified || !a.existed)) this.recordFile(a.path, undefined);
    else this.recordJson(a.path, false, backup, a.jsonOps ?? []);
  }

  private keep(a: Extract<Action, { op: "keep" }>): void {
    if (a.write) {
      this.ensureDir(dirname(a.newPath));
      atomicWrite(a.newPath, a.content, a.mode);
      this.wrote = true;
    }
    const entry = this.next.files[this.rel(a.path)];
    if (entry) entry.pending = { path: this.rel(a.newPath), sha256: sha256(a.content) };
  }

  private adopt(path: string): void {
    const rel = this.rel(path);
    const entry = this.next.files[rel];
    if (!entry) {
      this.next.files[rel] = { sha256: hashFile(path), mode: modeOf(path), source: this.source, origin: "adopted" };
    } else {
      const sha = hashFile(path);
      if (sha !== entry.sha256) {
        entry.sha256 = sha;
        entry.source = this.source;
      }
      entry.mode = modeOf(path);
      delete entry.pending;
    }
    this.touched.add(path);
  }

  private symlink(a: Extract<Action, { op: "symlink" }>): void {
    try {
      lstatSync(a.path);
      return;
    } catch {
      // not there: create it
    }
    this.ensureDir(dirname(a.path));
    symlinkSync(a.target, a.path);
    this.wrote = true;
    this.next.symlinks[this.rel(a.path)] = { target: this.rel(a.target) };
  }

  private chmodX(path: string): void {
    if (existsSync(path) && (statSync(path).mode & 0o111) === 0) {
      chmodSync(path, statSync(path).mode | 0o111);
      this.wrote = true;
    }
    this.touched.add(path);
  }

  /** ACTIVE was written by this run, or pi-profile may have rewritten it. */
  trackActive(path: string, created: boolean): void {
    const rel = this.rel(path);
    if (created && !this.next.files[rel]) {
      this.next.files[rel] = { sha256: "", mode: 0, source: this.source, origin: "new" };
      this.touched.add(path);
    } else if (this.next.files[rel]) {
      this.touched.add(path);
    }
  }

  /** Hash what is on disk now (pi-profile may have rewritten files), then save and prune. */
  finish(): void {
    for (const path of this.touched) {
      const entry = this.next.files[this.rel(path)];
      if (!entry || !existsSync(path)) continue;
      const sha = hashFile(path);
      if (entry.sha256 !== "" && sha !== entry.sha256) entry.source = this.source;
      entry.sha256 = sha;
      entry.mode = modeOf(path);
    }
    for (const rel of [...this.dirs].sort()) if (!this.next.dirs.includes(rel)) this.next.dirs.push(rel);
    if (this.wrote) this.next.source = this.source;
    const hasEntries = Object.keys(this.next.files).length + Object.keys(this.next.json).length + Object.keys(this.next.symlinks).length > 0;
    if (this.old || hasEntries) saveIfChanged(this.piDir, this.old, this.next, this.ctx.now());
    try {
      prune(this.piDir, KEEP_RUNS, pinnedBackups(this.next), false);
    } catch (error) {
      this.ctx.err(`warning: could not prune old backups: ${(error as Error).message}`);
    }
  }
}

/** Whether this run changed anything pi-profile manages. */
export function touchesProfile(actions: Action[], piDir: string, profile: string): boolean {
  const watched = [join(piDir, "agents"), join(piDir, "workflows"), join(piDir, "profiles", profile), join(piDir, "AGENTS.md")];
  return actions.some((a) => (a.op === "install" || a.op === "register") && watched.some((w) => a.path === w || a.path.startsWith(`${w}/`)));
}

/** Hashes of the npm inputs, as recorded after the last successful npm install. */
export function npmInputs(piDir: string): { packageJson: string; lock?: string } | undefined {
  const pkg = join(piDir, "npm", "package.json");
  if (!existsSync(pkg)) return undefined;
  const lock = join(piDir, "npm", "package-lock.json");
  return { packageJson: hashFile(pkg), ...(existsSync(lock) ? { lock: hashFile(lock) } : {}) };
}

export function needsNpm(actions: Action[], piDir: string, manifest?: Manifest, force = false): boolean {
  const npmDir = join(piDir, "npm");
  const pkg = join(npmDir, "package.json");
  const lock = join(npmDir, "node_modules", ".package-lock.json");
  if (actions.some((a) => a.op === "install" && a.path === pkg)) return true;
  if (!existsSync(pkg)) return false;
  if (force || !existsSync(join(npmDir, "node_modules"))) return true;
  const known = manifest?.npm;
  if (known) {
    const now = npmInputs(piDir);
    return now?.packageJson !== known.packageJson || now?.lock !== known.lock;
  }
  if (!existsSync(lock)) return true;
  return statSync(pkg).mtimeMs > statSync(lock).mtimeMs;
}

export async function apply(ctx: Ctx, actions: Action[], options: ApplyOptions, manifest?: Manifest): Promise<ApplyResult> {
  const piDir = join(ctx.home, ".pi", "agent");
  for (const action of actions) {
    const line = describe(action);
    if (line) ctx.out(line);
  }
  if (options.dryRun) return { code: 0, wrote: false };
  const run = new Run(ctx, piDir, manifest, noSource());
  let code = 0;
  try {
    run.source = await sourceOf(ctx);
    for (const action of actions) run.execute(action);
    code = await applyProfile(ctx, actions, options, piDir, run);
    if (code === 0) {
      const npm = await runNpm(ctx, actions, options, piDir, manifest);
      code = npm.code;
      if (npm.ran) run.wrote = true;
      if (npm.ran && npm.code === 0) run.next.npm = npmInputs(piDir);
    }
  } finally {
    run.finish();
  }
  return { code, wrote: run.wrote };
}

async function applyProfile(ctx: Ctx, actions: Action[], options: ApplyOptions, piDir: string, run: Run): Promise<number> {
  const active = join(piDir, "profiles", "ACTIVE");
  if (options.activeBefore === undefined) {
    mkdirSync(dirname(active), { recursive: true });
    atomicWrite(active, `${options.profile}\n`, 0o644);
    run.wrote = true;
    run.trackActive(active, true);
    return 0;
  }
  if (options.activeBefore === options.profile && !touchesProfile(actions, piDir, options.profile)) return 0;
  run.wrote = true;
  run.trackActive(active, false);
  const result = await ctx.run("python3", [join(piDir, "bin", "pi-profile"), "use", options.profile, "--force"], { timeoutMs: 60000 });
  if (result.code !== 0) {
    ctx.err(`pi-profile use ${options.profile} failed: ${(result.stderr || result.stdout).trim()}`);
    return 1;
  }
  return 0;
}

async function runNpm(ctx: Ctx, actions: Action[], options: ApplyOptions, piDir: string, manifest?: Manifest): Promise<{ code: number; ran: boolean }> {
  if (options.skipNpm) return { code: 0, ran: false };
  if (!needsNpm(actions, piDir, manifest, options.reinstallNpm)) {
    ctx.out("npm packages up to date");
    return { code: 0, ran: false };
  }
  const args = ["install", "--legacy-peer-deps"];
  const cwd = join(piDir, "npm");
  options.spinner?.start("Installing npm packages");
  const result = await ctx.run("npm", args, { cwd, inherit: options.inheritNpm });
  options.spinner?.stop(result.code === 0 ? "npm packages installed" : "npm install failed");
  if (result.code === 0) return { code: 0, ran: true };
  if (!options.inheritNpm) ctx.err((result.stdout + result.stderr).trim().split("\n").slice(-15).join("\n"));
  ctx.err("Files installed; npm install failed: (cd ~/.pi/agent/npm && npm install --legacy-peer-deps)");
  return { code: 1, ran: true };
}

export function readActive(piDir: string): string | undefined {
  const file = join(piDir, "profiles", "ACTIVE");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}
