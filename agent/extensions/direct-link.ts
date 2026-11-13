// Copyright (c) Cratis. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createBashToolDefinition, VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DirectCredentials } from "../lib/direct-link-credentials.ts";
import { claimAtStartup } from "../lib/direct-link-lease.ts";
import type { DirectLease, LeaseClock } from "../lib/direct-link-lease.ts";
import { DirectMcp, protocol } from "../lib/direct-link-mcp.ts";
import type { Fetch, Release, Result, WorkState } from "../lib/direct-link-mcp.ts";
import { DirectReporter } from "../lib/direct-link-report.ts";
import type { Artifact } from "../lib/direct-link-report.ts";
import { artifactFromResult, childEnvironment, deliveryEvidence, directToolDenied, maskDirect, parseSubmission } from "../lib/direct-link-hooks.ts";

export interface DirectLinkServices {
	env?: NodeJS.ProcessEnv;
	credentials?: DirectCredentials;
	fetch?: Fetch;
	gitArtifact?: (cwd: string) => Promise<Artifact>;
	clock?: LeaseClock;
}
async function gitArtifact(cwd: string): Promise<Artifact> {
	const run = async (args: string[]) => (await promisify(execFile)("git", args, { cwd, env: childEnvironment(process.env), timeout: 2000 })).stdout.trim();
	const [branch, sha] = await Promise.all([run(["branch", "--show-current"]), run(["rev-parse", "HEAD"])]);
	return { branch, sha };
}
function observesGit(event: { isError: boolean; toolName: string; input: Record<string, unknown> }): boolean {
	return !event.isError && event.toolName === "bash" && /\bgit\s+(?:push|commit)\b/.test(String(event.input.command ?? ""));
}
const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: {}, isError });
const string = { type: "string" };
const parameters = {
	type: "object", additionalProperties: false, required: ["kind"], properties: {
		kind: { type: "string", enum: ["progress", "artifact"] }, plan: { type: "array", items: string }, completed: { type: "array", items: string },
		note: string, branch: string, sha: string, prUrl: string, buildResult: string,
		state: { type: "string", enum: protocol.states }, outcome: { type: "string", enum: protocol.outcomes },
	},
};
export default function directLink(pi: ExtensionAPI, services: DirectLinkServices = {}) {
	const env = services.env ?? process.env;
	if (!env.DIRECT_LINK_WORK_HANDLE) return;
	const launchEnv = { ...env };
	// Keep launch material out of every subsequently inherited child environment, including keychain lookup.
	for (const key of Object.keys(env)) if (key === "DIRECT_PAT" || /^DIRECT_.*(?:PROOF|TOKEN|SECRET|PASSWORD|DPAT)/i.test(key)) delete env[key];
	const credentials = services.credentials ?? new DirectCredentials();
	const protectedPaths = launchEnv.DIRECT_LINK_LAUNCH_PROOF_FILE ? [resolve(launchEnv.DIRECT_LINK_LAUNCH_PROOF_FILE)] : [];
	let phase = "starting";
	let lease: DirectLease | undefined;
	let reporter: DirectReporter | undefined;
	let state: WorkState = "idle";
	let outcome: Release["outcome"] = "abandoned";
	let evidence: Artifact = {};
	const clock = services.clock ?? {
		now: Date.now,
		setTimeout: (fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
		clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
	};
	let timer: unknown;
	let startup: Promise<void> | undefined;
	let context: ExtensionContext | undefined;
	const clean = <T>(value: T) => maskDirect(value, credentials.secretsToMask());
	const tell = (text: string) => {
		if (context?.hasUI) context.ui.notify(clean(text), "info");
		else pi.sendMessage({ customType: "direct-link", content: clean(text), display: true });
	};
	const stop = () => { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; lease?.stop(); };
	const lose = () => {
		if (phase === "lost") return;
		phase = "lost"; stop();
		tell("Direct lease lost. Stop work and request a new Launch. The worktree is preserved.");
		context?.abort();
	};
	const checked = <T>(result: Result<T>): boolean => {
		if (!result.ok) { lose(); return false; }
		return true;
	};
	const ready = () => {
		if (phase === "active" && lease?.lost) lose();
		return phase === "active";
	};
	const schedule = () => {
		if (!ready()) return;
		timer = clock.setTimeout(async () => {
			if (checked(await lease!.renew(state))) schedule();
		}, Math.max(1, lease!.interval));
	};
	const changeState = async (next: WorkState) => {
		if (!ready()) return;
		if (checked(await lease!.setState(next))) state = next;
	};
	const reportArtifact = async (artifact: Artifact) => {
		if (!ready() || JSON.stringify(clean(artifact)) !== JSON.stringify(artifact)) return;
		if (checked(await reporter!.artifact(artifact))) Object.assign(evidence, artifact);
	};
	const start = async (ctx: ExtensionContext) => {
		context = ctx;
		try {
			// Consume the file even if subsequent configuration/keychain lookup fails. No legacy env fallback.
			const proof = await credentials.launchProof({ env: launchEnv, cwd: ctx.cwd, worktree: ctx.cwd });
			const pat = await credentials.pat({ env: {} });
			const mcp = new DirectMcp(launchEnv.DIRECT_LINK_MCP_URL ?? "", pat, services.fetch ?? fetch);
			const claimed = await claimAtStartup({
				env: launchEnv, cwd: ctx.cwd, worktree: ctx.cwd, harnessVersion: VERSION, mcp,
				credentials: { launchProof: async () => proof }, clock: services.clock,
			});
			if (!claimed.ok) { lose(); return; }
			if (phase !== "starting") { claimed.value.stop(); return; }
			lease = claimed.value; reporter = new DirectReporter(lease, mcp); phase = "active";
			tell("Direct claimed this Launch for harness pi. Delivery requires branch, SHA, and gate evidence; no PR is created.");
			schedule();
		} catch { lose(); }
	};
	pi.registerTool(createBashToolDefinition(process.cwd(), {
		spawnHook: spawn => ({ ...spawn, env: childEnvironment(spawn.env) }),
	}));
	pi.on("session_start", async (_event, ctx) => {
		// Session switches/reloads cannot reuse a consumed proof or silently move an active claim.
		if (startup) { lose(); return; }
		startup = start(ctx); await startup;
	});
	pi.on("tool_call", async (event, ctx) => {
		if (startup) await startup;
		if (!ready()) return { block: true, reason: "Direct is not active. Request a new Launch." };
		if (directToolDenied(event.input, ctx.cwd, credentials, protectedPaths)) return { block: true, reason: "Direct protects credential paths and disables PR creation." };
		if (event.toolName !== "direct_work_report") await changeState("working");
		if (!ready()) return { block: true, reason: "Direct lease lost. Request a new Launch." };
	});
	const finish = async (end?: Release["outcome"]) => {
		if (!end) return reply("Direct report recorded.");
		if (end === "delivered" && !deliveryEvidence(evidence)) return reply("Delivery requires branch, full SHA, and gate evidence.", true);
		outcome = end;
		if (!checked(await lease!.release({ outcome }))) return reply("Direct lease lost.", true);
		phase = "released"; stop();
		return reply("Direct report recorded.");
	};
	pi.registerTool({
		name: "direct_work_report", label: "Direct work report", description: "Report changed progress or artifact facts to Direct. Set working, waiting-ci, waiting-review, blocked, or idle. delivered requires branch, full SHA, and gate evidence; reports are evidence, not approval.",
		parameters: parameters as any,
		execute: async (_id, value) => {
			if (!ready() || !reporter) return reply("Direct is not active. Request a new Launch.", true);
			try {
				const { report, state: next, outcome: end } = parseSubmission(value);
				if (JSON.stringify(clean(report)) !== JSON.stringify(report)) throw new Error();
				if (!checked(await reporter.report(report))) return reply("Direct lease lost.", true);
				if (report.kind === "artifact") Object.assign(evidence, report);
				if (next) await changeState(next);
				if (!ready()) return reply("Direct lease lost.", true);
				return await finish(end);
			} catch { return reply("Invalid Direct report.", true); }
		},
	} as any);
	pi.on("tool_result", async event => {
		// Mask before returning anything to Pi's session storage. Never forward raw tool output to Direct.
		const masked = clean({ content: event.content, details: event.details });
		if (ready()) {
			const artifact = artifactFromResult({ isError: event.isError, details: masked.details });
			if (artifact) await reportArtifact(artifact);
			if (observesGit(event)) {
				try { await reportArtifact(await (services.gitArtifact ?? gitArtifact)(context!.cwd)); }
				catch { /* A failed read-only observation is not gate or delivery evidence. */ }
			}
		}
		return masked;
	});
	pi.on("agent_start", async () => { await changeState("working"); });
	pi.on("agent_end", async () => { if (state === "working") await changeState("idle"); });
	pi.on("user_bash", () => ({ result: { output: "Direct harness: use the guarded bash tool; shell escapes have no output masking hook.", exitCode: 1, cancelled: false, truncated: false } }));
	pi.on("session_shutdown", async () => {
		if (startup) await startup;
		stop();
		if (ready() && checked(await lease!.release({ outcome }))) phase = "released";
	});
	pi.registerCommand("direct", {
		description: "Show Direct launch/lease status (never accepts offers or claims work)",
		handler: async (_args, ctx) => {
			context = ctx; ready();
			tell(`Direct: ${phase}; state: ${state}; outcome: ${phase === "released" ? outcome : "pending"}.`);
		},
	});
}
