// L101 r2 boundary defaults; payload field types remain explicit in the pure modules.
import { randomUUID } from "node:crypto";
import { containsCredential } from "./direct-link-workitem.ts";
export const protocol = {
	jsonrpc: "2.0", method: "tools/call", resultField: "structuredContent", timeUnit: "milliseconds", launchProofTtlMs: 60_000,
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
export interface WriteContext { workHandle: string; epoch: number; claimId: string }
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
export class DirectMcp {
	#url: string; #pat: string; #fetch: Fetch; #key: () => string; #proofs = new Set<string>();
	constructor(url: string, pat: string, fetch: Fetch, key: () => string = randomUUID) {
		try {
			const endpoint = new URL(url);
			if (!["https:", "http:"].includes(endpoint.protocol)) throw new Error();
			if (endpoint.username || endpoint.password) throw new Error();
			this.#url = endpoint.href; this.#pat = pat; this.#fetch = fetch; this.#key = key;
		} catch { throw new Error("Invalid Direct endpoint"); }
	}
	async #call<T>(tool: string, args: object, id: string): Promise<Result<T>> {
		try {
			const response = await this.#fetch(this.#url, {
				method: "POST", redirect: "error", headers: { "Content-Type": "application/json", [protocol.authorization]: `Bearer ${this.#pat}` },
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
		} catch { return unavailable(); }
	}
	#error(data: unknown): Result<never> {
		const result = wireError(data);
		if (result.ok || result.error.kind !== "cancelled") return result;
		const secrets = [this.#pat, ...this.#proofs]; const reason = result.error.reason;
		if (secrets.some((secret) => secret && reason.includes(secret))) return { ok: false, error: { kind: "cancelled", reason: "Work cancelled" } };
		return result;
	}
	claim(request: ClaimRequest): Promise<Result<unknown>> {
		this.#proofs.add(request.launchProof);
		return this.#call(protocol.tools.claim, request, this.#key());
	}
	heartbeat(context: WriteContext, state: WorkState = "idle"): Promise<Result<Renewal>> {
		return this.#call(protocol.tools.heartbeat, { ...context, state }, this.#key());
	}
	report(context: WriteContext, report: object, idempotencyKey = this.#key()): Promise<Result<unknown>> {
		return this.#call(protocol.tools.report, { ...report, ...context, idempotencyKey }, this.#key());
	}
	release(context: WriteContext, release: Release, idempotencyKey = this.#key()): Promise<Result<unknown>> {
		return this.#call(protocol.tools.release, { ...release, ...context, idempotencyKey }, this.#key());
	}
}
