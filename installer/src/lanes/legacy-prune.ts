import { readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { archiveDir, expand, UsageError, type Config } from "./config.ts";
import type { LanesCtx } from "./ctx.ts";
import { parseMessageName } from "./names.ts";

interface LegacyFile { name: string; path: string; info: Stats }
interface Storage {
  stat(path: string): Stats | undefined;
  archive(file: LegacyFile, dir: string): boolean;
}
interface Request { opts: Record<string, string>; config: Config; root: string; ctx: LanesCtx }
interface LegacyResult { dryRun: boolean; archived: string[]; skippedCollision: string[] }
interface Settings { dir: string; destination: string; cutoff: number; dryRun: boolean }
function settings({ opts, config, root, ctx }: Request): Settings {
  const hours = Number(opts["legacy-age"] ?? 24);
  if (!Number.isFinite(hours) || hours < 24) throw new UsageError("--legacy-age must be at least 24 hours");
  if (opts.apply && opts["dry-run"]) throw new UsageError("choose --apply or --dry-run");
  const base = archiveDir(config, root, ctx.home);
  return { dir: expand(config.messages.dir, config, root, ctx.home),
    destination: config.messages.retention ? base : join(base, "legacy"),
    cutoff: ctx.now().getTime() - hours * 3600000, dryRun: !opts.apply };
}
class LegacyArchive {
  private options: Settings;
  private storage: Storage;
  constructor(options: Settings, storage: Storage) { this.options = options; this.storage = storage; }
  private directory(path: string): Stats | undefined {
    const info = this.storage.stat(path);
    if (!info) return undefined;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`not a regular directory: ${path}`);
    return info;
  }
  private candidate(name: string): LegacyFile[] {
    if (name.startsWith(".") || parseMessageName(name)) return [];
    const path = join(this.options.dir, name); const info = this.storage.stat(path);
    return info?.isFile() && info.mtimeMs < this.options.cutoff ? [{ name, path, info }] : [];
  }
  private files(): LegacyFile[] {
    this.directory(this.options.destination);
    if (!this.directory(this.options.dir)) return [];
    return readdirSync(this.options.dir).flatMap(name => this.candidate(name));
  }
  private collision(file: LegacyFile): boolean {
    if (this.storage.stat(join(this.options.destination, file.name))) return true;
    return !this.options.dryRun && !this.storage.archive(file, this.options.destination);
  }
  run(): LegacyResult {
    const result: LegacyResult = { dryRun: this.options.dryRun, archived: [], skippedCollision: [] };
    for (const file of this.files()) (this.collision(file) ? result.skippedCollision : result.archived).push(file.name);
    return result;
  }
}
function show(result: LegacyResult, ctx: LanesCtx): void {
  for (const name of result.archived) ctx.out(`${result.dryRun ? "would archive" : "archived"}: ${name}`);
  ctx.out(`legacy ${result.dryRun ? "dry run" : "apply"}: archived: ${result.archived.length}, skipped (collision): ${result.skippedCollision.length}`);
}
export function pruneLegacy(request: Request, storage: Storage): number {
  const result = new LegacyArchive(settings(request), storage).run();
  if (request.opts.json) request.ctx.out(JSON.stringify(result));
  else show(result, request.ctx);
  return 0;
}
