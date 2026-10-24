import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { npmSpec, selectedPins, pinsMissing, packageBinLinks, pinnedNpmManifest } from "./packages.ts";
import { atomicWrite } from "./fsx.ts";
import { BackupRun, prune } from "./backups.ts";
import {
  emptyManifest, fileSha, homeRel, noSource, pinnedBackups, recordArrayAdd, recordSet, saveIfChanged, sha256,
} from "./manifest.ts";
import type { ComponentRecord, FileEntry, JsonEntry, Manifest, Source } from "./manifest.ts";
import type { Action, Ctx, JsonOp, Spinner } from "./types.ts";

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
  /** Already started by the caller; apply reports its phases through message(). */
  spinner?: Spinner;
  /** The choices to record in the manifest. */
  components?: Record<string, ComponentRecord>;
  /** Print one count line instead of a line per action (the guided flow). */
  quiet?: boolean;
}

export interface ApplyResult {
  code: number;
  /** Whether this run changed anything on disk besides the manifest and backups. */
  wrote: boolean;
  /** Absolute paths this run wrote. */
  written: Set<string>;
}

export function describe(action: Action): string | undefined {
  if (action.op === "install") return `install ${action.path}`;
  if (action.op === "keep") return `keep ${action.path} (changed since install; new version in ${action.newPath})`;
  if (action.op === "register") {
    const what = (action.jsonOps ?? []).map((o) => (o.op === "array-add" ? String(o.value) : o.key)).join(", ");
    return `register ${what || "changes"} in ${action.path}`;
  }
  return undefined;
}

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
  /** Files this run wrote or adopted; only these may be chmodded or recorded. */
  readonly written = new Set<string>();
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

  backedUp = 0;

  private backupIfThere(path: string): string | undefined {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    this.backedUp++;
    return this.backups.backup(path);
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
    const priorSha = fileSha(a.path);
    this.ensureDir(dirname(a.path));
    if (/\/(user\.json|settings\.json|ACTIVE)$/.test(a.path)) {
      atomicWrite(a.path, a.content, a.mode);
    } else {
      writeFileSync(a.path, a.content);
      chmodSync(a.path, a.mode);
    }
    if (a.mtimeMs !== undefined) utimesSync(a.path, a.mtimeMs / 1000, a.mtimeMs / 1000);
    this.wrote = true;
    if (a.merge === "user-json") this.recordJson(a.path, a.content, priorSha, !a.existed, backup, a.jsonOps ?? []);
    else this.recordFile(a.path, a.content, backup);
  }

  /** Record a file this run wrote, with the hash of the bytes it wrote. */
  private recordFile(path: string, content: Buffer, backup: string | undefined): void {
    const rel = this.rel(path);
    const entry: FileEntry = this.next.files[rel] ?? { sha256: "", mode: 0, source: this.source, origin: backup ? "replaced" : "new", ...(backup ? { backup } : {}) };
    entry.sha256 = sha256(content);
    entry.mode = modeOf(path);
    entry.source = this.source;
    delete entry.pending;
    this.next.files[rel] = entry;
    this.written.add(path);
  }

  /** priorSha is the hash on disk just before this run wrote; a mismatch with the recorded one means the user edited the file. */
  private recordJson(path: string, content: Buffer, priorSha: string | undefined, created: boolean, backup: string | undefined, ops: JsonOp[]): void {
    const rel = this.rel(path);
    const entry: JsonEntry = this.next.json[rel] ?? { created, sha256After: "", ops: [] };
    if (this.next.json[rel] && priorSha !== entry.sha256After) entry.edited = true;
    if (backup && !entry.created && !entry.backup) entry.backup = backup;
    for (const op of ops) {
      if (op.op === "set") recordSet(entry, op);
      else recordArrayAdd(entry, op);
    }
    entry.sha256After = sha256(content);
    this.next.json[rel] = entry;
  }

  private register(a: Extract<Action, { op: "register" }>): void {
    const file = this.next.files[this.rel(a.path)];
    const priorSha = fileSha(a.path);
    const unmodified = Boolean(file) && priorSha === file.sha256;
    const backup = a.existed ? this.backupIfThere(a.path) : undefined;
    this.ensureDir(dirname(a.path));
    atomicWrite(a.path, a.content, a.mode);
    this.wrote = true;
    if (file && (unmodified || !a.existed)) {
      // pi-setup owns the whole file; the ops let uninstall still revert just them if the user edits it later.
      this.recordFile(a.path, a.content, undefined);
      this.recordJson(a.path, a.content, priorSha, true, undefined, a.jsonOps ?? []);
    } else {
      this.recordJson(a.path, a.content, priorSha, false, backup, a.jsonOps ?? []);
    }
  }

  private keep(a: Extract<Action, { op: "keep" }>): void {
    if (a.write) {
      this.ensureDir(dirname(a.newPath));
      atomicWrite(a.newPath, a.content, a.mode);
      this.wrote = true;
    }
    const entry = this.next.files[this.rel(a.path)];
    const pending = { path: this.rel(a.newPath), sha256: sha256(a.content) };
    if (entry) entry.pending = pending;
    else if (existsSync(a.newPath)) this.next.pendingNew = { ...this.next.pendingNew, [pending.path]: pending.sha256 };
  }

  private adopt(path: string): void {
    const rel = this.rel(path);
    const entry = this.next.files[rel];
    if (!entry) {
      this.next.files[rel] = { sha256: fileSha(path) ?? "", mode: modeOf(path), source: this.source, origin: "adopted" };
    } else {
      const sha = fileSha(path) ?? "";
      if (sha !== entry.sha256) {
        entry.sha256 = sha;
        entry.source = this.source;
      }
      entry.mode = modeOf(path);
      delete entry.pending;
    }
    this.written.add(path);
  }

  linkPackageBins(): void {
    for (const link of packageBinLinks(this.piDir, this.ctx.home)) this.execute({ op: "symlink", ...link });
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

  /** Only for a file this run wrote or adopted; a kept (user-modified) file is never touched. */
  private chmodX(path: string): void {
    if (!this.written.has(path) || !existsSync(path)) return;
    const mode = statSync(path).mode;
    if ((mode & 0o111) === 0) {
      chmodSync(path, mode | 0o111);
      this.wrote = true;
    }
    const entry = this.next.files[this.rel(path)];
    if (entry) entry.mode = modeOf(path);
  }

  /** Save the manifest and prune old backups. */
  finish(): void {
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

/** Hashes of the npm inputs, as recorded after the last successful npm install. */
export function npmInputs(piDir: string): { packageJson: string; lock?: string } | undefined {
  const pkg = join(piDir, "npm", "package.json");
  if (!existsSync(pkg)) return undefined;
  const lock = join(piDir, "npm", "package-lock.json");
  return { packageJson: fileSha(pkg) ?? "", ...(fileSha(lock) ? { lock: fileSha(lock) } : {}) };
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
  if (!options.quiet) {
    for (const action of actions) {
      const line = describe(action);
      if (line) ctx.out(line);
    }
  }
  if (options.dryRun) return { code: 0, wrote: false, written: new Set() };
  const run = new Run(ctx, piDir, manifest, noSource());
  let code = 0;
  try {
    run.source = await sourceOf(ctx);
    options.spinner?.message?.("Writing files");
    for (const action of actions) run.execute(action);
    applyProfile(options, piDir, run);
    if (options.quiet) {
      const installs = actions.filter((a): a is Extract<Action, { op: "install" }> => a.op === "install");
      if (installs.length) ctx.out(`Wrote ${installs.length} files (${installs.filter((a) => a.existed).length} changed, ${run.backedUp} backed up)`);
    }
    if (options.components) run.next.components = options.components;
    if (code === 0) {
      const npm = await runNpm(ctx, actions, options, piDir, manifest);
      code = npm.code;
      if (npm.ran) run.wrote = true;
      if (npm.ran && npm.code === 0) {
        run.next.npm = npmInputs(piDir);
        run.linkPackageBins();
      }
    }
  } finally {
    run.finish();
  }
  return { code, wrote: run.wrote, written: run.written };
}

/** pi-profile is never run: the plan already wrote agents/, workflows/ and the routing block through reconciliation. Only ACTIVE is left. */
function applyProfile(options: ApplyOptions, piDir: string, run: Run): void {
  if (options.activeBefore === options.profile) return;
  const path = join(piDir, "profiles", "ACTIVE");
  run.execute({ op: "install", path, content: Buffer.from(`${options.profile}\n`), mode: 0o644, existed: options.activeBefore !== undefined });
}

function npmChanged(actions: Action[], piDir: string, manifest: Manifest, force: boolean): boolean {
  return pinsMissing(piDir, selectedPins(piDir)) || needsNpm(actions, piDir, manifest, force);
}

async function runNpm(ctx: Ctx, actions: Action[], options: ApplyOptions, piDir: string, manifest?: Manifest): Promise<{ code: number; ran: boolean }> {
  if (options.skipNpm) return { code: 0, ran: false };
  const selected = selectedPins(piDir);
  if (!npmChanged(actions, piDir, manifest, options.reinstallNpm)) {
    ctx.out("npm packages up to date");
    return { code: 0, ran: false };
  }
  const args = ["install", ...selected.map(npmSpec), "--save-exact", "--legacy-peer-deps"];
  const cwd = join(piDir, "npm");
  options.spinner?.message?.("Installing npm packages");
  const result = await installPinnedNpm(ctx, args, cwd, { inherit: options.inheritNpm, selected });
  if (result.code === 0) return { code: 0, ran: true };
  if (!options.inheritNpm) ctx.err((result.stdout + result.stderr).trim().split("\n").slice(-15).join("\n"));
  ctx.err("Files installed; npm install failed: (cd ~/.pi/agent/npm && npm install --legacy-peer-deps)");
  return { code: 1, ran: true };
}

async function installPinnedNpm(ctx: Ctx, args: string[], cwd: string, options: { inherit: boolean; selected: ReturnType<typeof selectedPins> }) {
  const path = join(cwd, "package.json");
  const before = readFileSync(path);
  const pinned = pinnedNpmManifest(before, options.selected);
  if (!pinned) return ctx.run("npm", args, { cwd, inherit: options.inherit });
  let succeeded = false;
  try {
    const result = await ctx.run("npm", args, { cwd, inherit: options.inherit });
    succeeded = result.code === 0;
    return result;
  } finally {
    writeFileSync(path, succeeded ? pinned : before);
  }
}

export function readActive(piDir: string): string | undefined {
  const file = join(piDir, "profiles", "ACTIVE");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}
