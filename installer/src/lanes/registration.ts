import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LanesCtx } from "./ctx.ts";
import { UsageError, type Config } from "./config.ts";
import { runningPiChecked } from "./processes.ts";
import { validId } from "./names.ts";
import type { RegisterData } from "./issue-register.ts";
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
export async function registrationParents(records: CheckedRegistration[], ctx: LanesCtx): Promise<Map<number, number> | undefined> {
  if (!records.some(record => record.alive)) return undefined;
  try {
    const result = await ctx.run("ps", ["-A", "-o", "pid=,ppid="], { timeoutMs: 10000 });
    if (result.code !== 0 || result.timedOut) return undefined;
    const parents = new Map<number, number>();
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (match) parents.set(Number(match[1]), Number(match[2]));
    }
    return result.stdout.trim() && !parents.size ? undefined : parents;
  } catch { return undefined; }
}
interface PiProcess { pid: number; cwd: string }
interface IdentityAttribution {
  identity: string;
  source: "registration-pid" | "registration-descendant" | "orch" | "seed" | "registration-cwd" | "unregistered";
}
export interface ProcessAttribution extends IdentityAttribution {
  process: PiProcess; sessions: string[]; sessionId: string | null;
  heartbeat?: RosterInputs["heartbeats"][number]; orch?: RosterInputs["sessions"][number];
}
function verifiedLeasePid(lease: RegisterData["leases"][number], data: RegisterData): boolean {
  const live = data.liveness.get(lease.sessionId);
  return live?.status === "live" && live.pid === lease.pid;
}
export function verifiedPidSessions(pids: number[], data: RegisterData): string[] {
  return [...new Set(data.leases.filter(lease => verifiedLeasePid(lease, data) && pids.includes(lease.pid)).map(lease => lease.sessionId))];
}
export function livePiProcesses(procs: PiProcess[], register: RegisterData): PiProcess[] {
  const found = new Map(procs.map(process => [process.pid, process]));
  for (const lease of register.leases) {
    if (!verifiedLeasePid(lease, register) || found.has(lease.pid)) continue;
    found.set(lease.pid, { pid: lease.pid, cwd: lease.cwd ?? "" });
  }
  return [...found.values()];
}
function latestHeartbeat(process: PiProcess, input: RosterInputs): ProcessAttribution["heartbeat"] {
  return input.heartbeats.filter(heartbeat => heartbeat.pid === process.pid).sort((a, b) => b.at.localeCompare(a.at))[0];
}
interface AttributionBuild {
  input: RosterInputs; processes: PiProcess[]; records: CheckedRegistration[];
  identities: Map<number, IdentityAttribution>;
}
function attributeExactPids(build: AttributionBuild): void {
  for (const process of build.processes) {
    const record = build.records.find(record => record.pid === process.pid);
    if (record) build.identities.set(process.pid, { identity: record.id, source: "registration-pid" });
  }
}
function wrapperAncestor(process: PiProcess, wrappers: Map<number, CheckedRegistration>, parents: Map<number, number>): CheckedRegistration | undefined {
  const visited = new Set<number>(); let pid = process.pid;
  for (let hops = 0; hops < 64; hops++) {
    if (visited.has(pid)) return undefined;
    visited.add(pid);
    const parent = parents.get(pid); if (parent === undefined) return undefined;
    const record = wrappers.get(parent); if (record) return record;
    pid = parent;
  }
  return undefined;
}
function wrapperRecords(build: AttributionBuild): CheckedRegistration[] {
  const piPids = new Set(build.processes.map(process => process.pid));
  return build.records.filter(record => !piPids.has(record.pid));
}
function attributeDescendants(build: AttributionBuild): void {
  const parents = build.input.registrationParents; if (!parents) return;
  const wrappers = new Map(wrapperRecords(build).map(record => [record.pid, record]));
  for (const process of build.processes) {
    if (build.identities.has(process.pid)) continue;
    const record = wrapperAncestor(process, wrappers, parents);
    if (record) build.identities.set(process.pid, { identity: record.id, source: "registration-descendant" });
  }
}
function attributeOrch(build: AttributionBuild): void {
  for (const process of build.processes) {
    if (build.identities.has(process.pid)) continue;
    const session = build.input.sessions.find(session => session.pid === process.pid);
    const id = session?.id || latestHeartbeat(process, build.input)?.id;
    if (id) build.identities.set(process.pid, { identity: id, source: "orch" });
  }
}
function attributeSeeds(build: AttributionBuild): void {
  const used = new Set([...build.identities.values()].map(attribution => attribution.identity));
  for (const process of build.processes) {
    if (build.identities.has(process.pid)) continue;
    const seed = build.input.lanes.find(seed => seed.cwd && seed.cwd === process.cwd);
    if (!seed || used.has(seed.id)) continue;
    build.identities.set(process.pid, { identity: seed.id, source: "seed" }); used.add(seed.id);
  }
}
function attributeFallback(build: AttributionBuild): void {
  if (build.input.registrationParents !== undefined) return;
  for (const record of wrapperRecords(build)) {
    if ([...build.identities.values()].some(attribution => attribution.identity === record.id)) continue;
    const candidates = build.processes.filter(process => !build.identities.has(process.pid) && process.cwd === record.cwd);
    if (candidates.length !== 1) continue;
    build.identities.set(candidates[0].pid, { identity: record.id, source: "registration-cwd" });
  }
}
function processAttribution(process: PiProcess, build: AttributionBuild): ProcessAttribution {
  const attribution = build.identities.get(process.pid) ?? { identity: `unregistered-p${process.pid}`, source: "unregistered" as const };
  const sessions = verifiedPidSessions([process.pid], build.input.register);
  const orch = build.input.sessions.find(session => session.pid === process.pid); const heartbeat = latestHeartbeat(process, build.input);
  return { ...attribution, process, sessions, sessionId: sessions[0] || orch?.sessionId || heartbeat?.sessionId || null, orch, heartbeat };
}
/** The only process-to-identity join. Later stages cannot overwrite earlier attribution. */
export function attributeProcesses(input: RosterInputs): Map<number, ProcessAttribution> {
  const build: AttributionBuild = { input, processes: livePiProcesses(input.processes.procs, input.register),
    records: (input.registrations ?? []).filter(record => record.alive && !record.retiredAt), identities: new Map() };
  attributeExactPids(build);
  attributeDescendants(build);
  attributeOrch(build);
  attributeSeeds(build);
  attributeFallback(build);
  return new Map(build.processes.map(process => [process.pid, processAttribution(process, build)]));
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
