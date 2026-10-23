import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, statSync, unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Options } from "./args.ts";
import { atomicWrite } from "./fsx.ts";
import { listBackups, tidy } from "./backups.ts";
import {
  backupsDir, fileSha, fromHomeRel, manifestPath, pinnedBackups, readManifest, saveIfChanged, sha256, validateManifest,
} from "./manifest.ts";
import type { JsonEntry, Manifest } from "./manifest.ts";
import { deepEqual } from "./settings.ts";
import type { Ctx, JsonOp, Prompter } from "./types.ts";
import { SetupError } from "./types.ts";

interface Step {
  line: string;
  run: () => void;
}

const sameLink = (path: string, target: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
};

/** Move a backup back over (or to) its original place; copy and unlink when rename crosses devices. */
function restore(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

class Plan {
  steps: Step[] = [];
  /** What is left in the manifest once the steps ran. */
  remaining: Manifest;
  private backups: string;
  private ctx: Ctx;
  private m: Manifest;

  constructor(ctx: Ctx, piDir: string, m: Manifest) {
    this.ctx = ctx;
    this.m = m;
    this.remaining = structuredClone(m);
    this.backups = backupsDir(piDir);
  }

  private abs(rel: string): string {
    return fromHomeRel(this.ctx.home, rel);
  }

  private backupFile(rel: string | undefined): string | undefined {
    if (!rel) return undefined;
    const path = join(this.backups, rel);
    return existsSync(path) ? path : undefined;
  }

  private add(line: string, run: () => void): void {
    this.steps.push({ line, run });
  }

  build(): Step[] {
    const deleted = new Set<string>();
    for (const [rel, entry] of Object.entries(this.m.files)) if (this.file(rel, entry)) deleted.add(rel);
    for (const [rel, sha] of Object.entries(this.m.pendingNew ?? {})) {
      const path = this.abs(rel);
      if (fileSha(path) === sha) this.add(`remove ${path}`, () => unlinkSync(path));
      delete this.remaining.pendingNew;
    }
    for (const [rel, link] of Object.entries(this.m.symlinks)) this.symlink(rel, link.target);
    for (const [rel, entry] of Object.entries(this.m.json)) {
      if (deleted.has(rel)) delete this.remaining.json[rel];
      else this.json(rel, entry);
    }
    return this.steps;
  }

  /** Returns whether the file ends up removed or restored. */
  private file(rel: string, entry: Manifest["files"][string]): boolean {
    const path = this.abs(rel);
    this.pending(rel, entry);
    if (!lstatExists(path)) {
      delete this.remaining.files[rel];
      return false;
    }
    const backup = this.backupFile(entry.backup);
    if (fileSha(path) !== entry.sha256) {
      const note = backup ? `; your pre-install version: ${backup}` : "";
      this.add(`left (changed by you): ${path}${note}`, () => {});
      if (!entry.backup) delete this.remaining.files[rel];
      return false;
    }
    if (entry.origin === "replaced" && backup) {
      this.add(`restore ${path} (from ${backup})`, () => {
        unlinkSync(path);
        restore(backup, path);
      });
    } else if (entry.origin === "replaced") {
      this.add(`left (pre-install backup is missing): ${path}`, () => {});
      delete this.remaining.files[rel];
      return false;
    } else {
      this.add(`remove ${path}`, () => unlinkSync(path));
    }
    delete this.remaining.files[rel];
    return true;
  }

  private pending(rel: string, entry: Manifest["files"][string]): void {
    if (!entry.pending) return;
    const path = this.abs(entry.pending.path);
    const expected = entry.pending.sha256;
    if (fileSha(path) === expected) this.add(`remove ${path}`, () => unlinkSync(path));
    if (this.remaining.files[rel]) delete this.remaining.files[rel].pending;
  }

  private symlink(rel: string, target: string): void {
    const path = this.abs(rel);
    const targetPath = this.abs(target);
    if (sameLink(path, targetPath) || sameLink(path, target)) this.add(`remove ${path}`, () => unlinkSync(path));
    delete this.remaining.symlinks[rel];
  }

  private json(rel: string, entry: JsonEntry): void {
    const path = this.abs(rel);
    if (!lstatExists(path)) {
      delete this.remaining.json[rel];
      return;
    }
    const backup = this.backupFile(entry.backup);
    if (!entry.edited && fileSha(path) === entry.sha256After && (entry.created || backup)) {
      if (entry.created) this.add(`remove ${path}`, () => unlinkSync(path));
      else this.add(`restore ${path} (from ${backup})`, () => {
        unlinkSync(path);
        restore(backup!, path);
      });
      delete this.remaining.json[rel];
      return;
    }
    this.add(`revert ${path} (${entry.ops.length} change(s) made by pi-setup)`, () => this.revert(rel, path, entry));
  }

  private revert(rel: string, path: string, entry: JsonEntry): void {
    const left: JsonOp[] = [];
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not an object");
    } catch {
      this.ctx.err(`left (cannot read as JSON): ${path}`);
      return;
    }
    for (const op of [...entry.ops].reverse()) {
      if (!undo(data, op)) left.push(op);
    }
    if (entry.created && Object.keys(data).length === 0 && left.length === 0) {
      unlinkSync(path);
      delete this.remaining.json[rel];
      return;
    }
    const mode = statSync(path).mode & 0o7777;
    atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`, mode);
    if (left.length === 0) {
      delete this.remaining.json[rel];
    } else {
      this.remaining.json[rel] = { ...entry, ops: left.reverse(), sha256After: sha256(readFileSync(path)) };
      for (const op of left) this.ctx.err(`left (changed by you): ${op.key} in ${path}`);
    }
  }
}

function undo(data: Record<string, unknown>, op: JsonOp): boolean {
  if (op.op === "set") {
    if (!(op.key in data) || !deepEqual(data[op.key], op.after)) return false;
    if (op.before.present) data[op.key] = op.before.value;
    else delete data[op.key];
    return true;
  }
  const list = data[op.key];
  if (!Array.isArray(list)) return true;
  const at = list.findIndex((v) => deepEqual(v, op.value));
  if (at >= 0) list.splice(at, 1);
  if (op.keyCreated && list.length === 0) delete data[op.key];
  return true;
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function rmdirIfEmpty(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) rmdirSync(path);
  } catch {
    // missing or not empty: leave it
  }
}

export async function runUninstall(ctx: Ctx, options: Options, prompter: Prompter | undefined): Promise<number> {
  const piDir = join(ctx.home, ".pi", "agent");
  const manifest = readManifest(piDir);
  if (!manifest) {
    ctx.out(`No pi-setup manifest at ${manifestPath(piDir)}; nothing is tracked (installs older than this version are adopted by running ./install.sh once).`);
    return 0;
  }
  validateManifest(ctx.home, manifest);
  const plan = new Plan(ctx, piDir, manifest);
  const steps = plan.build();
  for (const step of steps) ctx.out(step.line);
  if (steps.length === 0) ctx.out("Nothing to remove.");
  if (options.dryRun) {
    ctx.out("Nothing was removed (--dry-run).");
    return 0;
  }
  if (prompter) {
    const answer = await prompter.confirm({ message: "Uninstall?", initial: false });
    if (prompter.isCancel(answer) || answer !== true) {
      ctx.err("Cancelled; nothing removed.");
      return 1;
    }
  } else if (!options.yes) {
    throw new SetupError("uninstall changes files; pass --yes to run it without a prompt (or --dry-run to preview)");
  }
  for (const step of steps) step.run();
  finalize(ctx, piDir, manifest, plan.remaining);
  return 0;
}

function finalize(ctx: Ctx, piDir: string, old: Manifest, left: Manifest): void {
  const empty = Object.keys(left.files).length + Object.keys(left.json).length + Object.keys(left.symlinks).length === 0;
  if (empty) {
    if (existsSync(manifestPath(piDir))) unlinkSync(manifestPath(piDir));
  } else {
    left.dirs = left.dirs.filter((d) => lstatExists(fromHomeRel(ctx.home, d)));
    saveIfChanged(piDir, old, left, ctx.now());
  }
  tidy(piDir);
  const rest = listBackups(piDir, pinnedBackups(empty ? undefined : left));
  for (const rel of [...left.dirs].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1))) {
    rmdirIfEmpty(fromHomeRel(ctx.home, rel));
  }
  if (empty && rest.length > 0) ctx.out(`Left in place (may hold your versions): ${backupsDir(piDir)}; remove with: ./install.sh backups prune --keep 0`);
  else if (!empty) ctx.out(`Some files were left; their record stays in ${manifestPath(piDir)}.`);
  ctx.out("Uninstalled.");
}
