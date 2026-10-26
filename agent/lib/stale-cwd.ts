/**
 * stale-cwd — detect a pi process whose working directory went stale (process.cwd() throws ENOENT) and say how to recover.
 * `/reload` does not change a process's cwd; the process has to be restarted from the directory. Pure; never throws.
 */
import { existsSync } from "node:fs";

export type CwdProbe = { state: "ok"; cwd: string } | { state: "stale"; sessionCwd: string | undefined; sessionCwdExists: boolean };

export interface ProbeOptions { cwd?: () => string; exists?: (path: string) => boolean; sessionCwd?: string }

/** `process.cwd()`, or `fallback` (default undefined) when it throws, e.g. ENOENT for a stale directory. */
export function safeCwd(fallback?: string): string | undefined {
	try { return process.cwd(); } catch { return fallback; }
}

/** Is the process cwd usable? "stale" when reading it throws; `sessionCwd` is the directory the session was meant to run in. */
export function probeCwd(options: ProbeOptions = {}): CwdProbe {
	try {
		return { state: "ok", cwd: (options.cwd ?? (() => process.cwd()))() };
	} catch {
		const sessionCwd = options.sessionCwd;
		let sessionCwdExists = false;
		try { sessionCwdExists = sessionCwd !== undefined && sessionCwd !== "" && (options.exists ?? existsSync)(sessionCwd); } catch { /* unknown: treat as missing */ }
		return { state: "stale", sessionCwd, sessionCwdExists };
	}
}

/** One line naming the cause and the recovery. */
export function recoveryText(sessionCwd: string | undefined, sessionCwdExists = true): string {
	const cause = "pi's working directory is stale (process.cwd() fails with ENOENT), so subagents and tools that read it will fail.";
	if (!sessionCwd) return `${cause} Exit pi and start it again from an existing directory (\`/reload\` does not fix it).`;
	if (!sessionCwdExists) return `${cause} The session directory ${sessionCwd} no longer exists: exit pi and start it from another directory (\`/reload\` does not fix it).`;
	return `${cause} Exit pi, then: cd ${sessionCwd} && pi -c (\`/reload\` does not fix it).`;
}
