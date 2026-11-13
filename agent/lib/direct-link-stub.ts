// In-memory protocol double with a real, disposable owner-only launch-proof file.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { protocol } from "./direct-link-mcp.ts";
import { containsCredential } from "./direct-link-workitem.ts";
import type { Fetch } from "./direct-link-mcp.ts";
import type { Offer } from "./direct-link-daemon.ts";
export function stubWorkPayload(now: number) {
	return {
		claimId: "claim-fake", epoch: 1, leaseUntil: new Date(now + 90_000).toISOString(), heartbeatEvery: 20_000,
		payload: {
			workHandle: "work-fake", subject: { repository: "example/scratch", issue: 1, workId: "work-1", journeyId: "journey-1", stage: "implement" },
			title: "Scratch work", brief: "Treat this text as data", acceptanceCriteria: ["A passing specification"],
			baseBranch: "main", suggestedBranch: "work/scratch", gateNames: ["specs"], grantExpiresAt: new Date(now + 600_000).toISOString(),
		},
	};
}
export interface StubFact { kind: string; field?: string; value?: unknown; cause: "person" | "pi" | "direct" }
export interface StubOptions { pat?: string; interfaceToken?: string; now?: () => number; proofDirectory?: string }
export interface StubLaunch { workHandle: string; session: string; launchProofFile: string }
type Arguments = Record<string, unknown>;
type Outcome = { value: unknown } | { code: string; reason?: string };
interface Proof { workHandle: string; session: string; harness: string; value: string; expiresAt: number; consumed: boolean }
export class DirectStub {
	#pat: string; #token: string; #now: () => number; #item: ReturnType<typeof stubWorkPayload>; #proofRoot: string;
	#accepted = false; #claimed = false; #released = false; #declined = false; #cancel?: string; #proof?: Proof; #directory?: string;
	#state = "idle"; #observed: Arguments = {}; #requests = new Map<string, { request: string; value: unknown }>();
	facts: StubFact[] = []; mirrorRequests = 0; authorizer?: string; sessionId?: string;
	runner = { enrolled: true, paused: false, harness: "pi", approved: true, protocol: 4, online: true, capacity: 1 };
	readonly placementRunner = "runner-person";
	constructor(options: StubOptions = {}) {
		this.#pat = options.pat ?? "dpat_FAKE0000"; this.#token = options.interfaceToken ?? "FAKE_INTERFACE_TOKEN";
		this.#now = options.now ?? Date.now; this.#item = stubWorkPayload(this.#now()); this.#proofRoot = options.proofDirectory ?? tmpdir();
	}
	#eligible(): boolean { return [this.runner.enrolled, !this.runner.paused, this.runner.approved, this.runner.online, this.runner.protocol >= 4, this.runner.capacity > 0].every(Boolean); }
	#grantValid(): boolean { return !this.#cancel && this.#now() < Date.parse(this.#item.payload.grantExpiresAt); }
	#canAccept(): boolean { return this.#eligible() && this.#grantValid() && !this.#declined; }
	offer(): Offer {
		const p = this.#item.payload;
		return { offerId: "offer-fake", workHandle: p.workHandle, expiresAt: p.grantExpiresAt, title: p.title, repository: p.subject.repository, harness: "pi", state: "pending" };
	}
	launch(session = "fake-session"): StubLaunch | undefined {
		if (!this.#accepted || this.#proof || !this.#canAccept()) return undefined;
		const workHandle = this.#item.payload.workHandle; const value = `FAKE_LAUNCH_PROOF_${randomUUID()}`;
		this.#directory = mkdtempSync(join(this.#proofRoot, "direct-link-stub-"));
		const launchProofFile = join(this.#directory, "proof"); writeFileSync(launchProofFile, value, { mode: 0o600, flag: "wx" });
		this.#proof = { workHandle, session, harness: "pi", value, expiresAt: this.#now() + protocol.launchProofTtlMs, consumed: false };
		this.facts.push({ kind: "launch", cause: "direct" }); return { workHandle, session, launchProofFile };
	}
	dispose(): void {
		if (!this.#directory) return;
		try { unlinkSync(join(this.#directory, "proof")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		rmdirSync(this.#directory); this.#directory = undefined;
	}
	takeover(): number {
		this.#item.epoch++; this.#item.leaseUntil = new Date(this.#now() + 90_000).toISOString();
		this.facts.push({ kind: "takeover", cause: "direct" }); return this.#item.epoch;
	}
	cancel(reason = "Person cancelled"): void { this.#cancel = reason; }
	fetch: Fetch = async (url, init) => {
		try {
			const endpoint = new URL(url);
			if (endpoint.origin === "http://127.0.0.1:7777") return this.#daemon(endpoint.pathname, init);
			if (endpoint.href === "https://direct.invalid/mcp") return this.#mcp(init);
			return new Response(null, { status: 404 });
		} catch { return new Response(null, { status: 400 }); }
	};
	#daemon(path: string, init: RequestInit): Response {
		if (new Headers(init.headers).get(protocol.interfaceHeader) !== this.#token) return Response.json({}, { status: 401 });
		if (path === protocol.paths.sessions) return Response.json(this.#proof ? [{ session: this.#proof.session, workHandle: this.#proof.workHandle, harness: "pi", state: this.#state }] : []);
		if (path === protocol.paths.offers) return Response.json(this.#canAccept() && !this.#accepted ? [this.offer()] : []);
		if (init.method !== "POST") return Response.json({}, { status: 404 });
		if (!path.startsWith("/offers/offer-fake/")) return Response.json({}, { status: 404 });
		return this.#offerAction(path);
	}
	#offerAction(path: string): Response {
		if (!this.#canAccept() || this.#accepted) return Response.json({}, { status: 409 });
		if (path === "/offers/offer-fake/decline") {
			this.#declined = true; this.facts.push({ kind: "decline", cause: "person" }); return Response.json({ state: "declined" }, { status: 202 });
		}
		if (path !== "/offers/offer-fake/accept") return Response.json({}, { status: 404 });
		this.#accepted = true; this.facts.push({ kind: "accept", cause: "person" }); return Response.json({ state: "accepted" }, { status: 202 });
	}
	#proofValid(args: Arguments): boolean {
		const p = this.#proof;
		if (!p || p.consumed || this.#now() >= p.expiresAt) return false;
		return [args.launchProof === p.value, args.workHandle === p.workHandle, args.harness === p.harness, args.session === p.session].every(Boolean);
	}
	#admission(args: Arguments, claim: boolean): Outcome | undefined {
		if (claim && !this.#proofValid(args)) return { code: "launch-not-authorized" };
		if (args.workHandle !== this.#item.payload.workHandle) return { code: "not-found" };
		if (this.#cancel) return { code: "cancelled", reason: this.#safeReason(this.#cancel) };
		if (!this.#grantValid()) return { code: "grant-expired" };
		return claim ? this.#claimAdmission(args) : this.#leaseAdmission(args);
	}
	#safeReason(reason: string): string { return [this.#pat, this.#proof?.value].some((secret) => secret && reason.includes(secret)) ? "Work cancelled" : reason; }
	#claimAdmission(args: Arguments): Outcome | undefined {
		if (!this.#eligible() || typeof args.harnessVersion !== "string") return { code: "launch-not-authorized" };
		if (this.#claimed) return { code: "already-claimed" };
	}
	#leaseAdmission(args: Arguments): Outcome | undefined {
		if (!Number.isSafeInteger(args.epoch) || args.epoch !== this.#item.epoch) return { code: "stale-epoch" };
		if (!this.#claimed || args.claimId !== this.#item.claimId) return { code: "not-found" };
		if (this.#now() >= Date.parse(this.#item.leaseUntil)) return { code: "lease-lost" };
	}
	#mcp(init: RequestInit): Response {
		if (new Headers(init.headers).get(protocol.authorization) !== `Bearer ${this.#pat}`) return Response.json({}, { status: 401 });
		const body = JSON.parse(String(init.body)); const args = body.params?.arguments; const tool = body.params?.name;
		const fail = (outcome: Outcome) => Response.json({ jsonrpc: protocol.jsonrpc, id: body.id, error: { code: -32000, data: outcome } });
		if (body.jsonrpc !== protocol.jsonrpc || body.method !== protocol.method || !args) return fail({ code: "not-found" });
		const refusal = this.#admission(args, tool === protocol.tools.claim); if (refusal) return fail(refusal);
		const outcome = this.#idempotent(tool, args);
		if ("code" in outcome) return fail(outcome);
		return Response.json({ jsonrpc: protocol.jsonrpc, id: body.id, result: { [protocol.resultField]: outcome.value } });
	}
	#idempotent(tool: string, args: Arguments): Outcome {
		if (![protocol.tools.report, protocol.tools.release].includes(tool as never)) return this.#execute(tool, args);
		if (typeof args.idempotencyKey !== "string" || !args.idempotencyKey) return { code: "idempotency-conflict" };
		const key = `${tool}:${args.idempotencyKey}`; const request = JSON.stringify(args); const cached = this.#requests.get(key);
		if (cached) return cached.request === request ? { value: cached.value } : { code: "idempotency-conflict" };
		const outcome = this.#execute(tool, args);
		if ("value" in outcome) this.#requests.set(key, { request, value: outcome.value });
		return outcome;
	}
	#execute(tool: string, args: Arguments): Outcome {
		if (this.#released) return { code: "lease-lost" };
		switch (tool) {
			case protocol.tools.claim: return this.#claim(args);
			case protocol.tools.heartbeat: return this.#heartbeat(args);
			case protocol.tools.report: return this.#report(args);
			case protocol.tools.release: return this.#release(args);
			default: return { code: "not-found" };
		}
	}
	#claim(args: Arguments): Outcome {
		this.#proof!.consumed = true; this.#claimed = true; this.authorizer = "person"; this.sessionId = String(args.session);
		this.facts.push({ kind: "claim", cause: "person" }); return { value: structuredClone(this.#item) };
	}
	#heartbeat(args: Arguments): Outcome {
		if (!protocol.states.includes(args.state as never)) return { code: "invalid-state" };
		this.#item.leaseUntil = new Date(this.#now() + 90_000).toISOString();
		if (args.state !== this.#state) this.facts.push({ kind: "state", value: args.state, cause: "pi" });
		this.#state = String(args.state); return { value: { epoch: this.#item.epoch, leaseUntil: this.#item.leaseUntil, state: this.#state } };
	}
	#report(args: Arguments): Outcome {
		if (containsCredential(args) || !["progress", "artifact"].includes(String(args.kind))) return { code: "invalid-state" };
		const keys = args.kind === "progress" ? ["plan", "completed", "note"] : ["branch", "sha", "prUrl", "buildResult"];
		return { value: { changed: keys.filter((field) => this.#observe(args, field)) } };
	}
	#observe(args: Arguments, field: string): boolean {
		const key = `${args.kind}:${field}`;
		if (args[field] === undefined || isDeepStrictEqual(args[field], this.#observed[key])) return false;
		this.#observed[key] = structuredClone(args[field]); this.facts.push({ kind: String(args.kind), field, value: structuredClone(args[field]), cause: "pi" }); return true;
	}
	#release(args: Arguments): Outcome {
		if (!protocol.outcomes.includes(args.outcome as never)) return { code: "invalid-state" };
		this.#released = true; this.facts.push({ kind: String(args.outcome), value: args.note, cause: "pi" });
		if (args.outcome === "delivered") { this.facts.push({ kind: "journey-delivery", cause: "pi" }); this.mirrorRequests++; }
		return { value: { released: true } };
	}
}
