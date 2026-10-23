/**
 * guards — shared opt-out switches for deterministic extension enforcement.
 * Includes subagent-results so duplicate-result prevention has the same user
 * control as the existing guards; merely registering a name changes no settings.
 * session > persisted file > env > on. A corrupt file makes every guard on, and the env is ignored.
 * Explicit session overrides still apply; a missing file permits PI_GUARDS_OFF opt-outs.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const GUARD_NAMES = ["cratis", "mcp", "wait", "subagent-results", "context", "lane-policy", "secrets", "dotnet", "trains"] as const;
export type GuardName = (typeof GUARD_NAMES)[number];
type Values = Partial<Record<GuardName, boolean>>;
export interface GuardMeta { at?: string; reason?: string }
export interface GuardStatus {
	name: GuardName;
	off: boolean;
	source: "session" | "persisted" | "env" | "default";
}
interface State {
	session: Values;
	env: Values;
	warned: boolean;
}
const STATE_KEY = Symbol.for("pi.guards");

function namesOf(names: string | readonly string[]): GuardName[] {
	const supplied = typeof names === "string" ? names.split(",").map(name => name.trim()) : names;
	for (const name of supplied) {
		if (name !== "all" && !GUARD_NAMES.includes(name as GuardName)) {
			throw new Error(`Unknown guard '${name}'. Expected ${GUARD_NAMES.join(", ")} or all.`);
		}
	}
	return supplied.includes("all") ? [...GUARD_NAMES] : [...new Set(supplied)] as GuardName[];
}

function warn(state: State, message: string): void {
	if (state.warned) return;
	state.warned = true;
	console.warn(`guards: ${message}`);
}

function state(): State {
	const shared = globalThis as typeof globalThis & { [STATE_KEY]?: State };
	if (!shared[STATE_KEY]) {
		const initial: State = { session: {}, env: {}, warned: false };
		shared[STATE_KEY] = initial;
		if (process.env.PI_GUARDS_OFF?.trim()) {
			try {
				for (const name of namesOf(process.env.PI_GUARDS_OFF)) initial.env[name] = true;
			} catch (error) {
				warn(initial, `${(error as Error).message} Ignoring PI_GUARDS_OFF; guards default to on.`);
			}
		}
	}
	return shared[STATE_KEY];
}

function filePath(): string {
	return process.env.PI_GUARDS_FILE || join(homedir(), ".pi", "agent", "guards.json");
}

// Read each time so persisted changes are visible in other pi processes without reload.
function persisted(shared: State): { values: Values; corrupt: boolean } {
	const file = filePath();
	try {
		const data = JSON.parse(readFileSync(file, "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data) ||
			Object.keys(data).some(key => key !== "off") || !data.off ||
			typeof data.off !== "object" || Array.isArray(data.off)) throw new Error("expected { off: { guard: boolean } }");
		for (const [name, off] of Object.entries(data.off)) {
			if (!GUARD_NAMES.includes(name as GuardName) || typeof off !== "boolean") {
				throw new Error(`invalid guard setting '${name}'`);
			}
		}
		return { values: data.off, corrupt: false };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			warn(shared, `No ${file}; guards default to on unless explicitly overridden.`);
			return { values: {}, corrupt: false };
		}
		warn(shared, `Cannot read ${file}: ${(error as Error).message}. Guards default to on (session overrides still apply).`);
		return { values: {}, corrupt: true };
	}
}

export function guardStatus(): GuardStatus[] {
	const shared = state();
	const stored = persisted(shared);
	return GUARD_NAMES.map(name => {
		if (shared.session[name] !== undefined) return { name, off: shared.session[name], source: "session" };
		if (stored.values[name] !== undefined) return { name, off: stored.values[name], source: "persisted" };
		// A corrupt file fails safe, including when the environment would otherwise disable a guard.
		if (!stored.corrupt && shared.env[name] !== undefined) return { name, off: shared.env[name], source: "env" };
		return { name, off: false, source: "default" };
	});
}

type MetaMap = Partial<Record<GuardName, GuardMeta>>;

/** Sidecar next to the guards file (guards.json -> guards.meta.json) so guards.json stays readable by older readers. */
function metaPath(): string {
	const file = filePath();
	return file.endsWith(".json") ? `${file.slice(0, -5)}.meta.json` : `${file}.meta`;
}

/** Informational only: a missing or corrupt sidecar yields {} and never affects guard state. */
function readMeta(): MetaMap {
	const meta: MetaMap = {};
	try {
		const data = JSON.parse(readFileSync(metaPath(), "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) return meta;
		for (const [name, entry] of Object.entries(data as Record<string, any>)) {
			if (!GUARD_NAMES.includes(name as GuardName) || !entry || typeof entry !== "object") continue;
			meta[name as GuardName] = {
				...(typeof entry.at === "string" ? { at: entry.at } : {}),
				...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
			};
		}
	} catch { /* missing or corrupt: date unknown */ }
	return meta;
}

export interface PersistedOff extends GuardMeta { name: GuardName }

/** Guards that are effectively off because of the persisted file, with the recorded date/reason when known. */
export function persistedOffGuards(): PersistedOff[] {
	const meta = readMeta();
	return guardStatus().filter(entry => entry.off && entry.source === "persisted")
		.map(entry => ({ name: entry.name, ...meta[entry.name] }));
}

function since(at: string | undefined): string {
	const date = at ? new Date(at) : undefined;
	return date && !Number.isNaN(date.getTime()) ? `since ${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "date unknown";
}

const REASON_MAX = 40;
/** Short note such as "since 10-13, reason" or "date unknown" for a persisted-off guard. */
export function persistedNote(entry: GuardMeta): string {
	const reason = entry.reason?.replace(/\s+/g, " ").trim();
	const shown = reason && reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason;
	return shown ? `${since(entry.at)}, ${shown}` : since(entry.at);
}

/** Footer text for persisted-off guards only (with date/reason), or undefined when none remain. */
export function guardsStatusText(): string | undefined {
	const off = persistedOffGuards();
	return off.length ? `guards off: ${off.map(entry => `${entry.name} (${persistedNote(entry)})`).join(", ")}` : undefined;
}

export function isGuardOff(name: GuardName): boolean {
	namesOf([name]);
	return guardStatus().find(entry => entry.name === name)!.off;
}

const LOCK_WAIT_MS = 1000;
const LOCK_STALE_MS = 3000;
const LOCK_RETRY_MS = 20;
const lockSleep = new Int32Array(new SharedArrayBuffer(4));

function withPersistenceLock(file: string, write: () => void): void {
	const lock = `${file}.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		if (Date.now() >= deadline) throw new Error(`Cannot acquire guards persistence lock ${lock} within ${LOCK_WAIT_MS}ms; try again.`);
		let descriptor: number | undefined;
		try {
			descriptor = openSync(lock, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new Error(`Cannot acquire guards persistence lock ${lock}: ${(error as Error).message}`);
			}
		}
		if (descriptor !== undefined) {
			const owned = fstatSync(descriptor);
			try {
				writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
				write();
				return;
			} finally {
				closeSync(descriptor);
				try {
					const current = statSync(lock);
					if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lock);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		}
		try {
			const observed = statSync(lock);
			if (Date.now() - observed.mtimeMs > LOCK_STALE_MS) {
				let pid: number | undefined;
				try { pid = JSON.parse(readFileSync(lock, "utf8")).pid; } catch (error) {
					if (!(error instanceof SyntaxError)) throw error;
					// An incomplete abandoned lock has no owner metadata.
				}
				let alive = false;
				if (Number.isInteger(pid) && pid! > 0) {
					try { process.kill(pid!, 0); alive = true; } catch (error) {
						// Only ESRCH proves that the owner is gone; permission errors are not stale.
						alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
					}
				}
				if (!alive) {
					const current = statSync(lock);
					if (current.dev === observed.dev && current.ino === observed.ino && current.mtimeMs === observed.mtimeMs) {
						unlinkSync(lock);
						continue;
					}
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error(`Cannot acquire guards persistence lock ${lock}: ${(error as Error).message}`);
		}
		if (Date.now() >= deadline) throw new Error(`Cannot acquire guards persistence lock ${lock} within ${LOCK_WAIT_MS}ms; try again.`);
		Atomics.wait(lockSleep, 0, 0, Math.min(LOCK_RETRY_MS, deadline - Date.now()));
	}
}

// Best effort: losing metadata only means "date unknown", so it must not fail the guard change.
function writeMeta(values: Record<GuardName, boolean>, selected: GuardName[], off: boolean, reason: string | undefined): void {
	const target = metaPath();
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		const meta: MetaMap = {};
		for (const [name, entry] of Object.entries(readMeta())) if (values[name as GuardName]) meta[name as GuardName] = entry;
		const at = new Date().toISOString();
		for (const name of selected) {
			if (off) meta[name] = { at, ...(reason?.trim() ? { reason: reason.trim() } : {}) };
			else delete meta[name];
		}
		writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} catch (error) {
		warn(state(), `Cannot write ${target}: ${(error as Error).message}. Date/reason will show as unknown.`);
	} finally {
		try { unlinkSync(temporary); } catch { /* nothing to clean */ }
	}
}

/** Persistent changes replace the selected process overrides; other process overrides remain. */
export function setGuards(names: string | readonly string[], off: boolean, { persist = false, reason }: { persist?: boolean; reason?: string } = {}): void {
	const selected = namesOf(names);
	if (typeof off !== "boolean") throw new Error("Guard off must be a boolean.");
	if (reason !== undefined && (!persist || !off)) throw new Error("A reason is only recorded with off --persist.");
	const shared = state();
	if (!persist) {
		for (const name of selected) shared.session[name] = off;
		return;
	}
	const file = filePath();
	mkdirSync(dirname(file), { recursive: true });
	withPersistenceLock(file, () => {
		// Never inherit env/session opt-outs when repairing or completing a persisted file.
		const stored = persisted(shared).values;
		const values = Object.fromEntries(GUARD_NAMES.map(name => [name, stored[name] ?? false])) as Record<GuardName, boolean>;
		for (const name of selected) values[name] = off;
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ off: values }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			renameSync(temporary, file);
			writeMeta(values, selected, off, reason);
		} finally {
			try { unlinkSync(temporary); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	});
	for (const name of selected) delete shared.session[name];
}
