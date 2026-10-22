/**
 * File store, lock-free. An item is a directory `items/Q-<n>/` of immutable revision files
 * `r<rev, zero-padded>.json`. A writer reads the highest valid revision, applies its change and
 * links the next revision into place with link() (temp file + link, so a file is never partial).
 * link() fails with EEXIST if someone else got there first; the writer then re-reads and retries,
 * bounded by an attempt count and a deadline checked on every iteration. The current state is the
 * highest valid revision. There are no locks, so nothing can be left stale or taken over.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync,
	renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ID_RE, idNumber, validateItem,           } from "./model.js";

export function agentDir(env                                     = process.env)         {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** PI_QUESTIONS_HOME, else <agent dir>/user-questions. Used by the extension and the CLI alike. */
export function resolveHome(env                                     = process.env)         {
	return env.PI_QUESTIONS_HOME || join(agentDir(env), "user-questions");
}

export function pidAlive(pid         )          {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e     ) {
		return e.code === "EPERM";
	}
}

export function readJson   (file        )    {
	return JSON.parse(readFileSync(file, "utf8"))     ;
}

export const sleepMs = (ms        ) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Temp file in the same directory, fsync, then rename (or link, which fails if the target exists). */
export function atomicWrite(file        , value         , immutable = false)          {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (immutable) {
			try {
				linkSync(tmp, file);
			} catch (e     ) {
				if (e.code === "EEXIST") return false;
				throw e;
			}
		} else {
			renameSync(tmp, file);
		}
		return true;
	} finally {
		if (existsSync(tmp)) unlinkSync(tmp);
	}
}

export const itemsDir = (home        ) => join(home, "items");
export const itemDir = (home        , id        ) => join(itemsDir(home), id);
const revName = (rev        ) => `r${String(rev).padStart(8, "0")}.json`;
const REV_RE = /^r(\d+)\.json$/;

export const WRITE_TIMEOUT_MS = 5_000;
export const WRITE_MAX_ATTEMPTS = 200;

function itemDirIds(home        )           {
	try {
		return readdirSync(itemsDir(home), { withFileTypes: true })
			.filter(d => d.isDirectory() && ID_RE.test(d.name))
			.map(d => d.name);
	} catch (e     ) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}

/** Revision numbers present in an item directory, highest first (any file name that looks like a revision). */
function revisions(home        , id        )           {
	try {
		return readdirSync(itemDir(home, id))
			.map(f => REV_RE.exec(f)?.[1])
			.filter((x)              => !!x)
			.map(Number)
			.sort((a, b) => b - a);
	} catch (e     ) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}

/**
 * The latest revision. Only ENOENT (a race, or a file that is not there) may be skipped. Any other read
 * error, and a latest revision that is complete but does not parse, is an error: falling back to an older
 * revision would silently drop committed history. An item directory with no revisions is pending (its
 * creator has claimed the id but not yet published), which is not an error.
 */
function readLatest(home        , id        )                                     {
	const revs = revisions(home, id);
	for (const rev of revs) {
		const file = join(itemDir(home, id), revName(rev));
		let raw        ;
		try {
			raw = readFileSync(file, "utf8");
		} catch (e     ) {
			if (e.code === "ENOENT") continue;
			throw new Error(`Cannot read ${id} revision ${rev} (${e.code ?? e.message}). Nothing was written; fix the file or its permissions.`);
		}
		let item      ;
		try {
			item = JSON.parse(raw);
			if (item?.id !== id || !Array.isArray(item.history)) throw new Error("not an item");
		} catch (e     ) {
			throw new Error(`${id} is corrupt: its latest revision ${revName(rev)} does not parse (${e.message}). Refusing to use or change it; repair or remove that file.`);
		}
		return { item, top: revs[0] };
	}
	return { item: null, top: revs[0] ?? 0 };
}

export function readItem(home        , id        )              {
	if (!ID_RE.test(id)) throw new Error(`invalid item id: ${id}`);
	return readLatest(home, id).item;
}

/** Every readable item, by number. Unreadable or corrupt ones are left out and reported; pending ones are skipped. */
export function listItems(home        )                                        {
	const items         = [];
	const warnings           = [];
	for (const id of itemDirIds(home).sort((a, b) => idNumber(a) - idNumber(b))) {
		try {
			const { item } = readLatest(home, id);
			if (item) items.push(item);
		} catch (e     ) {
			warnings.push(`skipped ${id}: ${e.message}`);
		}
	}
	return { items, warnings };
}

                                                                          

                              
	                                                                     
	                          
	                                                                          
	                        
	                                                            
	                               
	                   
	                     
 

/**
 * Check for duplicates (`prepare`), claim the next id by mkdir (EEXIST means someone else has it, so look
 * again and take the next free number) and publish revision 1. Bounded by attempts and a deadline checked on
 * every iteration. Two creators racing past the duplicate check both succeed; readers mark them as possible duplicates.
 */
export function createItem   (
	home        , prepare                                   , hooks              = {},
)                                  {
	const prepared = prepare(listItems(home).items);
	if ("refuse" in prepared) return { refused: prepared.refuse };
	hooks.afterPrepare?.();
	mkdirSync(itemsDir(home), { recursive: true });
	const claim = hooks.mkdir ?? ((path        ) => mkdirSync(path));
	const deadline = Date.now() + (hooks.timeoutMs ?? WRITE_TIMEOUT_MS);
	const maxAttempts = hooks.maxAttempts ?? WRITE_MAX_ATTEMPTS;
	let n = Math.max(0, ...itemDirIds(home).map(idNumber)) + 1;
	for (let attempt = 1; ; attempt++) {
		if (attempt > maxAttempts || Date.now() >= deadline) {
			throw new Error(`Could not allocate an item id: ${attempt - 1} attempts all collided with other creators. Try again.`);
		}
		const id = `Q-${n}`;
		try {
			claim(itemDir(home, id));
		} catch (e     ) {
			if (e.code !== "EEXIST") throw e;
			n = Math.max(n + 1, ...itemDirIds(home).map(idNumber).map(x => x + 1));
			continue;
		}
		hooks.afterClaim?.();
		const item = prepared.build(id);
		validateItem(item);
		item.rev = 1;
		atomicWrite(join(itemDir(home, id), revName(1)), item, true);
		return { item };
	}
}

/**
 * Compare-and-swap update: read the latest revision, let `fn` change a fresh copy, link revision+1.
 * On a lost race re-read and run `fn` again (so `fn` must be repeatable). Bounded by attempts and a
 * deadline checked every iteration; errors other than the lost race propagate at once.
 */
export function mutateItem(
	home        , id        , fn                      , at = new Date(),
	limits                                               = {},
)       {
	if (!ID_RE.test(id)) throw new Error(`invalid item id: ${id}`);
	const deadline = Date.now() + (limits.timeoutMs ?? WRITE_TIMEOUT_MS);
	const maxAttempts = limits.maxAttempts ?? WRITE_MAX_ATTEMPTS;
	for (let attempt = 1; ; attempt++) {
		if (attempt > maxAttempts || Date.now() >= deadline) {
			throw new Error(`Could not update ${id}: other writers kept changing it (${attempt - 1} attempts). Try again.`);
		}
		const { item: current, top } = readLatest(home, id); // throws on unreadable or corrupt: nothing is written
		if (!current) throw new Error(`${id} does not exist`);
		const next       = structuredClone(current);
		fn(next);
		validateItem(next);
		next.rev = top + 1;
		next.updatedAt = at.toISOString();
		if (atomicWrite(join(itemDir(home, id), revName(next.rev)), next, true)) return next;
		sleepMs(1 + Math.floor(Math.random() * Math.min(20, attempt)));
	}
}

// Receipts: immutable delivery claims. The first link() wins.

const safe = (s        ) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
export const receiptName = (id        , seq        , recipient        ) => `${id}.${seq}.${safe(recipient)}.json`;
const receiptFile = (home        , name        ) => join(home, "receipts", name);

export function claimReceipt(home        , id        , seq        , recipient        , by        )          {
	return atomicWrite(receiptFile(home, receiptName(id, seq, recipient)), { id, seq, recipient, by, at: new Date().toISOString() }, true);
}

export function removeReceipt(home        , id        , seq        , recipient        )       {
	try {
		unlinkSync(receiptFile(home, receiptName(id, seq, recipient)));
	} catch {
		// Already gone.
	}
}

export function receiptNames(home        )              {
	try {
		return new Set(readdirSync(join(home, "receipts")));
	} catch {
		return new Set();
	}
}

// Session heartbeats.

                                                                                                                          
                                                                    

const sessionFile = (home        , sessionId        ) => join(home, "sessions", `${safe(sessionId)}.json`);

export function writeHeartbeat(home        , hb           )       {
	atomicWrite(sessionFile(home, hb.sessionId), hb);
}

export function removeHeartbeat(home        , sessionId        )       {
	try {
		unlinkSync(sessionFile(home, sessionId));
	} catch {
		// Already gone.
	}
}

export function readSessions(home        )                  {
	const dir = join(home, "sessions");
	const out                  = [];
	let names           = [];
	try {
		names = readdirSync(dir).filter(f => f.endsWith(".json"));
	} catch {
		return out;
	}
	for (const f of names) {
		try {
			out.push({ ...readJson           (join(dir, f)), mtimeMs: statSync(join(dir, f)).mtimeMs });
		} catch {
			// Half-written or removed: not live.
		}
	}
	return out;
}
