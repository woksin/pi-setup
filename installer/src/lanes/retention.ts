import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { addressed } from "./backend.ts";
import { archiveDir, expand, UsageError, type Config } from "./config.ts";
import type { LanesCtx } from "./ctx.ts";
import { parseMessageName } from "./names.ts";

export interface PruneCounts { archived: number; deleted: number; skippedUnread: number; skippedCollision: number; kept: number; archiveExpired: number }
const DAY = 86400000;
function stat(path: string) {
  try { return lstatSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
function messages(dir: string) {
  const info = stat(dir);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`not a regular directory: ${dir}`);
  return readdirSync(dir).flatMap((name) => {
    const parsed = parseMessageName(name);
    if (!parsed || name.startsWith(".")) return [];
    const path = join(dir, name); const info = stat(path);
    return info?.isFile() ? [{ name, path, info, ...parsed, at: info.mtime }] : [];
  });
}
function unread(m: ReturnType<typeof messages>[number], c: Config, dir: string): boolean {
  const broadcast = addressed(m, "ALL") || addressed(m, c.messages.broadcast);
  return [c.coordinator.id, ...c.lanes.map((lane) => lane.id)].some((id) => {
    if (!broadcast && !addressed(m, id)) return false;
    const marker = stat(join(dir, `${id}-inbox.marker`));
    return marker?.isFile() === true && marker.mtimeMs < m.info.mtimeMs;
  });
}
function archive(m: ReturnType<typeof messages>[number], dir: string): boolean {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, m.name);
  // Reserve the destination exclusively: rename must never replace another message.
  try { closeSync(openSync(target, "wx")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
  try {
    try { renameSync(m.path, target); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      copyFileSync(m.path, target);
      utimesSync(target, m.info.atime, m.info.mtime);
      unlinkSync(m.path);
    }
  } catch (e) { unlinkSync(target); throw e; }
  return true;
}
export function prune(c: Config, root: string, ctx: LanesCtx, dryRun = false): PruneCounts {
  const counts: PruneCounts = { archived: 0, deleted: 0, skippedUnread: 0, skippedCollision: 0, kept: 0, archiveExpired: 0 };
  const dir = expand(c.messages.dir, c, root, ctx.home);
  const r = c.messages.retention;
  if (!r || (r.mode === "keep" && r.archiveMaxAgeDays === null)) { counts.kept = messages(dir).length; return counts; }
  const destination = archiveDir(c, root, ctx.home);
  if (destination === dir || (stat(destination) && stat(dir) && realpathSync(destination) === realpathSync(dir))) {
    throw new UsageError("invalid messages.retention.archiveDir (must not be messages.dir)");
  }
  const destinationInfo = stat(destination);
  if (destinationInfo && (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink())) throw new Error(`not a regular directory: ${destination}`);
  const now = ctx.now().getTime();
  // Expire existing archive entries before moving new messages into it.
  if (r.archiveMaxAgeDays !== null) {
    for (const m of messages(destination)) {
      if (m.info.mtimeMs >= now - r.archiveMaxAgeDays * DAY) continue;
      if (!dryRun) unlinkSync(m.path);
      counts.archiveExpired++;
    }
  }
  for (const m of messages(dir)) {
    if (r.mode === "keep" || m.info.mtimeMs >= now - r.maxAgeDays * DAY) { counts.kept++; continue; }
    if (r.keepUnread && unread(m, c, dir)) { counts.skippedUnread++; continue; }
    if (r.mode === "delete") {
      if (!dryRun) unlinkSync(m.path);
      counts.deleted++; continue;
    }
    const target = stat(join(destination, m.name));
    const expired = target?.isFile() && r.archiveMaxAgeDays !== null && target.mtimeMs < now - r.archiveMaxAgeDays * DAY;
    if ((target && !(dryRun && expired)) || (!dryRun && !archive(m, destination))) { counts.skippedCollision++; continue; }
    counts.archived++;
  }
  return counts;
}
export function messagesPrune(opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): number {
  const counts = prune(c, root, ctx, opts["dry-run"] === "true");
  ctx.out(opts.json === "true" ? JSON.stringify(counts) : `archived: ${counts.archived}, deleted: ${counts.deleted}, skipped (unread): ${counts.skippedUnread}, skipped (collision): ${counts.skippedCollision}, kept: ${counts.kept}, archive-expired: ${counts.archiveExpired}`);
  return 0;
}
