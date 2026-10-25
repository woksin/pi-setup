// Local register queries and claim-delivery policy. No I/O or GitHub access.
import { basename } from "node:path";
import {
	foldRegistry, issueKey, relativeTime, REPO_RE, short, STATE_LABEL,
	type ClaimArgs, type IssueState, type IssueView, type RegistryEvent, type SessionInfo,
	type SessionLiveness, type SessionTouch,
} from "./issue-work.ts";

export const RECENT_DAYS = 14;
const DAY_MS = 86_400_000;
const REF_ERROR = "issue refs must be N, #N, OWNER/REPO#N or an issue URL";
const DELIVERED_NOTE = /(?<!\bnot )\bdelivered\b/i;
const HOLDING = new Set<IssueState>(["in-progress", "in-review"]);
const DELIVERED = new Set<IssueState>(["in-review", "done"]);
const UNFINISHED = new Set<IssueState>(["in-progress", "blocked"]);

export interface IssueRef { repo: string; issue: number }
export interface RecentSession extends SessionTouch { lastStateTs?: string; note?: string; noteTs?: string; pr?: string }
interface RegisterContext { events: RegistryEvent[]; liveness: Map<string, SessionLiveness>; now: Date; days?: number }
interface WindowOptions { events: RegistryEvent[]; key: string; now: Date; days: number }
export interface Ownership extends IssueRef {
	verdict: "OWNED" | "FREE"; reason: string; view?: IssueView; recent: RecentSession[]; days: number;
}
export interface ListFilters { all?: boolean; repo?: string; state?: IssueState; free?: boolean; days?: number }

function refText(item: unknown): string {
	if (typeof item === "string") return item;
	if (typeof item === "number") return String(item);
	return "";
}

function refParts(text: string, defaultRepo?: string): { repo?: string; number: string } {
	const bare = text.match(/^#?(\d+)$/);
	if (bare) return { repo: defaultRepo, number: bare[1] };
	const qualified = text.match(/^([^/#]+\/[^/#]+)#(\d+)$/) ?? text.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
	if (!qualified) throw new Error(REF_ERROR);
	return { repo: qualified[1], number: qualified[2] };
}

function positiveIssue(number: string): number {
	const issue = Number(number);
	if (!Number.isInteger(issue)) throw new Error(REF_ERROR);
	if (issue <= 0) throw new Error(REF_ERROR);
	return issue;
}

function parseRef(item: unknown, defaultRepo?: string): IssueRef {
	const { repo, number } = refParts(refText(item), defaultRepo);
	if (!repo) throw new Error("repo is required for bare issue refs");
	if (!REPO_RE.test(repo)) throw new Error(REF_ERROR);
	return { repo, issue: positiveIssue(number) };
}

export function parseIssueRefs(items: unknown[], defaultRepo?: string): IssueRef[] {
	if (items.length > 50) throw new Error("at most 50 issues");
	const refs = new Map<string, IssueRef>();
	for (const item of items) {
		const ref = parseRef(item, defaultRepo);
		const key = issueKey(ref.repo, ref.issue);
		if (!refs.has(key)) refs.set(key, ref);
	}
	return [...refs.values()];
}

const windowDays = (days = RECENT_DAYS) => Math.max(1, Math.min(90, Number.isFinite(days) ? Math.trunc(days) : RECENT_DAYS));
const inWindow = (ts: string | undefined, now: Date, days: number) => ts !== undefined && Date.parse(ts) >= now.getTime() - days * DAY_MS;
const sessionStatus = (liveness: Map<string, SessionLiveness>, id: string) => liveness.get(id)?.status ?? "ended";
const isHolder = (s: SessionTouch) => HOLDING.has(s.lastState!);
const sessionLabel = (s: RecentSession) => STATE_LABEL[s.lastState ?? "unknown"];
const sessionAge = (s: RecentSession, now: Date) => relativeTime(s.lastStateTs ?? s.lastTs, now);

function updateSession(s: RecentSession, e: RegistryEvent): void {
	if (e.ts > s.lastTs) s.lastTs = e.ts;
	if (e.state) { s.lastState = e.state; s.lastStateTs = e.ts; }
	if (e.source === "tool" && e.note !== undefined) { s.note = e.note; s.noteTs = e.ts; }
	for (const field of ["pr", "cwd", "branch"] as const) {
		if (e[field]) s[field] = e[field];
	}
}

export function sessionsInWindow(o: WindowOptions): RecentSession[] {
	const sessions = new Map<string, RecentSession>();
	for (const e of o.events) {
		if (issueKey(e.repo, e.issue) !== o.key) continue;
		const s = sessions.get(e.sessionId) ?? { sessionId: e.sessionId, lastTs: e.ts };
		updateSession(s, e);
		sessions.set(e.sessionId, s);
	}
	return [...sessions.values()].filter((s) => inWindow(s.lastTs, o.now, o.days));
}

function deliveredState(s: RecentSession, o: WindowOptions): boolean {
	return inWindow(s.lastStateTs, o.now, o.days) && DELIVERED.has(s.lastState!);
}

function deliveredNote(s: RecentSession, o: WindowOptions): boolean {
	return inWindow(s.noteTs, o.now, o.days) && DELIVERED_NOTE.test(s.note ?? "");
}

export function deliveries(o: WindowOptions & { excludeSessionId?: string }): RecentSession[] {
	const others = sessionsInWindow(o).filter((s) => s.sessionId !== o.excludeSessionId);
	return others.filter((s) => deliveredState(s, o) || deliveredNote(s, o));
}

function deliverySummary(s: RecentSession, o: RegisterContext): string {
	const pr = s.pr ? `, PR ${s.pr}` : "";
	return `${short(s.sessionId)} (${sessionLabel(s)} ${sessionAge(s, o.now)}, ${sessionStatus(o.liveness, s.sessionId)}, branch ${s.branch ?? "-"}${pr}, note "${(s.note ?? "").slice(0, 100)}")`;
}

function holderReason(view: IssueView, o: RegisterContext): string | undefined {
	const holders = view.sessions.filter(isHolder);
	const live = holders.find((s) => sessionStatus(o.liveness, s.sessionId) === "live");
	if (live) return `held by live session ${short(live.sessionId)} (${STATE_LABEL[live.lastState!]})`;
	const unknown = holders.find((s) => sessionStatus(o.liveness, s.sessionId) === "unknown");
	if (unknown) return `held by session ${short(unknown.sessionId)} (pid ${o.liveness.get(unknown.sessionId)!.pid}); liveness cannot be verified`;
	return undefined;
}

function deliveryReason(view: IssueView, o: RegisterContext): string | undefined {
	const found = deliveries({ ...o, key: view.key, days: windowDays(o.days) });
	if (!found.length) return undefined;
	return `delivered or in review: ${found.map((s) => deliverySummary(s, o)).join(", ")}`;
}

function unfinishedReason(view: IssueView, o: RegisterContext): string | undefined {
	if (!UNFINISHED.has(view.state)) return undefined;
	if (!inWindow(view.lastTs, o.now, windowDays(o.days))) return undefined;
	const latest = [...view.sessions].sort((a, b) => b.lastTs.localeCompare(a.lastTs))[0];
	return `ended session ${short(latest.sessionId)} left ${STATE_LABEL[view.state]} ${relativeTime(view.lastTs, o.now)}; confirm with its owner before reassigning`;
}

function pauseReason(view: IssueView, now: Date): string | undefined {
	if (view.state !== "paused") return undefined;
	if (!inWindow(view.lastTs, now, 1)) return undefined;
	return `paused ${relativeTime(view.lastTs, now)} (under 24 h)`;
}

export function ownershipOf(o: RegisterContext & { view?: IssueView }): Ownership {
	const days = windowDays(o.days);
	const view = o.view;
	if (!view) return { repo: "", issue: 0, verdict: "FREE", reason: "no register entry", recent: [], days };
	const base = { repo: view.repo, issue: view.issue, view, recent: sessionsInWindow({ ...o, key: view.key, days }), days };
	const reason = holderReason(view, o) ?? deliveryReason(view, o) ?? unfinishedReason(view, o) ?? pauseReason(view, o.now);
	if (reason) return { ...base, verdict: "OWNED", reason };
	return { ...base, verdict: "FREE", reason: `latest ${STATE_LABEL[view.state]} ${relativeTime(view.lastTs, o.now)}; no live holder and nothing delivered in the last ${days} days` };
}

const ownMark = (id: string, ownSessionId?: string) => id === ownSessionId ? " (this session)" : "";

function ownershipHeading(o: Ownership, ownSessionId?: string): string {
	const ownHolder = o.view?.sessions.filter(isHolder).some((s) => s.sessionId === ownSessionId);
	const marker = ownHolder ? " (this session)" : "";
	const title = o.view?.title ? ` | ${o.view.title.replace(/\s+/g, " ")}` : "";
	return `${o.repo}#${o.issue}: ${o.verdict} — ${o.reason}${marker}${title}`;
}

function latestLine(view: IssueView, now: Date): string {
	return `  latest: ${STATE_LABEL[view.state]} ${relativeTime(view.lastTs, now)} | branch: ${view.branch ?? "-"} | note: ${(view.note ?? "-").slice(0, 140)}`;
}

function sessionLine(s: RecentSession, o: RegisterContext & { ownSessionId?: string }): string {
	const cwd = s.cwd ? basename(s.cwd) : "-";
	return `${short(s.sessionId)}${ownMark(s.sessionId, o.ownSessionId)} ${sessionStatus(o.liveness, s.sessionId)}/${s.lastState ?? "-"} ${cwd} ${s.branch ?? "-"} ${relativeTime(s.lastTs, o.now)}`;
}

export function formatOwnership(o: Ownership, context: RegisterContext & { ownSessionId?: string }): string {
	const lines = [ownershipHeading(o, context.ownSessionId)];
	if (o.view) lines.push(latestLine(o.view, context.now));
	if (o.recent.length) lines.push(`  sessions (${o.days}d): ${o.recent.map((s) => sessionLine(s, context)).join(", ")}`);
	return lines.join("\n");
}

export function ownerResult(o: RegisterContext & { refs: IssueRef[]; ownSessionId?: string }) {
	const views = foldRegistry(o.events);
	const rows = o.refs.map((ref) => ({ ...ownershipOf({ ...o, view: views.get(issueKey(ref.repo, ref.issue)) }), ...ref }));
	return {
		text: rows.map((row) => formatOwnership(row, o)).join("\n"),
		results: rows.map(({ repo, issue, verdict, reason }) => ({ repo, issue, verdict, reason })),
	};
}

function matchesFilters(view: IssueView, filters: ListFilters): boolean {
	if (filters.repo && view.repo.toLowerCase() !== filters.repo.toLowerCase()) return false;
	if (filters.state && view.state !== filters.state) return false;
	return true;
}

function freeRow(view: IssueView, o: RegisterContext & { filters: ListFilters; extra: Map<string, string> }): boolean {
	const result = ownershipOf({ ...o, view, days: o.filters.days });
	if (o.filters.state !== "done" && result.verdict !== "FREE") return false;
	if (result.verdict === "FREE") o.extra.set(view.key, result.reason);
	return true;
}

export function filterRegister(o: RegisterContext & { views: IssueView[]; filters: ListFilters }) {
	let views = o.views.filter((v) => matchesFilters(v, o.filters));
	const extra = new Map<string, string>();
	if (o.filters.free) views = views.filter((v) => freeRow(v, { ...o, extra }));
	return { views, all: o.filters.all || o.filters.state === "done", extra };
}

interface ClaimDeliveryOptions extends RegisterContext { claim: ClaimArgs; session: SessionInfo }

export function deliveryRefusal(o: ClaimDeliveryOptions & { delivered: RecentSession[] }): string | undefined {
	if (!o.delivered.length) return undefined;
	if (o.claim.takeover) return undefined;
	return `${o.claim.repo}#${o.claim.issue} is in review or delivered by another session in the last 14 days: ${o.delivered.map((s) => deliverySummary(s, o)).join(", ")}. It is probably part of a release train or awaiting release. Do not start; report to the user or your coordinator. Only if you are continuing that session's work (handoff) or the user/coordinator confirmed, claim again with takeover: true.`;
}

function takeoverNotice(delivered: RecentSession[], now: Date): string {
	const sessions = delivered.map((s) => `${short(s.sessionId)} (${sessionLabel(s)} ${sessionAge(s, now)}, branch ${s.branch ?? "-"})`);
	return `\nTook over from ${sessions.join(", ")}.`;
}

export function claimDelivery(o: ClaimDeliveryOptions): { bypassStatus: boolean; notice: (now: Date) => string } {
	const delivered = deliveries({ ...o, key: issueKey(o.claim.repo, o.claim.issue), days: RECENT_DAYS, excludeSessionId: o.session.sessionId });
	const refusal = deliveryRefusal({ ...o, delivered });
	if (refusal) throw new Error(refusal);
	const tookOver = o.claim.takeover === true && delivered.length > 0;
	return { bypassStatus: !!o.claim.force || tookOver, notice: (now) => tookOver ? takeoverNotice(delivered, now) : "" };
}
