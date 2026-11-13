// Serializes lease writes and fences all later work after a terminal refusal.
import { protocol, unavailable } from "./direct-link-mcp.ts";
import { parseLaunchInputs, parseWorkItem } from "./direct-link-workitem.ts";
import type { DirectMcp } from "./direct-link-mcp.ts";
import type { DirectCredentials, ProofOptions } from "./direct-link-credentials.ts";
import type { DirectError, Renewal, Result, WorkState, WriteContext, Release } from "./direct-link-mcp.ts";
import type { WorkItem } from "./direct-link-workitem.ts";
export interface LeaseClock {
	now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(timer: unknown): void;
}
export interface LeaseTransport {
	heartbeat(context: WriteContext, state: WorkState): Promise<Result<Renewal>>;
	release(context: WriteContext, release: Release): Promise<Result<unknown>>;
}
const clock: LeaseClock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };
const terminal = (error: DirectError) => error.kind !== "unavailable";
export interface StartupDeps extends ProofOptions {
	credentials: Pick<DirectCredentials, "launchProof">; mcp: Pick<DirectMcp, "claim" | "heartbeat" | "release">;
	harnessVersion: string; clock?: LeaseClock;
}
export async function claimAtStartup(deps: StartupDeps): Promise<Result<DirectLease>> {
	let launchProof: string;
	try { launchProof = await deps.credentials.launchProof(deps); }
	catch { return { ok: false, error: { kind: "proof-unavailable" } }; }
	try {
		const env = deps.env ?? process.env;
		const launch = parseLaunchInputs({ workHandle: env[protocol.env.workHandle], session: env[protocol.env.session], launchProof });
		if (env[protocol.env.harness] !== "pi") throw new Error();
		const claim = await deps.mcp.claim({ ...launch, harness: "pi", harnessVersion: deps.harnessVersion });
		if (!claim.ok) return claim;
		const item = parseWorkItem(claim.value, (deps.clock ?? clock).now());
		if (item.workHandle !== launch.workHandle) throw new Error();
		return { ok: true, value: new DirectLease(item, deps.mcp, deps.clock) };
	} catch { return { ok: false, error: { kind: "launch-not-authorized" } }; }
}
export class DirectLease {
	#context: WriteContext; #until: number; #grant: number; #every: number;
	#transport: LeaseTransport; #clock: LeaseClock; #timer: unknown; #running = false;
	#tail = Promise.resolve(); #lastState: WorkState = "idle"; #failure?: DirectError; #released = false;
	constructor(item: WorkItem, transport: LeaseTransport, timers: LeaseClock = clock) {
		this.#context = { workHandle: item.workHandle, claimId: item.claimId, epoch: item.epoch };
		this.#until = Date.parse(item.leaseUntil); this.#grant = Date.parse(item.grantExpiresAt); this.#every = item.heartbeatEvery;
		this.#transport = transport; this.#clock = timers;
	}
	get lost(): boolean { this.#check(); return this.#failure !== undefined; }
	get interval(): number { return Math.min(this.#every, (Math.min(this.#until, this.#grant) - this.#clock.now()) / 3); }
	#lose(error: DirectError): void { this.#failure = error; this.stop(); }
	#check(): void {
		if (this.#failure || this.#released) return;
		if (this.#clock.now() >= Math.min(this.#until, this.#grant)) this.#lose({ kind: "grant-expired" });
	}
	write<T>(action: (context: WriteContext) => Promise<Result<T>>): Promise<Result<T>> {
		const result = this.#tail.then(async (): Promise<Result<T>> => {
			this.#check();
			if (this.#failure) return { ok: false, error: this.#failure };
			if (this.#released) return { ok: false, error: { kind: "cancelled", reason: "Lease released" } };
			try {
				const response = await action({ ...this.#context });
				if (!response.ok && terminal(response.error)) this.#lose(response.error);
				return response;
			} catch { return unavailable(); }
		});
		this.#tail = result.then(() => {});
		return result;
	}
	renew(state?: WorkState): Promise<Result<Renewal>> {
		return this.write(async (context) => {
			const changed = state !== undefined && state !== this.#lastState;
			return this.#heartbeat(context, changed ? state : this.#lastState);
		});
	}
	setState(state: WorkState): Promise<Result<unknown>> {
		return this.write(async (context) => {
			if (state === this.#lastState) return { ok: true, value: undefined };
			return this.#heartbeat(context, state);
		});
	}
	async #heartbeat(context: WriteContext, state: WorkState): Promise<Result<Renewal>> {
		const response = await this.#transport.heartbeat(context, state);
		if (!response.ok) return response;
		if (response.value?.epoch !== context.epoch) return { ok: false, error: { kind: "stale-epoch" } };
		const until = Date.parse(response.value?.leaseUntil);
		if (!(until > this.#clock.now())) return unavailable();
		this.#until = until;
		this.#lastState = state;
		return response;
	}
	start(): void {
		if (this.#running || this.lost || this.#released) return;
		this.#running = true; this.#schedule();
	}
	#schedule(): void {
		if (!this.#running || this.lost) return;
		this.#timer = this.#clock.setTimeout(() => { void this.renew().then(() => this.#schedule()); }, Math.max(1, this.interval));
	}
	stop(): void { this.#running = false; this.#clock.clearTimeout(this.#timer); this.#timer = undefined; }
	release(release: Release): Promise<Result<unknown>> {
		return this.write(async (context) => {
			const response = await this.#transport.release(context, release);
			if (response.ok) { this.#released = true; this.stop(); }
			return response;
		});
	}
}
