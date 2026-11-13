// Copyright (c) Cratis. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

// L101 r2 boundary defaults; payload field types remain explicit in the pure modules.
import { randomUUID } from "node:crypto";
import { containsCredential, maskWorkCredentials } from "./direct-link-workitem.ts";
export const protocol = {
	jsonrpc: "2.0", method: "tools/call", resultField: "structuredContent", timeUnit: "milliseconds", launchProofTtlMs: 120_000,
	authorization: "Authorization", interfaceHeader: "X-Runner-Interface-Token", daemonHost: "127.0.0.1",
	paths: { offers: "/offers", accept: "/offers/{offerId}/accept", decline: "/offers/{offerId}/decline", sessions: "/sessions" },
	env: { workHandle: "DIRECT_LINK_WORK_HANDLE", session: "DIRECT_LINK_SESSION", launchProof: "DIRECT_LINK_LAUNCH_PROOF", launchProofFile: "DIRECT_LINK_LAUNCH_PROOF_FILE", loopbackUrl: "DIRECT_LINK_LOOPBACK_URL", harness: "DIRECT_LINK_HARNESS" },
	tools: { claim: "direct_work_claim", heartbeat: "direct_work_heartbeat", report: "direct_work_report", release: "direct_work_release" },
	errors: ["stale-epoch", "cancelled", "launch-not-authorized", "grant-expired", "not-found", "idempotency-conflict", "already-claimed", "lease-lost", "invalid-state"],
	states: ["working", "waiting-ci", "waiting-review", "blocked", "idle"], outcomes: ["delivered", "abandoned", "failed"],
} as const;
type WireCode = typeof protocol.errors[number];
export type DirectError = { kind: Exclude<WireCode, "cancelled"> | "unauthorized" | "unavailable" | "fatal-stop" | "proof-unavailable" } | { kind: "cancelled"; reason: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: DirectError };
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export interface WriteContext { workHandle: string; epoch: number; claimId: string; signal?: AbortSignal }
export interface ClaimRequest { workHandle: string; session: string; harness: "pi"; harnessVersion: string; launchProof: string }
export type WorkState = typeof protocol.states[number];
export interface Renewal { epoch: number; leaseUntil: string; state: WorkState }
export interface Release { outcome: typeof protocol.outcomes[number]; note?: string }
export const unavailable = (): Result<never> => ({ ok: false, error: { kind: "unavailable" } });
export function wireError(data: unknown): Result<never> {
	const d = data as { code?: string; reason?: unknown } | undefined;
	if (d?.code === "cancelled") return { ok: false, error: { kind: "cancelled", reason: typeof d.reason === "string" && !containsCredential(d.reason) ? d.reason : "Work cancelled" } };
	if (protocol.errors.includes(d?.code as WireCode)) return { ok: false, error: { kind: d!.code as Exclude<WireCode, "cancelled"> } };
	return { ok: false, error: { kind: "fatal-stop" } };
}
// Bound the entire operation, including response decoding, even if a transport ignores abort.
export async function boundedRequest<T>(action: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, timeoutMs = 10_000): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timeout = setTimeout(abort, timeoutMs);
	let rejectAbort: () => void = () => {};
	try {
		const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new Error("Direct request stopped")); });
		controller.signal.addEventListener("abort", rejectAbort, { once: true });
		parent?.addEventListener("abort", abort, { once: true });
		if (parent?.aborted) abort();
		return await Promise.race([aborted, controller.signal.aborted ? aborted : action(controller.signal)]);
	} finally {
		clearTimeout(timeout); parent?.removeEventListener("abort", abort);
		controller.signal.removeEventListener("abort", rejectAbort);
	}
}
function endpointUrl(url: string): string {
	const endpoint = new URL(url);
	const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname);
	const secure = endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback);
	if (!secure || endpoint.username || endpoint.password) throw new Error();
	return endpoint.href;
}
interface McpOptions { key?: () => string; timeoutMs?: number }
export class DirectMcp {
	#url: string; #pat: string; #fetch: Fetch; #key: () => string; #proofs = new Set<string>(); #timeoutMs: number;
	constructor(url: string, pat: string, fetch: Fetch, options: (() => string) | McpOptions = {}) {
		try { this.#url = endpointUrl(url); } catch { throw new Error("Invalid Direct endpoint"); }
		const settings = typeof options === "function" ? { key: options } : options;
		this.#pat = pat; this.#fetch = fetch; this.#key = settings.key ?? randomUUID; this.#timeoutMs = settings.timeoutMs ?? 10_000;
	}
	async #call<T>(tool: string, args: object, id: string, parent?: AbortSignal): Promise<Result<T>> {
		try {
			return await boundedRequest(async (signal): Promise<Result<T>> => {
				const response = await this.#fetch(this.#url, {
					method: "POST", redirect: "error", signal, headers: { "Content-Type": "application/json", [protocol.authorization]: `Bearer ${this.#pat}` },
					body: JSON.stringify({ jsonrpc: protocol.jsonrpc, id, method: protocol.method, params: { name: tool, arguments: args } }),
				});
				if (response.status === 401 || response.status === 403) return { ok: false, error: { kind: "unauthorized" } };
				if (!response.ok || response.redirected) return unavailable();
				const body = await response.json();
				if (body.jsonrpc !== protocol.jsonrpc || body.id !== id) return unavailable();
				if (body.error) return this.#error(body.error.data);
				if (body.result?.isError) return this.#error(body.result.structuredContent);
				if (body.result?.[protocol.resultField] === undefined) return unavailable();
				return { ok: true, value: body.result[protocol.resultField] as T };
			}, parent, this.#timeoutMs);
		} catch { return unavailable(); }
	}
	#error(data: unknown): Result<never> {
		const result = wireError(data);
		if (result.ok || result.error.kind !== "cancelled") return result;
		const secrets = [this.#pat, ...this.#proofs]; const reason = result.error.reason;
		if (secrets.some((secret) => secret && reason.includes(secret))) return { ok: false, error: { kind: "cancelled", reason: "Work cancelled" } };
		return result;
	}
	async claim(request: ClaimRequest): Promise<Result<unknown>> {
		this.#proofs.add(request.launchProof);
		const result = await this.#call(protocol.tools.claim, request, this.#key());
		return result.ok ? { ok: true, value: maskWorkCredentials(result.value, [this.#pat, ...this.#proofs]) } : result;
	}
	heartbeat(context: WriteContext, state: WorkState = "idle"): Promise<Result<Renewal>> {
		const { signal, ...binding } = context;
		return this.#call(protocol.tools.heartbeat, { ...binding, state }, this.#key(), signal);
	}
	report(context: WriteContext, report: object, idempotencyKey = this.#key()): Promise<Result<unknown>> {
		const { signal, ...binding } = context;
		return this.#call(protocol.tools.report, { ...report, ...binding, idempotencyKey }, this.#key(), signal);
	}
	release(context: WriteContext, release: Release, idempotencyKey = this.#key()): Promise<Result<unknown>> {
		const { signal, ...binding } = context;
		return this.#call(protocol.tools.release, { ...release, ...binding, idempotencyKey }, this.#key(), signal);
	}
}
