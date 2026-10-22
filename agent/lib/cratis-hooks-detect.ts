/**
 * cratis-hooks-detect — is a Cratis Pi hook active for a working directory?
 *
 * The Cratis AI corpus ships Pi hooks (`.cratis/ai/harnesses/pi/extensions/cratis-hooks`) that run
 * `.cratis/ai/hooks/scripts/cratis-guard-*.sh` on every Bash `tool_call`. Where a local guard covers the same
 * concern, it stands down for *blocking* so a command is refused once, with one message and one switch:
 *   - secrets          → cratis-guard-secrets.sh          (switch CRATIS_HOOKS_ALLOW_SECRET_READS=1)
 *   - store-mutations  → cratis-guard-store-mutations.sh  (switch CRATIS_HOOKS_ALLOW_STORE_MUTATIONS=1)
 * A concern counts as covered only when the repository root (nearest ancestor of the cwd holding `.git` or
 * `.cratis`) has both that script and the Cratis Pi extension directory. Pure filesystem reads; never throws.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CratisConcern = "secrets" | "store-mutations";

const SCRIPT: Record<CratisConcern, string> = {
	"secrets": "cratis-guard-secrets.sh",
	"store-mutations": "cratis-guard-store-mutations.sh",
};
const MUTATIONS_JSON = "cratis-store-mutations.json";

/** The nearest ancestor of `cwd` (inclusive) that holds `.git` or `.cratis`. */
export function repoRoot(cwd: string): string | undefined {
	if (typeof cwd !== "string" || cwd === "") return undefined; // a context without a cwd is not a Cratis repository
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".cratis"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function isFile(path: string): boolean {
	try { return statSync(path).isFile(); } catch { return false; }
}
function isDirectory(path: string): boolean {
	try { return statSync(path).isDirectory(); } catch { return false; }
}

/** The Cratis `scripts` directory of the repository around `cwd`, when its Pi extension is installed too. */
function scriptsDir(cwd: string): string | undefined {
	const root = repoRoot(cwd);
	if (!root) return undefined;
	const ai = join(root, ".cratis", "ai");
	return isDirectory(join(ai, "harnesses", "pi", "extensions", "cratis-hooks")) ? join(ai, "hooks", "scripts") : undefined;
}

/** True when the Cratis hook for `concern` is installed for the repository around `cwd`. */
export function cratisHookActive(cwd: string, concern: CratisConcern): boolean {
	const dir = scriptsDir(cwd);
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
export function cratisReadOnlyCommands(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] | undefined {
	const dir = scriptsDir(cwd);
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

/**
 * Would the Cratis secrets hook already block `command`? True only on its own verdict (exit 2, the code the
 * Cratis Pi extension treats as a block) or when the human switch CRATIS_HOOKS_ALLOW_SECRET_READS=1 is set
 * (one switch). A spawn error, timeout, or any other result is "no": the caller keeps blocking as it did before.
 * Spawning is synchronous, which is fine because callers only ask for commands they would block anyway.
 */
export function cratisSecretsStandsDown(cwd: string, command: string, env: NodeJS.ProcessEnv = process.env, run: CratisRunner = spawnRunner): boolean {
	if (!cratisHookActive(cwd, "secrets")) return false;
	if (cratisSwitchOn("secrets", env)) return true;
	const dir = scriptsDir(cwd);
	const root = repoRoot(cwd);
	if (dir === undefined || root === undefined) return false;
	try {
		const result = run(join(dir, SCRIPT.secrets), root, JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command } }), CRATIS_SCRIPT_TIMEOUT_MS);
		return !result.error && result.status === 2;
	} catch {
		return false;
	}
}
