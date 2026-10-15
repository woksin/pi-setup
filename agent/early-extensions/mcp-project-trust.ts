/**
 * mcp-project-trust — only use project MCP configs in folders you trust.
 *
 * pi-mcp-adapter reads project `.mcp.json` / `.pi/mcp.json` regardless of Pi's project
 * trust, and can start the commands they define at session start (missing metadata or
 * `lifecycle: eager`). This extension puts the adapter into its exclusive config mode —
 * only `~/.pi/agent/mcp.json` is read — unless the folder is trusted.
 *
 * Trusted means, mirroring Pi's own rule (docs/security.md): `--approve` / `-a` on the
 * command line, otherwise the closest saved decision for the folder or a parent in
 * ~/.pi/agent/trust.json is `true`, otherwise `defaultProjectTrust` is an allow value.
 * `--no-approve`, a saved `false`, or no decision ("ask") are untrusted.
 *
 * It must load before pi-mcp-adapter, which reads its config when it loads. Pi loads
 * packages before ~/.pi/agent/extensions, so this file is listed as a local package
 * FIRST in settings.json `packages` (not placed in extensions/).
 * An explicit PI_MCP_CONFIG_MODE in the environment is always respected.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const userSetMode = process.env.PI_MCP_CONFIG_MODE !== undefined;

function readJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function isFolderTrusted(cwd: string, argv: string[] = process.argv): boolean {
	if (argv.includes("--no-approve") || argv.includes("-na")) return false;
	if (argv.includes("--approve") || argv.includes("-a")) return true;

	const decisions: Record<string, boolean> = readJson(join(AGENT_DIR, "trust.json")) ?? {};
	let dir = canonical(cwd);
	while (true) {
		if (Object.hasOwn(decisions, dir)) return decisions[dir] === true;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	const fallback = readJson(join(AGENT_DIR, "settings.json"))?.defaultProjectTrust;
	return fallback === "trust" || fallback === "always" || fallback === "allow" || fallback === true;
}

function hasProjectMcpConfig(cwd: string): boolean {
	return existsSync(join(cwd, ".mcp.json")) || existsSync(join(cwd, ".pi", "mcp.json"));
}

function apply(cwd: string): boolean {
	if (userSetMode) return true;
	const trusted = isFolderTrusted(cwd);
	if (trusted) delete process.env.PI_MCP_CONFIG_MODE;
	else process.env.PI_MCP_CONFIG_MODE = "exclusive";
	return trusted;
}

// Decide at load time, before pi-mcp-adapter loads and reads its config.
apply(process.cwd());

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Re-evaluate for the session's folder (resume/switch can change it); this handler
		// runs before the adapter's own session_start because this package loads first.
		// Deliberately not ctx.isProjectTrusted(): it reports true for folders without
		// Pi-protected files, which is exactly the case of a bare .mcp.json.
		const trusted = apply(ctx.cwd);
		if (!trusted && ctx.hasUI && hasProjectMcpConfig(ctx.cwd)) {
			ctx.ui.notify("MCP: this folder's .mcp.json is ignored because the folder is not trusted. Use /trust to enable it.", "info");
		}
	});
}
