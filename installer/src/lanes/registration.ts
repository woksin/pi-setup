import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LanesCtx } from "./ctx.ts";
import { UsageError, type Config } from "./config.ts";
import { runningPiChecked } from "./processes.ts";
import { validId } from "./names.ts";
import { readJsonDir, type RosterInputs, type RosterRow } from "./roster.ts";

export interface Registration { id: string; pid: number; cwd: string; startedAt: string; retiredAt?: string }
export interface CheckedRegistration extends Registration { alive: boolean }
export const registrationDir = (root: string): string => join(root, ".state/roster");
function registrationPath(root: string, id: string): string {
  if (!validId(id)) throw new Error("invalid registration id");
  return join(registrationDir(root), `${id}.json`);
}
export function writeRegistration(root: string, record: Registration): void {
  const path = registrationPath(root, record.id); const dir = registrationDir(root);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${record.id}-${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { flag: "wx" }); renameSync(tmp, path);
}
export function retireRegistration(root: string, id: string, at: string): void {
  const record = JSON.parse(readFileSync(registrationPath(root, id), "utf8")) as Registration;
  writeRegistration(root, { ...record, retiredAt: at });
}
export async function registerSession(root: string, input: Pick<Registration, "id" | "pid" | "cwd">, ctx: LanesCtx): Promise<void> {
  if (!validId(input.id)) throw new UsageError("invalid registration id");
  const existing = readRegistrations(root).values.find(record => record.id === input.id);
  if (existing && await sameLiveOwner(existing, input, ctx)) return;
  writeRegistration(root, { ...input, startedAt: ctx.now().toISOString() });
}
async function sameLiveOwner(existing: Registration, input: Pick<Registration, "id" | "pid">, ctx: LanesCtx): Promise<boolean> {
  const [checked] = checkRegistrations([existing], await runningPiChecked(ctx), ctx);
  if (!checked.alive) return false;
  if (existing.pid !== input.pid) throw new Error(`${input.id} already registered to pid ${existing.pid} (${existing.cwd})`);
  return true;
}
export function unregisterSession(root: string, id: string, ctx: LanesCtx): void {
  if (!validId(id)) throw new UsageError("invalid registration id");
  let record: Registration;
  try { record = JSON.parse(readFileSync(registrationPath(root, id), "utf8")); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${id} not registered`);
    throw e;
  }
  if (!record.retiredAt) retireRegistration(root, id, ctx.now().toISOString());
}
function parseableAt(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validRegistration(value: any): boolean {
  if (!value || typeof value.id !== "string" || typeof value.cwd !== "string") return false;
  if (!Number.isInteger(value.pid) || value.pid <= 0 || !parseableAt(value.startedAt)) return false;
  return value.retiredAt === undefined || parseableAt(value.retiredAt);
}
export function registrationCutoff(c: Config, now: Date): number {
  return now.getTime() - (c.messages.retention?.maxAgeDays ?? 14) * 86400000;
}
function expiredRegistration(record: Registration, cutoff: number): boolean {
  return record.retiredAt !== undefined && Date.parse(record.retiredAt) < cutoff;
}
export function readRegistrations(root: string, cutoff = -Infinity): ReturnType<typeof readJsonDir<Registration>> {
  const result = readJsonDir<Registration>(registrationDir(root), validRegistration);
  result.values = result.values.filter(record => !expiredRegistration(record, cutoff));
  result.source.count = result.values.length;
  return result;
}
function registrationFiles(root: string): string[] {
  try {
    for (const dir of [join(root, ".state"), registrationDir(root)]) {
      const info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`not a regular directory: ${dir}`);
    }
    return readdirSync(registrationDir(root)).filter(name => !name.startsWith(".") && name.endsWith(".json")).map(name => join(registrationDir(root), name));
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
function expiredRegistrationFile(path: string, cutoff: number): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    const record = JSON.parse(readFileSync(path, "utf8"));
    return validRegistration(record) && expiredRegistration(record, cutoff);
  } catch { return false; } // Invalid or unreadable records are not safe to delete.
}
export function pruneRegistrations(root: string, cutoff: number, dryRun = false): void {
  for (const path of registrationFiles(root)) if (expiredRegistrationFile(path, cutoff) && !dryRun) unlinkSync(path);
}
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
export function checkRegistrations(records: Registration[], processes: RosterInputs["processes"], ctx: LanesCtx): CheckedRegistration[] {
  const cwds = new Set(processes.procs.map(p => p.cwd));
  return records.map(record => {
    let cwd = record.cwd; try { cwd = ctx.realpath(cwd); } catch { /* retain the recorded path */ }
    const alive = !record.retiredAt && (ctx.pidAlive ?? pidAlive)(record.pid) && (cwds.has(cwd) || !processes.ok);
    return { ...record, cwd, alive: Boolean(alive) };
  });
}
export async function registrationParents(records: CheckedRegistration[], ctx: LanesCtx): Promise<Map<number, number>> {
  const parents = new Map<number, number>();
  if (!records.some(record => record.alive)) return parents;
  try {
    const result = await ctx.run("ps", ["-A", "-o", "pid=,ppid="], { timeoutMs: 10000 });
    if (result.code !== 0 || result.timedOut) return parents;
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (match) parents.set(Number(match[1]), Number(match[2]));
    }
  } catch { /* Missing ancestry permits only an unambiguous cwd fallback. */ }
  return parents;
}
function descendsFrom(row: RosterRow, record: CheckedRegistration, parents: Map<number, number>): boolean {
  const visited = new Set<number>(); let pid = row.pid;
  for (let hops = 0; hops < 64 && pid !== null; hops++) {
    if (visited.has(pid)) return false;
    visited.add(pid);
    const parent = parents.get(pid);
    if (parent === record.pid) return true;
    pid = parent ?? null;
  }
  return false;
}
function onlyRow(rows: RosterRow[]): RosterRow | undefined { return rows.length === 1 ? rows[0] : undefined; }
function attachRegistration(rows: RosterRow[], record: CheckedRegistration, processRow: RosterRow): void {
  const target = rows.find(row => row !== processRow && row.lane === record.id);
  if (target) {
    target.pid = processRow.pid; target.evidence.push(...processRow.evidence);
    rows.splice(rows.indexOf(processRow), 1);
    return;
  }
  processRow.lane = record.id;
  if (processRow.identity === "unregistered") processRow.identity = "launched";
  processRow.notes = processRow.notes.filter(note => note !== "identity unavailable: unregistered");
}
interface RegistrationMatches { rows: RosterRow[]; claimed: Set<number>; attached: Set<CheckedRegistration> }
type ProcessSelector = (available: RosterRow[], record: CheckedRegistration) => RosterRow | undefined;
function availableProcesses(matches: RegistrationMatches): RosterRow[] {
  return matches.rows.filter(row => row.pid !== null && !matches.claimed.has(row.pid));
}
function claimRegistrations(matches: RegistrationMatches, records: CheckedRegistration[], select: ProcessSelector): void {
  for (const record of records) {
    if (!record.alive || matches.attached.has(record)) continue;
    const processRow = select(availableProcesses(matches), record);
    if (!processRow) continue;
    matches.claimed.add(processRow.pid!); matches.attached.add(record);
    attachRegistration(matches.rows, record, processRow);
  }
}
function registrationRow(matches: RegistrationMatches, record: CheckedRegistration, empty: (id: string) => RosterRow): void {
  let row = matches.rows.find(row => row.lane === record.id);
  if (!row) { row = { ...empty(record.id), worktree: record.cwd }; matches.rows.push(row); }
  if (!record.alive || matches.attached.has(record)) return;
  if (availableProcesses(matches).filter(process => process.worktree === record.cwd).length > 1) row.notes.push("ambiguous cwd");
}
export function launchedRows(rows: RosterRow[], input: RosterInputs, empty: (id: string) => RosterRow): Set<number> {
  const registrations = input.registrations ?? [];
  const matches: RegistrationMatches = { rows, claimed: new Set(), attached: new Set() };
  const parents = input.registrationParents ?? new Map<number, number>();
  const piPids = new Set(rows.map(row => row.pid));
  const wrappers = registrations.filter(record => !piPids.has(record.pid));
  // Reserve exact owners and descendants before any registration can fall back to cwd.
  claimRegistrations(matches, registrations, (available, record) => available.find(row => row.pid === record.pid));
  claimRegistrations(matches, wrappers, (available, record) => onlyRow(available.filter(row => descendsFrom(row, record, parents))));
  claimRegistrations(matches, wrappers, (available, record) => onlyRow(available.filter(row => row.worktree === record.cwd)));
  for (const record of registrations) registrationRow(matches, record, empty);
  return matches.claimed;
}
/** Add identity and exit evidence without treating a wrapper PID as a Pi PID. */
export function joinRegistration(row: RosterRow, input: RosterInputs): void {
  const record = input.registrations?.find(r => r.id === row.lane); if (!record) return;
  row.worktree ??= record.cwd;
  if (record.alive) row.evidence.push("registration");
  else row.notes.push(record.retiredAt ? `session ended ${record.retiredAt}` : "registration stale (no exit recorded)");
}
export function registrationState(row: RosterRow, input: RosterInputs): string | undefined {
  if (row.pid !== null || row.evidence.includes("lease") || row.evidence.includes("heartbeat(fresh)")) return undefined;
  const record = input.registrations?.find(r => r.id === row.lane); if (!record || record.alive) return undefined;
  return record.retiredAt && !input.lanes.some(l => l.id === row.lane) ? "retired" : "stopped";
}
