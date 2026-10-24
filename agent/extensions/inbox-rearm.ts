/** Re-arm reminder via public session entries; never reaches into pi-jobs' private manager. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Params = { check: string; intervalSeconds: number; timeoutSeconds: number; until?: string; cwd?: string; label?: string; checkTimeoutSeconds?: number };
type Watch = { id: string; kind: string; command: string; status: string };

function inboxCheck(check: unknown, lane: string): check is string {
	if (typeof check !== "string") return false;
	// Accept the normal direct executable form (including quoted paths and aliases), not arbitrary shell programs.
	const words = (check.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? []).map(w => w.replace(/^(['"])(.*)\1$/, "$2"));
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
	if (!/(^|\/)inbox-watch$/.test(words.shift() ?? "")) return false;
	while (words[0] === "--alias" && words.length >= 2) words.splice(0, 2);
	return words[0] === lane;
}

type History = { lane: string; calls: Map<string, Params>; params: Map<string, Params>; jobs: Map<string, Watch> };

function messageOf(entry: any): any {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") return { ...entry, role: "custom" };
}

function recordWatch(history: History, job: Watch | undefined): void {
	if (job?.kind !== "watch") return;
	if (typeof job.id !== "string") return;
	if (inboxCheck(job.command, history.lane)) history.jobs.set(job.id, job);
}

function recordCalls(history: History, content: any): void {
	const calls = Array.isArray(content) ? content : [];
	for (const call of calls) {
		if (call.type !== "toolCall") continue;
		if (call.name !== "job_watch") continue;
		if (inboxCheck(call.arguments?.check, history.lane)) history.calls.set(call.id, call.arguments);
	}
}

function recordResult(history: History, message: any): void {
	if (!["job_watch", "job_list", "job_output", "job_kill"].includes(message.toolName)) return;
	recordWatch(history, message.details);
	for (const job of message.details?.jobs ?? []) recordWatch(history, job);
	if (message.toolName !== "job_watch") return;
	const input = history.calls.get(message.toolCallId);
	if (!input) return;
	if (typeof message.details?.id === "string") history.params.set(message.details.id, input);
}

function recordCompletions(history: History, message: any): void {
	if (message.customType !== "pi-jobs") return;
	for (const completion of message.details?.completions ?? []) recordWatch(history, completion?.job);
}

function recordMessage(history: History, message: any): void {
	switch (message?.role) {
		case "assistant": recordCalls(history, message.content); break;
		case "toolResult": recordResult(history, message); break;
		case "custom": recordCompletions(history, message); break;
	}
}

/** Structured tool results + completion messages survive reload and do not require polling. */
export function lostInboxWatch(entries: readonly any[], lane: string): { id: string; params: Params } | undefined {
	const history: History = { lane, calls: new Map(), params: new Map(), jobs: new Map() };
	for (const entry of entries) recordMessage(history, messageOf(entry));
	const watches = [...history.jobs.values()];
	if (watches.some(job => job.status === "running")) return;
	const last = watches.at(-1);
	if (!last) return;
	if (!["matched", "succeeded", "failed", "timed_out"].includes(last.status)) return;
	const input = history.params.get(last.id);
	if (input) return { id: last.id, params: input };
}

export default function inboxRearm(pi: ExtensionAPI): void {
	const reminded = new Set<string>();
	pi.on("agent_before_settle", async (event, ctx) => {
		const lane = process.env.PI_LANE_ID || ctx.sessionManager.getSessionName?.();
		if (!lane || !/^[A-Z][A-Za-z0-9_-]{0,31}$/.test(lane)) return;
		const lost = lostInboxWatch([...ctx.sessionManager.getBranch(), ...event.entries], lane);
		if (!lost || reminded.has(lost.id)) return;
		reminded.add(lost.id); // One continuation per completion: no retry loop if starting a watch is denied.
		const text = `Inbox watch ${lost.id} for ${lane} finished and no replacement is recorded. Before ending this turn, re-arm with the exact call below, then end the turn (do not poll):\njob_watch(${JSON.stringify(lost.params)})\nIf re-arming is blocked, report the blocker; do not silently drop the inbox.`;
		ctx.ui?.notify(text, "warning");
		return { continue: true, entries: [...event.entries, { type: "custom_message" as const, customType: "inbox-rearm", content: text, display: true }] };
	});
}
