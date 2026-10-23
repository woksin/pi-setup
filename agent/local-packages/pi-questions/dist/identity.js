/** Who is asking: repo, lane, session liveness, and the user's name. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { userInfo, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mappedLane } from "./lanes.js";
export { LANE_NAME_RE } from "./lanes.js";
import { pidAlive, agentDir, readSessions, resolveHome } from "./store.js";

/** Owner/Name from an ssh, scp-style or https remote URL; null if it has no such path. */
export function parseRemote(url        )                {
	let path = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
	const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.*)$/i.exec(path);
	if (scheme) path = scheme[1];
	else {
		const scp = /^[^/\s]*:(?!\/\/)(.*)$/.exec(path);
		if (scp) path = scp[1];
	}
	const parts = path.split("/").filter(Boolean);
	return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : null;
}

const repoCache = new Map                       ();

function git(cwd        , args          )         {
	return execFileSync("git", args, { cwd, timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Owner/Name of the origin remote; else the basename of the common dir's parent; null on any failure. */
export function repoOf(cwd        )                {
	if (repoCache.has(cwd)) return repoCache.get(cwd) ;
	let repo                = null;
	try {
		let parsed                = null;
		try {
			parsed = parseRemote(git(cwd, ["remote", "get-url", "origin"]));
		} catch {
			// No origin remote: use the directory name below.
		}
		if (parsed) repo = parsed;
		else {
			const common = resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]));
			repo = basename(dirname(common)) || null;
		}
	} catch {
		repo = null;
	}
	repoCache.set(cwd, repo);
	return repo;
}

function ttyOfPid(pid        )                     {
	try {
		const tty = execFileSync("ps", ["-p", String(pid), "-o", "tty="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return tty && tty !== "?" && tty !== "??" ? tty : undefined;
	} catch {
		return undefined;
	}
}

                                                   
                                                 

function selectorMatches(s                 , selector              , ttyOf       )          {
	if (selector.pid !== undefined) return s.pid === selector.pid;
	const tty = selector.tty?.replace(/^\/dev\//, "");
	return !!tty && ttyOf(s.pid) === tty;
}

/** Resolve a running session through its heartbeat; never guess between several matches. */
export function resolveLaneSession(
	home        , selector              , ttyOf        = ttyOfPid,
)         {
	const matches = readSessions(home).filter(s => liveness(s, s.mtimeMs, Date.now()))
		.filter(s => selectorMatches(s, selector, ttyOf));
	const ids = [...new Set(matches.map(s => s.sessionId))];
	const label = selector.pid !== undefined ? `pid ${selector.pid}` : `tty ${selector.tty}`;
	if (!ids.length) throw new Error(`no live session matches ${label}`);
	if (ids.length > 1) throw new Error(`multiple live sessions match ${label}: ${ids.join(", ")}; use --session`);
	return ids[0];
}

export function orchHome(env                                     = process.env)         {
	return env.ORCH_HOME || join(homedir(), ".pi", "orch");
}

/** Lane id: PI_ORCH_ID, the session map, the pi-orch heartbeat, then the session name. */
export function laneOf(
	env                                    , sessionId        , sessionName                    , orch = orchHome(env), home = resolveHome(env),
)                     {
	if (env.PI_ORCH_ID) return env.PI_ORCH_ID;
	const mapped = mappedLane(home, sessionId);
	if (mapped) return mapped.lane;
	try {
		const dir = join(orch, "heartbeats");
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			try {
				const hb = JSON.parse(readFileSync(join(dir, f), "utf8"));
				if (hb.sessionId === sessionId && typeof hb.id === "string" && !hb.id.startsWith("S-")) return hb.id;
			} catch {
				// Unreadable heartbeat: skip.
			}
		}
	} catch {
		// No pi-orch here.
	}
	return sessionName && /^[A-Z][A-Z0-9-]*[a-z]?$/.test(sessionName) ? sessionName : undefined;
}

export const LIVE_MS = 120_000;

/** Live: the pid is alive and the heartbeat file was refreshed less than 120 s ago. */
export function liveness(hb                 , mtimeMs        , now        , alive                           = pidAlive)          {
	return alive(hb.pid) && now - mtimeMs < LIVE_MS;
}

/** The answering user's name: githubUser from <agent dir>/user.json, else the OS user. */
export function userName(env                                     = process.env)         {
	try {
		const u = JSON.parse(readFileSync(join(agentDir(env), "user.json"), "utf8"));
		if (typeof u.githubUser === "string" && u.githubUser.trim()) return u.githubUser.trim();
	} catch {
		// No user.json.
	}
	try {
		return userInfo().username;
	} catch {
		return env.USER || env.USERNAME || "user";
	}
}


/** CLI equivalent of getSessionName(): latest session_info, including explicit clears.
 * Only the explicit file or this cwd's session directory is consulted. */
export function cliSession(env                                    , cwd        , agentDirectory        )                                        {
	const sessionId = env.PI_SESSION_ID;
	let file = env.PI_SESSION_FILE;
	if (!file && sessionId) {
		const encoded = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const directory = join(agentDirectory, "sessions", encoded);
		try { file = readdirSync(directory).sort().reverse().filter(f => f.endsWith(`_${sessionId}.jsonl`)).map(f => join(directory, f))[0]; } catch { /* unavailable */ }
	}
	if (!file) return { sessionId };
	try {
		let id                    , name                    ;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session" && typeof entry.id === "string") id = entry.id;
				if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name || undefined;
			} catch { /* a truncated final entry must not hide the last valid name */ }
		}
		if (sessionId && id && sessionId !== id) return { sessionId };
		return { sessionId: sessionId || id, name };
	} catch { return { sessionId }; }
}
