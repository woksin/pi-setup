// Each observation is compared independently; only successful facts become the baseline.
import { isDeepStrictEqual } from "node:util";
import { containsCredential } from "./direct-link-workitem.ts";
import type { DirectLease } from "./direct-link-lease.ts";
import type { Result, WriteContext } from "./direct-link-mcp.ts";
export interface Progress { plan?: string[]; completed?: string[]; note?: string }
export interface Artifact { branch?: string; sha?: string; prUrl?: string; buildResult?: string }
export type Report = ({ kind: "progress" } & Progress) | ({ kind: "artifact" } & Artifact);
export interface ReportTransport { report(context: WriteContext, report: Report): Promise<Result<unknown>> }
const fields = { progress: ["plan", "completed", "note"], artifact: ["branch", "sha", "prUrl", "buildResult"] } as const;
export class DirectReporter {
	#lease: DirectLease; #transport: ReportTransport;
	#last: Record<string, Record<string, unknown>> = { progress: {}, artifact: {} };
	constructor(lease: DirectLease, transport: ReportTransport) { this.#lease = lease; this.#transport = transport; }
	progress(progress: Progress): Promise<Result<unknown>> { return this.report({ ...progress, kind: "progress" }); }
	artifact(artifact: Artifact): Promise<Result<unknown>> { return this.report({ ...artifact, kind: "artifact" }); }
	report(report: Report): Promise<Result<unknown>> {
		// Snapshot before queueing so callers cannot mutate the sent or remembered facts.
		const snapshot = structuredClone(report);
		return this.#lease.write(async (context) => {
			if (containsCredential(snapshot)) throw new Error("Credential material refused in report");
			const previous = this.#last[snapshot.kind];
			const changed = Object.fromEntries(Object.entries(snapshot).filter(([key, value]) =>
				fields[snapshot.kind].includes(key as never) && value !== undefined && !isDeepStrictEqual(value, previous[key])));
			if (!Object.keys(changed).length) return { ok: true, value: undefined };
			const result = await this.#transport.report(context, { kind: snapshot.kind, ...changed } as Report);
			if (result.ok) Object.assign(previous, structuredClone(changed));
			return result;
		});
	}
}
