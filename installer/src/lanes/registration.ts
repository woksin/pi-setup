import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LanesCtx } from "./ctx.ts";
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
function parseableAt(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validRegistration(value: any): boolean {
  if (!value || typeof value.id !== "string" || typeof value.cwd !== "string") return false;
  if (!Number.isInteger(value.pid) || value.pid <= 0 || !parseableAt(value.startedAt)) return false;
  return value.retiredAt === undefined || parseableAt(value.retiredAt);
}
export function readRegistrations(root: string): ReturnType<typeof readJsonDir<Registration>> {
  return readJsonDir<Registration>(registrationDir(root), validRegistration);
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
export function launchedRows(rows: RosterRow[], input: RosterInputs, empty: (id: string) => RosterRow): void {
  for (const record of input.registrations ?? []) {
    if (rows.some(r => r.lane === record.id)) continue;
    const detected = record.alive && rows.find(r => r.identity === "unregistered" && r.worktree === record.cwd);
    if (detected) {
      detected.lane = record.id; detected.identity = "launched";
      detected.notes = detected.notes.filter(note => note !== "identity unavailable: unregistered");
    }
    else rows.push({ ...empty(record.id), worktree: record.cwd });
  }
}
/** Add identity and exit evidence without treating a wrapper PID as a Pi PID. */
export function joinRegistration(row: RosterRow, input: RosterInputs): void {
  const record = input.registrations?.find(r => r.id === row.lane); if (!record) return;
  row.worktree ??= record.cwd;
  if (record.alive) row.evidence.push("registration");
  else row.notes.push(record.retiredAt ? `session ended ${record.retiredAt}` : "registration stale (no exit recorded)");
}
export function registrationState(row: RosterRow, input: RosterInputs): string | undefined {
  const record = input.registrations?.find(r => r.id === row.lane); if (!record || record.alive) return undefined;
  return record.retiredAt && !input.lanes.some(l => l.id === row.lane) ? "retired" : "stopped";
}
