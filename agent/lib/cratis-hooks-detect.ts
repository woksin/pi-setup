/**
 * cratis-hooks-detect — would the Cratis Pi hooks already refuse a command?
 *
 * Mirrors Cratis' `.cratis/ai/harnesses/pi/extensions/cratis-hooks/index.ts`, which on every Bash `tool_call` runs
 * `<process.cwd()>/.cratis/ai/hooks/scripts/cratis-guard-*.sh` (exit 2 = block) with cwd = the tool's cwd and the
 * payload `{cwd, tool_name:"Bash", tool_input:{command}}`. A managed Cratis setup makes Pi load that extension via
 * the project symlink `.pi/extensions -> ../.cratis/ai/harnesses/pi/extensions`. Where a local guard covers the same
 * concern it stands down for *blocking* only when the Cratis script itself says so, so the command is refused once:
 *   - secrets          → cratis-guard-secrets.sh          (switch CRATIS_HOOKS_ALLOW_SECRET_READS=1)
 *   - store-mutations  → cratis-guard-store-mutations.sh  (switch CRATIS_HOOKS_ALLOW_STORE_MUTATIONS=1)
 * File presence is only a pre-check. Everything unknown (extension not found under process.cwd(), scripts not in
 * process.cwd()'s `.cratis`, spawn error, timeout, exit 0 — e.g. the script's silent no-op when `jq` is missing) means
 * "Cratis does not block it", so the local guard keeps blocking. Packaged `@cratis/pi` installs (bundled corpus) cannot
 * be located from here and are treated the same way. Never throws.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type CratisConcern = "secrets" | "store-mutations";

const SCRIPT: Record<CratisConcern, string> = {
	"secrets": "cratis-guard-secrets.sh",
	"store-mutations": "cratis-guard-store-mutations.sh",
};
const MUTATIONS_JSON = "cratis-store-mutations.json";

function isFile(path: string): boolean {
	try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * The scripts directory the Cratis extension uses for this Pi process (`<base>/.cratis/ai/hooks/scripts`, base =
 * process.cwd()), provided the Cratis extension is loaded from the project (`<base>/.pi/extensions/cratis-hooks`).
 */
function scriptsDir(base: string): string | undefined {
	if (typeof base !== "string" || base === "") return undefined;
	if (!isFile(join(base, ".pi", "extensions", "cratis-hooks", "index.ts"))) return undefined;
	const dir = join(base, ".cratis", "ai", "hooks", "scripts");
	return existsSync(dir) ? dir : undefined;
}

/** True when the Cratis hook for `concern` appears installed and loaded for this Pi process (pre-check only). */
export function cratisHookActive(base: string, concern: CratisConcern): boolean {
	const dir = scriptsDir(base);
	return dir !== undefined && isFile(join(dir, SCRIPT[concern]));
}

/** The human-set Cratis switch that lets `concern` through (read from the harness environment only). */
export function cratisSwitchOn(concern: CratisConcern, env: NodeJS.ProcessEnv = process.env): boolean {
	return env[concern === "secrets" ? "CRATIS_HOOKS_ALLOW_SECRET_READS" : "CRATIS_HOOKS_ALLOW_STORE_MUTATIONS"] === "1";
}

/**
 * The read-only `chronicle` command paths of the Cratis list (`cratis-store-mutations.json`, or the file named by
 * CRATIS_HOOKS_STORE_MUTATIONS), lower-cased. Undefined when the hook is not active, or the file is missing or
 * not a usable list — the caller then keeps its own list.
 */
export function cratisReadOnlyCommands(env: NodeJS.ProcessEnv = process.env, base: string = process.cwd()): string[] | undefined {
	const dir = scriptsDir(base);
	if (dir === undefined || !isFile(join(dir, SCRIPT["store-mutations"]))) return undefined;
	try {
		const data: unknown = JSON.parse(readFileSync(env.CRATIS_HOOKS_STORE_MUTATIONS || join(dir, MUTATIONS_JSON), "utf8"));
		const list = data as { group?: unknown; readOnly?: unknown; mutating?: unknown };
		if (typeof data !== "object" || data === null || list.group !== "chronicle" || !Array.isArray(list.readOnly) || !Array.isArray(list.mutating)) return undefined;
		const paths = list.readOnly.map(entry => (entry as { command?: unknown } | null)?.command);
		if (paths.some(path => typeof path !== "string")) return undefined;
		return (paths as string[]).map(path => path.trim().toLowerCase().split(/\s+/).join(" ")).filter(Boolean);
	} catch {
		return undefined;
	}
}

export interface RunnerResult { status: number | null; error?: unknown }
/** Runs a Cratis hook script synchronously with the Pi extension's payload on stdin. */
export type CratisRunner = (script: string, cwd: string, stdin: string, timeoutMs: number) => RunnerResult;
export const spawnRunner: CratisRunner = (script, cwd, stdin, timeoutMs) => {
	const run = spawnSync("bash", [script], { cwd, input: stdin, timeout: timeoutMs, stdio: ["pipe", "ignore", "ignore"] });
	return { status: run.status, error: run.error };
};
export const CRATIS_SCRIPT_TIMEOUT_MS = 3000;

export type CratisVerdict = "blocked" | "switch" | "none";

/**
 * What the Cratis hook for `concern` does with `command`: "blocked" (the script exited 2, the code the Cratis Pi
 * extension treats as a block), "switch" (the human allow switch is set in the harness environment, so Cratis lets it
 * through), or "none" (not active, or anything else — the caller keeps its own blocking). The script is run exactly
 * as the Cratis extension runs it: from `base` (process.cwd()), with cwd = `cwd` and the same payload, 3 s timeout.
 * Spawning is synchronous, which is fine because callers only ask for commands they would block anyway.
 */
export function cratisVerdict(concern: CratisConcern, cwd: string | undefined, command: string, env: NodeJS.ProcessEnv = process.env, run: CratisRunner = spawnRunner, base: string = process.cwd()): CratisVerdict {
	if (!cratisHookActive(base, concern)) return "none";
	if (cratisSwitchOn(concern, env)) return "switch";
	const dir = scriptsDir(base);
	if (dir === undefined) return "none";
	try {
		const where = cwd || base;
		const result = run(join(dir, SCRIPT[concern]), where, JSON.stringify({ cwd: where, tool_name: "Bash", tool_input: { command } }), CRATIS_SCRIPT_TIMEOUT_MS);
		return !result.error && result.status === 2 ? "blocked" : "none";
	} catch {
		return "none";
	}
}
