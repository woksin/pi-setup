/**
 * pi extension: the `user_questions` tool, the user commands, delivery of answers back to the asking
 * session, a heartbeat, and a status line. Never prompts for approval and never blocks other tools.
 */
import { mkdirSync, readFileSync, watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as actions from "./actions.ts";
import { completeDecide, completeIds, completeQ, parseAnswer, parseClose, parseDecide, parseDefer, parseQ, parseQuestions } from "./commands.ts";
import { Deliverer, pending, type Entry, type LiveSession } from "./delivery.ts";
import { possibleDuplicates } from "./dedup.ts";
import { renderCandidates, renderItem, renderList, renderRecord, statusText, noticeText } from "./format.ts";
import { laneOf, liveness, orchHome, repoOf, userName } from "./identity.ts";
import { laneWarnings } from "./lane-warnings.ts";
import { clearLane, setLane } from "./lanes.ts";
import { isOwn, validateDraft, validateOptions, URGENCIES, type Actor, type Asker, type Item } from "./model.ts";
import { counts, searchItems, selectItems, type Who } from "./query.ts";
import {
	claimReceipt, itemsDir, listItems, readSessions, receiptName, receiptNames, removeHeartbeat,
	removeReceipt, resolveHome, writeHeartbeat,
} from "./store.ts";
import { InputRing } from "./verbatim.ts";

export const CUSTOM_TYPE = "user-question";

interface Handle { close?: () => void }

export interface Options {
	env?: Record<string, string | undefined>;
	home?: string;
	now?: () => number;
	watch?: (dir: string, onChange: () => void) => Handle;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (h: unknown) => void;
	pollMs?: number;
	heartbeatMs?: number;
	debounceMs?: number;
	budgetDir?: string;
	onReady?: (controller: Controller) => void;
}

export interface Controller {
	/** Run one delivery and status pass now (what the watcher, the poll timer and agent_end do). */
	poll(orphanOk?: boolean): void;
	readonly ring: InputRing;
}

function handoffActive(sessionId: string, root: string): boolean {
	try {
		const s = JSON.parse(readFileSync(join(root, `${sessionId}.json`), "utf8"));
		return !s.projected && ["handoff-required", "handoff-pending-commit", "compacting", "fallback-armed"].includes(s.phase);
	} catch {
		return false;
	}
}

const text = (t: string, details: unknown) => ({ content: [{ type: "text" as const, text: t }], details });
const compact = (i: Item) => ({ id: i.id, kind: i.kind, status: i.status, title: i.title, repo: i.repo, urgency: i.urgency, asker: i.asker.lane ?? i.asker.sessionId });

const str = { type: "string" };
const strList = { type: "array", items: str };
const PARAMETERS = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["ask", "list", "get", "search", "update", "comment", "withdraw", "supersede", "close", "record_answer"] },
		id: { type: "string", description: "Q-42, q42 or 42" },
		kind: { type: "string", enum: ["question", "decision", "approval", "fyi"] },
		title: { type: "string", description: "At most 120 characters" },
		body: { type: "string", description: "Plain text, at most 4000 characters" },
		options: { type: "array", items: { type: "object", properties: { key: str, text: str }, required: ["key", "text"] } },
		recommended: { type: "string", description: "Key of the recommended option" },
		urgency: { type: "string", enum: [...URGENCIES] },
		blocking: { type: "string", description: "What is waiting on this. Non-empty means blocking." },
		links: strList,
		tags: strList,
		cc: { ...strList, description: "Lane ids or session ids that should also get the answer" },
		for: { ...strList, maxItems: 5, description: "ask: lane ids or session ids to wake; the asker gets a notice instead" },
		global: { type: "boolean", description: "Not tied to the current repo" },
		project: { type: "string", description: "Free-text tag grouping work across repos" },
		distinctFrom: { ...strList, description: "ask: ids of every duplicate candidate, to create anyway" },
		status: { type: "string", enum: ["open", "answered", "decided", "deferred", "withdrawn", "superseded", "closed", "all"] },
		repo: { type: "string", description: "Owner/Name" },
		all: { type: "boolean", description: "list: every repo, with the asker lane on each item" },
		mine: { type: "boolean", description: "list: only your own items" },
		query: str,
		tag: str,
		format: { type: "string", enum: ["text", "record"] },
		text: { type: "string", description: "comment text" },
		reason: str,
		by: { type: "string", description: "supersede: id of the replacing item" },
		note: str,
		quote: { type: "string", description: "record_answer: the user's exact words from this chat" },
		option: { type: "string", description: "record_answer: key of the chosen option" },
	},
	required: ["action"],
};

const DESCRIPTION = [
	"The user's queue of questions and decisions, kept in one durable store and answered back to the asking session.",
	"Search before asking (action search, covers decided and closed items). Ask with action ask; never ask in chat only.",
	"A near-duplicate is refused: comment on it, add yourself to cc, use its answer, or pass distinctFrom with all candidate ids.",
	"After ask, end your turn: the answer arrives as a woken follow-up. Do not poll.",
	"record_answer only with the user's exact words typed in THIS session's chat. Never paraphrase and never relay.",
	"Actions: ask, list (default: open items here; all:true for every repo; project filter), get (format record for a decision record),",
	"search, update (own open items; links on any), comment, withdraw, supersede, close (own answered/decided/fyi items), record_answer.",
	"Subagents can only list, get and search.",
].join(" ");

export function createQuestionsExtension(opts: Options = {}) {
	return function questionsExtension(pi: any): void {
		const env = opts.env ?? process.env;
		const home = opts.home ?? resolveHome(env);
		const clock = opts.now ?? Date.now;
		const orch = orchHome(env);
		const budgetDir = opts.budgetDir ?? join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "context-budget", "status");
		const setIv = opts.setInterval ?? ((fn: () => void, ms: number) => {
			const h = setInterval(fn, ms);
			h.unref();
			return h;
		});
		const clearIv = opts.clearInterval ?? ((h: unknown) => clearInterval(h as any));
		const watch = opts.watch ?? ((dir: string, cb: () => void) => fsWatch(dir, { persistent: false, recursive: true }, cb));

		const ring = new InputRing();
		let latest: any;
		let sessionId = "";
		let deliverer: Deliverer | undefined;
		let timers: unknown[] = [];
		let watcher: Handle | undefined;
		let debounce: ReturnType<typeof setTimeout> | undefined;
		let runActive = false;
		let heartbeatOn = false;

		const identity = (ctx: any) => {
			const sid: string = ctx.sessionManager.getSessionId();
			let name: string | undefined;
			try {
				name = pi.getSessionName?.();
			} catch {
				name = undefined;
			}
			return { sessionId: sid, lane: laneOf(env, sid, name, orch, home), repo: repoOf(ctx.cwd), cwd: ctx.cwd as string };
		};
		const whoOf = (me: { sessionId: string; lane?: string; repo: string | null }): Who => me;

		// Delivery and status

		function safeIdle(): boolean {
			try {
				return !!latest?.isIdle();
			} catch {
				return false;
			}
		}

		function beat(): void {
			try {
				const m = identity(latest);
				writeHeartbeat(home, { sessionId: m.sessionId, pid: process.pid, lane: m.lane, repo: m.repo, cwd: m.cwd, at: new Date(clock()).toISOString() });
			} catch {
				// Best effort.
			}
		}

		function entriesFor(orphanOk: boolean): { entries: Entry[]; items: Item[]; me: Who } {
			beat(); // External lane mappings take effect on every delivery pass.
			const me = whoOf(identity(latest));
			const { items } = listItems(home);
			const now = clock();
			const live: LiveSession[] = readSessions(home)
				.filter(s => liveness(s, s.mtimeMs, now))
				.map(s => ({ sessionId: s.sessionId, lane: s.lane }));
			const entries = pending(items, me, live, receiptNames(home), now, { orphanOk, receiptName });
			return { entries, items, me };
		}

		function updateStatus(items: Item[], entries: Entry[], me: Who, held = false): void {
			if (!latest?.hasUI) return; // subagents get no status line
			const active = selectItems(items, {}, me, clock());
			const answers = entries.filter(e => e.mode === "wake" && (e.h.type === "answered" || e.h.type === "decided"));
			const forLane = (e: Entry) => !!me.lane && e.recipient === `for:${me.lane}`;
			const answered = new Set(answers.filter(e => !forLane(e)).map(e => e.item.id)).size;
			const answeredForLane = new Set(answers.filter(forLane).map(e => e.item.id)).size;
			try {
				latest.ui.setStatus("questions", statusText({ ...counts(active), answered, answeredForLane, lane: me.lane, held }));
			} catch {
				// Stale context: the next session_start sets it again.
			}
		}

		function poll(orphanOk?: boolean): void {
			if (!latest?.hasUI || !deliverer || deliverer.isDisposed) return;
			try {
				const first = entriesFor(orphanOk ?? safeIdle());
				const sent = deliverer.deliver(first.entries);
				const after = sent ? entriesFor(false) : first;
				updateStatus(after.items, after.entries, after.me, after.entries.length > 0 && deliverer.held);
			} catch {
				// A poll must never throw into a timer or an event handler.
			}
		}

		function schedulePoll(): void {
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => poll(), opts.debounceMs ?? 500);
			debounce.unref?.();
		}

		function stop(): void {
			for (const t of timers) clearIv(t);
			timers = [];
			if (debounce) clearTimeout(debounce);
			debounce = undefined;
			try {
				watcher?.close?.();
			} catch {
				// Already closed.
			}
			watcher = undefined;
			deliverer?.dispose();
			deliverer = undefined;
			if (heartbeatOn && sessionId) removeHeartbeat(home, sessionId);
			heartbeatOn = false;
		}

		function start(ctx: any): void {
			stop();
			latest = ctx;
			runActive = false;
			if (!ctx.hasUI) return; // subagents neither deliver nor appear as live sessions
			const me = identity(ctx);
			sessionId = me.sessionId;

			beat();
			heartbeatOn = true;
			deliverer = new Deliverer(
				{
					isIdle: () => latest.isIdle(),
					runActive: () => runActive,
					handoffActive: () => handoffActive(sessionId, budgetDir),
					send: (m, mode) => {
						pi.sendMessage(
							{ customType: CUSTOM_TYPE, content: m.content, display: true, details: m.details },
							mode === "wake" ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "nextTurn" },
						);
						if (mode === "notice") {
							latest.ui.notify(noticeText((m.details as any).entries), "info");
						}
					},
				},
				e => claimReceipt(home, e.item.id, e.h.seq, e.recipient, sessionId),
				e => removeReceipt(home, e.item.id, e.h.seq, e.recipient),
			);
			try {
				mkdirSync(itemsDir(home), { recursive: true });
				watcher = watch(itemsDir(home), schedulePoll);
			} catch {
				watcher = undefined; // the poll covers it
			}
			timers.push(setIv(() => poll(), opts.pollMs ?? 20_000), setIv(beat, opts.heartbeatMs ?? 30_000));
			poll(true);
		}

		opts.onReady?.({ poll: o => poll(o), ring });

		// Events

		pi.on("input", (event: any) => {
			ring.push(String(event.text ?? ""), event.source);
		});
		pi.on("session_start", (_e: unknown, ctx: any) => start(ctx));
		pi.on("agent_start", () => {
			runActive = true;
			deliverer?.release("tree"); // a run cannot start during summarisation: a cancelled navigation ends here
		});
		pi.on("agent_end", (_e: unknown, ctx: any) => {
			latest = ctx ?? latest;
			poll();
		});
		pi.on("agent_settled", (_e: unknown, ctx: any) => {
			latest = ctx ?? latest;
			runActive = false;
			poll();
		});
		// Holds end only with their end event, never because time passed. A stuck hold shows in the status line.
		pi.on("session_before_compact", () => deliverer?.hold("compaction"));
		const ended = (name: string) => (_e: unknown, ctx: any) => {
			latest = ctx ?? latest;
			deliverer?.release(name);
			poll();
		};
		pi.on("session_compact", ended("compaction"));
		pi.on("session_compact_failed", ended("compaction"));
		pi.on("session_before_tree", () => deliverer?.hold("tree"));
		pi.on("session_tree", ended("tree"));
		pi.on("session_shutdown", () => stop());

		// Tool

		const asUser = (me: { sessionId: string; lane?: string }): Actor => ({ kind: "user", sessionId: me.sessionId, lane: me.lane, name: userName(env) });
		const asAgent = (me: { sessionId: string; lane?: string }): Actor => ({ kind: "agent", sessionId: me.sessionId, lane: me.lane });

		pi.registerTool({
			name: "user_questions",
			label: "User questions",
			description: DESCRIPTION,
			promptSnippet: "user_questions: search, then ask the user questions and decisions; answers come back as a follow-up",
			parameters: PARAMETERS,
			async execute(_id: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
				latest = ctx;
				const action: string = params.action;
				const me = identity(ctx);
				const now = clock();
				if (!["list", "get", "search"].includes(action) && !ctx.hasUI) {
					throw new Error(`user_questions ${action} is only available in the main session. Report the question or answer to your parent session instead.`);
				}
				const own = (item: Item) => isOwn(item, me);
				const need = (v: unknown, name: string): string => {
					if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
					return v.trim();
				};
				const one = (item: Item, head: string) => text(`${head}\n${renderItem(item, now)}`, { item });

				switch (action) {
					case "ask": {
						const draft = validateDraft(params);
						const asker: Asker = { sessionId: me.sessionId, lane: me.lane, cwd: me.cwd, repo: me.repo, pid: process.pid };
						const res = actions.ask(home, draft, asker, now);
						if ("refused" in res) {
							const r = res.refused;
							throw new Error([
								"Not created: possible duplicate of existing items.",
								renderCandidates(r.candidates, r.nearMisses),
								"Instead: comment on it (action comment), add yourself to cc (action update with cc), or, if it is decided or answered, use that answer.",
								`If this is really a different question, ask again with distinctFrom: [${r.candidates.map(c => c.item.id).join(", ")}].`,
							].join("\n"));
						}
						const { item, nearMisses } = res.ok;
						const note = "The answer will arrive as a follow-up message. End your turn if you are waiting; do not poll.";
						return text(`Created ${item.id}: ${item.title}\n${note}`, {
							item,
							nearMisses: nearMisses.map(n => ({ id: n.item.id, title: n.item.title, score: Number(n.score.toFixed(2)) })),
						});
					}
					case "list": {
						const status = params.status;
						const { items, warnings } = listItems(home);
						const picked = selectItems(items, { status, repo: params.repo, all: !!params.all, mine: !!params.mine, project: params.project }, me, now);
						const out = renderList(picked, { now, showAsker: !!params.all, warnings, empty: "No matching items.", duplicates: possibleDuplicates(items) });
						return text(out, { items: picked.map(compact), warnings });
					}
					case "get": {
						const item = actions.getItem(home, need(params.id, "id"));
						return text(params.format === "record" ? renderRecord(item) : renderItem(item, now, possibleDuplicates(listItems(home).items).get(item.id)), { item });
					}
					case "search": {
						const { items, warnings } = listItems(home);
						const hits = searchItems(items, { query: need(params.query, "query"), status: params.status === "all" ? undefined : params.status, kind: params.kind, repo: params.repo, tag: params.tag });
						return text(renderList(hits, { now, showAsker: true, warnings, empty: "No matching items." }), { items: hits.map(i => ({ ...compact(i), answer: i.answer?.text })) });
					}
					case "update": {
						const id = need(params.id, "id");
						const item = actions.getItem(home, id);
						const patch = {
							title: params.title, body: params.body, options: params.options, urgency: params.urgency,
							blocking: params.blocking, links: params.links, tags: params.tags, cc: params.cc,
						};
						if (patch.urgency !== undefined && !(URGENCIES as readonly string[]).includes(patch.urgency)) throw new Error(`urgency must be one of: ${URGENCIES.join(", ")}`);
						if (patch.options !== undefined) validateOptions(patch.options);
						if (own(item)) {
							const done = actions.updateItem(home, id, asAgent(me), patch, now);
							return one(done, done.id === item.id ? `Updated ${item.id}.` : `${item.id} is superseded; forwarded to ${done.id}.`);
						}
						const extra = Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "links" && k !== "cc").map(([k]) => k);
						if (extra.length) throw new Error(`${item.id} was asked by another session; you may only add links or add yourself to cc (not ${extra.join(", ")}).`);
						let updated = item;
						if (patch.links?.length) updated = actions.addLinks(home, id, asAgent(me), patch.links, now);
						for (const c of patch.cc ?? []) {
							if (c !== me.sessionId && c !== me.lane) throw new Error("you may only add yourself (your session id or lane) to cc on another session's item");
							updated = actions.addCc(home, id, asAgent(me), c, now);
						}
						if (updated === item) throw new Error("nothing to update");
						return one(updated, updated.id === item.id ? `Updated ${item.id}.` : `${item.id} is superseded; forwarded to ${updated.id}.`);
					}
					case "comment":
						return one(actions.commentItem(home, need(params.id, "id"), asAgent(me), need(params.text, "text"), now), "Comment added.");
					case "withdraw":
					case "supersede":
					case "close": {
						const id = need(params.id, "id");
						const item = actions.getItem(home, id);
						if (!own(item)) throw new Error(`${item.id} was asked by another session; only its asker (same session or lane) can ${action} it.`);
						if (action === "withdraw") return one(actions.withdrawItem(home, id, asAgent(me), need(params.reason, "reason"), now), `Withdrew ${item.id}.`);
						if (action === "supersede") return one(actions.supersedeItem(home, id, asAgent(me), need(params.by, "by"), now), `Superseded ${item.id}.`);
						if (item.status !== "answered" && item.status !== "decided" && item.kind !== "fyi") {
							throw new Error(`${item.id} is ${item.status}: close applies to answered or decided items, or fyi. Use withdraw if it is no longer needed.`);
						}
						return one(actions.closeItem(home, id, asAgent(me), params.note, now), `Closed ${item.id}.`);
					}
					case "record_answer": {
						const id = need(params.id, "id");
						const quote = need(params.quote, "quote");
						const source = ring.match(quote);
						if (!source) {
							throw new Error("That quote is not in the user's input in this session. record_answer accepts only the user's exact words typed in this chat; text relayed from message files, tools or other sessions never counts. Ask the user, or let them use /answer.");
						}
						const updated = actions.answerItem(home, id, asUser(me), { text: quote, by: userName(env), via: "quote", source, option: params.option }, now);
						return one(updated, `Recorded the user's answer on ${updated.id}. It is delivered to the asking session.`);
					}
					default:
						throw new Error(`unknown action "${action}"`);
				}
			},
		});

		// Commands

		const notify = (ctx: any, msg: string, level = "info") => ctx.ui.notify(msg, level);
		const guarded = (fn: (args: string, ctx: any) => void | Promise<void>) => async (args: string, ctx: any) => {
			latest = ctx;
			try {
				await fn(args, ctx);
			} catch (e: any) {
				notify(ctx, e.message, "error");
			}
		};
		const completions = (complete: (items: ReturnType<typeof listItems>["items"], prefix: string) => { value: string; label: string }[] | null) =>
			(prefix: string) => {
				const found = complete(listItems(home).items, prefix);
				return found ? found.map(f => ({ value: f.value, label: f.label })) : null;
			};
		const idCompletions = completions((items, prefix) => completeIds(items, prefix));
		const listFor = (ctx: any, f: Parameters<typeof selectItems>[1], heading: string, showAsker = false) => {
			const me = whoOf(identity(ctx));
			const { items, warnings } = listItems(home);
			notify(ctx, renderList(selectItems(items, f, me, clock()), { now: clock(), showAsker, warnings, heading, empty: "No matching items.", duplicates: possibleDuplicates(items) }));
		};

		function setSessionLane(ctx: any, lane: string): void {
			if (env.PI_ORCH_ID) {
				notify(ctx, `PI_ORCH_ID=${env.PI_ORCH_ID} takes precedence; no lane mapping was written.`, "warning");
				return;
			}
			const me = identity(ctx);
			setLane(home, me.sessionId, lane, me.sessionId);
			for (const warning of laneWarnings(home, { sessionId: me.sessionId, lane })) notify(ctx, warning, "warning");
			poll();
			notify(ctx, `Lane: ${lane}`);
		}

		pi.registerCommand("lane", {
			description: "Show or set lane identity: /lane [ID|clear]",
			handler: guarded((args, ctx) => {
				if (!ctx.hasUI) throw new Error("/lane is only available in the main session");
				const id = args.trim();
				const me = identity(ctx);
				if (id === "clear") clearLane(home, me.sessionId);
				else if (id) {
					setSessionLane(ctx, id);
					return;
				}
				poll();
				const lane = identity(ctx).lane;
				notify(ctx, lane ? `Lane: ${lane}` : "No lane identity set.");
			}),
		});

		pi.registerCommand("questions", {
			description: "List open questions for the user: /questions [all|decided|repo|search <terms>]",
			handler: guarded((args, ctx) => {
				const parsed = parseQuestions(args);
				if ("error" in parsed) return notify(ctx, parsed.error, "error");
				const p = parsed.ok;
				const me = identity(ctx);
				if (p.mode === "open") return listFor(ctx, {}, "Open questions");
				if (p.mode === "all") return listFor(ctx, { all: true }, "Open questions, every repo", true);
				if (p.mode === "decided") return listFor(ctx, { status: "decided" }, "Decided");
				if (p.mode === "repo") return listFor(ctx, { repo: me.repo ?? undefined, all: !me.repo }, `Open questions in ${me.repo ?? "any repo"}`);
				const { items, warnings } = listItems(home);
				notify(ctx, renderList(searchItems(items, { query: p.terms }), { now: clock(), showAsker: true, warnings, heading: `Search: ${p.terms}`, empty: "No matching items." }));
			}),
		});

		const userOp = (args: string, ctx: any, parsed: ReturnType<typeof parseQ>): void => {
			if ("error" in parsed) return notify(ctx, parsed.error, "error");
			const me = identity(ctx);
			const a = parsed.ok;
			const actor = asUser(me);
			const by = userName(env);
			const now = clock();
			let item: Item;
			switch (a.op) {
				case "show": {
					const shown = actions.getItem(home, a.id);
					return notify(ctx, renderItem(shown, now, possibleDuplicates(listItems(home).items).get(shown.id)));
				}
				case "reopen": item = actions.reopenItem(home, a.id, actor, now); break;
				case "comment": item = actions.commentItem(home, a.id, actor, a.text, now); break;
				case "answer": item = actions.answerItem(home, a.id, actor, { text: a.text, by, via: "command" }, now); break;
				case "decide": item = actions.decideItem(home, a.id, actor, by, a.option, a.text, now); break;
				case "defer": item = actions.deferItem(home, a.id, actor, a.until, a.text || undefined, now); break;
				case "close": item = actions.closeItem(home, a.id, actor, a.text || undefined, now); break;
			}
			notify(ctx, `${item.id} is now ${item.status}${item.deferredUntil ? ` until ${item.deferredUntil.slice(0, 10)}` : ""}.`);
		};

		pi.registerCommand("q", {
			description: "Show or act on one item: /q <id> [reopen|comment <text>|answer|decide|defer|close]",
			getArgumentCompletions: completions(completeQ),
			handler: guarded((args, ctx) => userOp(args, ctx, parseQ(args))),
		});
		pi.registerCommand("answer", {
			description: "Answer a question: /answer <id> <text>",
			getArgumentCompletions: idCompletions,
			handler: guarded((args, ctx) => userOp(args, ctx, parseAnswer(args))),
		});
		pi.registerCommand("decide", {
			description: "Decide: /decide <id> <option key or number> [rationale]",
			getArgumentCompletions: completions(completeDecide),
			handler: guarded((args, ctx) => userOp(args, ctx, parseDecide(args))),
		});
		pi.registerCommand("defer", {
			description: "Defer: /defer <id> [YYYY-MM-DD] [reason]",
			getArgumentCompletions: idCompletions,
			handler: guarded((args, ctx) => userOp(args, ctx, parseDefer(args))),
		});
		pi.registerCommand("close", {
			description: "Close an item: /close <id> [reason]",
			getArgumentCompletions: idCompletions,
			handler: guarded((args, ctx) => userOp(args, ctx, parseClose(args))),
		});
	};
}

export default createQuestionsExtension();
