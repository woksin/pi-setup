/**
 * exact-model-guard — fail closed instead of substituting a model for agents that must run on one exact model.
 *
 * An agent opts in by listing `exact-model-guard` in its `extensions:` (the cross-provider reviewers do). Two
 * paths can otherwise start such an agent on another model without telling anyone: pi-subagents inherits the
 * parent's model when the pinned one is unavailable, and a fallback extension can pre-empt to another provider on
 * a shared limit mark. Before every provider request this guard compares the session's model with the agent's
 * `model:`; on a mismatch, or when the agent's definition cannot be resolved, it aborts the run before the request
 * is sent, blocks tool calls, and records why. The caller (for example the review workflow) then sees a failed
 * agent, never a result from the wrong provider.
 *
 * pi-subagents loads this extension into a child only when the child's selected definition lists it, so a child
 * that runs it has opted in. The pinned model comes from pi-subagents' own loader (`loadCustomAgents`) for the
 * session's cwd; when that definition does not list the guard (for example a spawn whose target directory differs
 * from the directory its definition came from), the pin cannot be verified and the child stops (fail closed).
 * The process root (the interactive or headless main session, which auto-loads every extension) is untouched.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const GUARD_ENTRY = "exact-model-guard";
export const GUARD_EXTENSION = "exact-model-guard";

export type AgentDefinition = { name: string; model?: string; extensions?: unknown };
export type AgentLoader = (cwd: string) => Promise<Map<string, AgentDefinition>>;

/** pi-subagents names a child session `<agent type>` or `<agent type>#<id prefix>`. */
export function agentNameFromSession(sessionName: string | undefined): string | undefined {
	const name = sessionName?.replace(/#[0-9a-z-]+$/i, "").trim();
	return name || undefined;
}

/** pi-subagents' installed loader, imported from the agent dir's npm packages. */
export const subagentsLoader: AgentLoader = async (cwd) => {
	const url = pathToFileURL(join(getAgentDir(), "npm", "node_modules", "@tintinweb", "pi-subagents", "dist", "custom-agents.js")).href;
	const mod = (await import(url)) as { loadCustomAgents: (cwd: string) => Map<string, AgentDefinition> };
	return mod.loadCustomAgents(cwd);
};

const listsGuard = (extensions: unknown) =>
	Array.isArray(extensions) && extensions.some((entry) => typeof entry === "string" && entry.trim().toLowerCase() === GUARD_EXTENSION);

const ROOT = Symbol.for("pi.exact-model-guard.root");
const ROOT_CWD = Symbol.for("pi.exact-model-guard.root-cwd");

/** True for the first guard instance in this process: the main session, which starts before any subagent. */
function claimRoot(instance: object, cwd: string): boolean {
	const store = globalThis as Record<symbol, unknown>;
	if (store[ROOT] === undefined) {
		store[ROOT] = instance;
		store[ROOT_CWD] = cwd;
	}
	return store[ROOT] === instance;
}

/** The process root's cwd: where the spawn of a top-level agent read its definition, even for another target dir. */
function rootCwd(): string | undefined {
	const cwd = (globalThis as Record<symbol, unknown>)[ROOT_CWD];
	return typeof cwd === "string" ? cwd : undefined;
}

/** Tests only: forget the process root. */
export function resetProcessRoot(): void {
	delete (globalThis as Record<symbol, unknown>)[ROOT];
	delete (globalThis as Record<symbol, unknown>)[ROOT_CWD];
}

export type Verdict = { kind: "ok" } | { kind: "skip" } | { kind: "stop"; text: string; expected?: string };

/**
 * For a child session that runs the guard (so its selected definition opted in): `ok` only when every candidate
 * definition of its agent that lists the guard pins exactly the model about to be called. Candidates come from the
 * child's cwd and the process root's cwd (the spawn reads definitions from the spawner's directory, which can differ
 * from the target directory), so an ambiguous pin stops too. `stop` whenever the pin cannot be established. `skip`
 * only for the process root.
 */
export function verdict(
	name: string | undefined,
	registries: Map<string, AgentDefinition> | Error | (Map<string, AgentDefinition> | Error)[],
	model: { provider?: string; id?: string } | undefined,
	child = true,
): Verdict {
	if (!child) return { kind: "skip" };
	const actual = model?.provider && model?.id ? `${model.provider}/${model.id}` : "an unknown model";
	if (!name) return { kind: "stop", text: `exact-model-guard: cannot identify this agent (no session name); stopped before calling ${actual}.` };
	const all = Array.isArray(registries) ? registries : [registries];
	const failed = all.find((entry): entry is Error => entry instanceof Error);
	if (failed || !all.length) {
		return { kind: "stop", text: `exact-model-guard: cannot load agent definitions to check "${name}" (${failed?.message ?? "none loaded"}); stopped before calling ${actual}.` };
	}
	const candidates = (all as Map<string, AgentDefinition>[]).map((registry) => registry.get(name)).filter((agent): agent is AgentDefinition => !!agent && listsGuard(agent.extensions));
	if (!candidates.length) {
		return { kind: "stop", text: `exact-model-guard: no definition of "${name}" visible from this or the main session's directory lists exact-model-guard, so the spawned agent's pinned model cannot be verified; stopped before calling ${actual}.` };
	}
	const mismatch = candidates.find((agent) => agent.model !== actual);
	if (!mismatch) return { kind: "ok" };
	if (!mismatch.model) return { kind: "stop", text: `exact-model-guard: agent "${name}" lists exact-model-guard but pins no model; stopped before calling ${actual}.` };
	return {
		kind: "stop",
		expected: mismatch.model,
		text: `exact-model-guard: agent "${name}" must run on ${mismatch.model} but was about to call ${actual}; stopped instead of substituting. Not a result: report it to the routing owner; do not rerun on another provider.`,
	};
}

export function createGuard(load: AgentLoader) {
	return function (pi: ExtensionAPI) {
		let agents: (Map<string, AgentDefinition> | Error)[] | undefined;
		let violation: string | undefined;
		const instance = {};
		let root = false;

		async function check(ctx: ExtensionContext): Promise<boolean> {
			if (ctx.hasUI || root) return false;
			if (!violation) {
				const name = agentNameFromSession(ctx.sessionManager.getSessionName?.());
				if (name && !agents) {
					const dirs = [...new Set([ctx.cwd, rootCwd()].filter((dir): dir is string => !!dir))];
					agents = await Promise.all(dirs.map((dir) => load(dir).catch((error) => (error instanceof Error ? error : new Error(String(error))))));
				}
				const result = verdict(name, agents ?? [], ctx.model);
				if (result.kind !== "stop") return false;
				violation = result.text;
				console.error(result.text);
				try {
					pi.appendEntry(GUARD_ENTRY, { text: result.text, expected: result.expected, actual: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, at: Date.now() });
				} catch {
					// transcript unavailable: stderr carries it
				}
			}
			ctx.abort();
			return true;
		}

		pi.on("session_start", async (_event, ctx) => {
			agents = undefined;
			violation = undefined;
			root = claimRoot(instance, ctx.cwd) || ctx.hasUI;
		});
		pi.on("before_agent_start", async (_event, ctx) => {
			await check(ctx);
		});
		pi.on("before_provider_request", async (_event, ctx) => {
			await check(ctx);
		});
		pi.on("tool_call", async (_event, ctx) => {
			if (await check(ctx)) return { block: true, reason: violation };
			return undefined;
		});
	};
}

export default createGuard(subagentsLoader);
