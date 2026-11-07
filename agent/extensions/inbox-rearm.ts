/** Re-arm reminder via public session entries; never reaches into pi-jobs' private manager. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Params = { check: string; intervalSeconds: number; timeoutSeconds: number; until?: string; cwd?: string; label?: string; checkTimeoutSeconds?: number; quietTimeouts?: number };
type Watch = { id: string; kind: string; command: string; status: string; startedAt?: number; lane?: string; inboxDir?: string };

function inboxCheck(check: unknown, lane: string): check is string {
	if (typeof check !== "string") return false;
	// Accept the normal direct executable form (including quoted paths and aliases), not arbitrary shell programs.
	const words = (check.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? []).map(w => w.replace(/^(['"])(.*)\1$/, "$2"));
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
	if (!/(^|\/)inbox-watch$/.test(words.shift() ?? "")) return false;
	while (words[0] === "--alias" && words.length >= 2) words.splice(0, 2);
	return words[0] === lane;
}

type History = { lane: string; calls: Map<string, Params>; params: Map<string, Params>; jobs: Map<string, Watch>; diagnostics: Set<string> };

function messageOf(entry: any): any {
	if (entry?.type === "message") return entry.message;
	if (entry?.type === "custom_message") return { ...entry, role: "custom" };
}

function recordWatch(history: History, job: Watch | undefined): void {
	if (typeof job?.id !== "string" || !job.id) return;
	if (job.kind === "subscription") {
		if (job.lane !== history.lane || typeof job.inboxDir !== "string" || !isAbsolute(job.inboxDir)) return;
		if (typeof job.command !== "string" || typeof job.startedAt !== "number" || !Number.isFinite(job.startedAt)) return;
		if (!["running", "succeeded", "failed", "timed_out", "killed"].includes(job.status)) return;
		// History and settle entries can overlap: a stale running match must not revive a terminal owner.
		const previous = history.jobs.get(job.id);
		if (previous?.kind === "subscription" && previous.status !== "running" && job.status === "running") return;
		history.jobs.set(job.id, job);
	} else if (job.kind === "watch" && inboxCheck(job.command, history.lane)) history.jobs.set(job.id, job);
}

function recordCalls(history: History, content: any): void {
	const calls = Array.isArray(content) ? content : [];
	for (const call of calls) {
		if (call?.type !== "toolCall") continue;
		if (call.name !== "job_watch") continue;
		if (inboxCheck(call.arguments?.check, history.lane)) history.calls.set(call.id, call.arguments);
	}
}

function recordResult(history: History, message: any): void {
	if (!["job_watch", "job_subscribe", "job_list", "job_output", "job_kill"].includes(message.toolName)) return;
	recordWatch(history, message.details);
	for (const job of Array.isArray(message.details?.jobs) ? message.details.jobs : []) recordWatch(history, job);
	if (message.toolName !== "job_watch") return;
	const input = history.calls.get(message.toolCallId);
	if (!input) return;
	if (typeof message.details?.id === "string") history.params.set(message.details.id, input);
}

function validSubscriptionCompletion(completion: any): boolean {
	if (!["match", "terminal"].includes(completion.event)) return false;
	if ((completion.event === "match") !== (completion.job.status === "running")) return false;
	return typeof completion.completionId === "string" && completion.completionId.length > 0
		&& Number.isInteger(completion.part) && completion.part >= 0
		&& Number.isInteger(completion.sequence) && completion.sequence >= 0
		&& Number.isInteger(completion.capture?.bytes) && completion.capture.bytes >= 0
		&& typeof completion.capture?.truncated === "boolean";
}

function recordCompletions(history: History, message: any): void {
	if (message.customType === "pi-jobs-subscription-error") {
		recordWatch(history, message.details?.job);
		if (history.jobs.get(message.details?.job?.id)?.kind === "subscription") history.diagnostics.add(message.details.job.id);
	}
	if (message.customType !== "pi-jobs") return;
	for (const completion of Array.isArray(message.details?.completions) ? message.details.completions : []) {
		if (completion?.job?.kind === "subscription" && !validSubscriptionCompletion(completion)) continue;
		recordWatch(history, completion?.job);
	}
}

function recordMessage(history: History, message: any): void {
	switch (message?.role) {
		case "assistant": recordCalls(history, message.content); break;
		case "toolResult": recordResult(history, message); break;
		case "custom": recordCompletions(history, message); break;
	}
}

function readHistory(entries: readonly any[], lane: string): History {
	const history: History = { lane, calls: new Map(), params: new Map(), jobs: new Map(), diagnostics: new Set() };
	for (const entry of entries) recordMessage(history, messageOf(entry));
	return history;
}

function currentJobs(history: History): Watch[] {
	const jobs = [...history.jobs.values()];
	const newer = (a: Watch, b: Watch) => typeof a.startedAt === "number" && typeof b.startedAt === "number" && a.startedAt !== b.startedAt
		? a.startedAt > b.startedAt : jobs.indexOf(a) > jobs.indexOf(b);
	const subscriptions = jobs.filter(job => job.kind === "subscription");
	const latest = subscriptions.reduce<Watch | undefined>((last, job) => !last || newer(job, last) ? job : last, undefined);
	if (latest?.status === "running") return [latest];
	// A stopped subscription supersedes older watches, even ones still recorded as running.
	return latest ? [latest, ...jobs.filter(job => job.kind === "watch" && newer(job, latest))] : jobs;
}

function lostWatch(history: History, watches: Watch[]): { id: string; params: Params } | undefined {
	if (watches.some(job => job.status === "running")) return;
	const last = watches.at(-1);
	if (!last || last.kind !== "watch") return;
	if (!["matched", "succeeded", "failed", "timed_out"].includes(last.status)) return;
	const input = history.params.get(last.id);
	if (input) return { id: last.id, params: input };
}

/** Structured tool results + completion messages survive reload and do not require polling. */
export function lostInboxWatch(entries: readonly any[], lane: string): { id: string; params: Params } | undefined {
	const history = readHistory(entries, lane);
	return lostWatch(history, currentJobs(history));
}

function validStatusTime(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z");
}

export function parkedStatus(lane: string, env: NodeJS.ProcessEnv = process.env): "parked" | "invalid" | undefined {
	if (!/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(lane)) return "invalid";
	const dir = env.LANE_STATUS_DIR || (env.INBOX_DIR ? join(env.INBOX_DIR, "status")
		: join(homedir(), ".pi/agent/lane-status"));
	let fd: number | undefined;
	try {
		fd = openSync(join(dir, `${lane}.status`), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 4096) return "invalid";
		const buffer = Buffer.alloc(4097);
		let size = 0, count: number;
		do { count = readSync(fd, buffer, size, buffer.length - size, size); size += count; } while (count && size < buffer.length);
		if (size > 4096) return "invalid";
		const line = buffer.toString("utf8", 0, size).replace(/\n$/, "");
		if (/[\r\n]/.test(line)) return "invalid";
		const ordinary = /^(?:working|closed) since (\S+)$/.exec(line)
			?? /^closed(?: reassigned-to [A-Za-z][A-Za-z0-9_-]*)? at (\S+)(?: reason "[^"\r\n]*")?$/.exec(line);
		if (ordinary) return validStatusTime(ordinary[1]) ? undefined : "invalid";
		const m = /^(waiting-on|barred-by|parked) "[^"]*" until (\S+)$/.exec(line);
		if (!m || !validStatusTime(m[2])) return "invalid";
		return m[1] === "parked" ? "parked" : undefined;
	} catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "invalid"; }
	finally { if (fd !== undefined) closeSync(fd); }
}

export default function inboxRearm(pi: ExtensionAPI): void {
	const reminded = new Set<string>();
	const subscriptionDiagnostics = new Set<string>();
	let statusDiagnostic = false;
	pi.on("agent_before_settle", async (event, ctx) => {
		const lane = process.env.PI_LANE_ID || process.env.PI_ORCH_ID || ctx.sessionManager.getSessionName?.();
		if (!lane || !/^[A-Z][A-Za-z0-9_-]{0,31}$/.test(lane)) return;
		const status = parkedStatus(lane);
		if (status) {
			if (status === "invalid" && !statusDiagnostic) {
				statusDiagnostic = true;
				ctx.ui?.notify(`Cannot read a valid status for ${lane}; inspect lane-status before explicitly resuming inbox recovery.`, "warning");
			}
			return;
		}
		const history = readHistory([...ctx.sessionManager.getBranch(), ...event.entries], lane);
		const jobs = currentJobs(history);
		const last = jobs.at(-1);
		if (last?.kind === "subscription" && ["failed", "timed_out"].includes(last.status)
			&& !history.diagnostics.has(last.id) && !subscriptionDiagnostics.has(last.id)) {
			subscriptionDiagnostics.add(last.id);
			ctx.ui?.notify(`Inbox subscription ${last.id} for ${lane} ${last.status}; inspect pi-jobs output and explicitly reconcile before resuming. No watch was re-armed.`, "warning");
		}
		const lost = lostWatch(history, jobs);
		if (!lost || reminded.has(lost.id)) return;
		reminded.add(lost.id); // One continuation per completion: no retry loop if starting a watch is denied.
		const text = `Inbox watch ${lost.id} for ${lane} finished and no replacement is recorded. Before ending this turn, re-arm with the exact call below, then end the turn (do not poll):\njob_watch(${JSON.stringify(lost.params)})\nIf re-arming is blocked, report the blocker; do not silently drop the inbox.`;
		ctx.ui?.notify(text, "warning");
		return { continue: true, entries: [...event.entries, { type: "custom_message" as const, customType: "inbox-rearm", content: text, display: true }] };
	});
}
