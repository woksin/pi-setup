import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-questions-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 25));
	}
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readPid(path: string): number {
	return Number(readFileSync(path, "utf8").trim());
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createQuestionsExtension, type Controller, type Options } from "../src/extension.ts";
import { ask } from "../src/actions.ts";
import { validateDraft, type Asker, type Item } from "../src/model.ts";

export function gitRepo(dir: string, origin?: string): string {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", dir]);
	if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
	return dir;
}

export function asker(over: Partial<Asker> = {}): Asker {
	return { sessionId: "sess-a", cwd: "/tmp/x", repo: "o/r", pid: process.pid, ...over };
}

/** Create an item straight through the store, bypassing nothing but the tool layer. */
export function seed(home: string, draft: Record<string, unknown>, who: Partial<Asker> = {}, now = Date.now()): Item {
	const res = ask(home, validateDraft({ kind: "question", body: "", ...draft }), asker(who), now);
	if ("refused" in res) throw new Error("seed refused as duplicate");
	return res.ok.item;
}

export interface SessionOpts {
	home: string;
	root: string;
	sessionId: string;
	lane?: string;
	cwd?: string;
	hasUI?: boolean;
	now?: () => number;
	extra?: Partial<Options>;
	name?: string;
}

/** A fake pi host with one extension instance. Timers and the watcher are fakes the tests drive. */
export function session(t: { after: (fn: () => void) => void }, o: SessionOpts) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const sent: { message: any; options: any }[] = [];
	const notes: { text: string; level: string }[] = [];
	const statuses: (string | undefined)[] = [];
	const state = { idle: true, throwOnSend: false, stale: false };
	const intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];
	const watchers: { dir: string; cb: () => void; closed: boolean }[] = [];
	let controller!: Controller;
	const env = {
		PI_QUESTIONS_HOME: o.home,
		PI_CODING_AGENT_DIR: join(o.root, "agent"),
		ORCH_HOME: join(o.root, "orch"),
		...(o.lane ? { PI_ORCH_ID: o.lane } : {}),
	};
	const hasUI = o.hasUI ?? true;
	const ui = { notify: (text: string, level: string) => notes.push({ text, level }), setStatus: (_k: string, s: string | undefined) => statuses.push(s) };
	const ctx = {
		cwd: o.cwd ?? o.root,
		hasUI,
		ui,
		isIdle: () => {
			if (state.stale) throw new Error("stale runtime");
			return state.idle;
		},
		sessionManager: { getSessionId: () => o.sessionId },
	};
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		on: (event: string, fn: any) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		getSessionName: () => o.name,
		sendMessage: (message: any, options: any) => {
			sent.push({ message, options });
			if (state.throwOnSend) throw new Error("sendMessage failed: session gone");
		},
	};
	createQuestionsExtension({
		env,
		home: o.home,
		now: o.now,
		budgetDir: join(o.root, "budget"),
		debounceMs: 0,
		setInterval: (fn, ms) => {
			const h = { fn, ms, cleared: false };
			intervals.push(h);
			return h;
		},
		clearInterval: (h: any) => {
			h.cleared = true;
		},
		watch: (dir, cb) => {
			const w = { dir, cb, closed: false };
			watchers.push(w);
			return { close: () => (w.closed = true) };
		},
		onReady: c => (controller = c),
		...o.extra,
	})(pi as any);
	const emit = async (event: string, payload: unknown = {}) => {
		for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
	};
	const s = {
		tools, commands, sent, notes, statuses, state, intervals, watchers, ctx, emit,
		get controller() {
			return controller;
		},
		call: (params: any) => tools.get("user_questions").execute("c1", params, undefined, undefined, ctx),
		command: (name: string, args: string) => commands.get(name).handler(args, ctx),
		type: (text: string, source = "interactive") => emit("input", { type: "input", text, source }),
		start: () => emit("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => emit("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
	t.after(() => {
		void s.shutdown();
	});
	return s;
}

export function writeUser(root: string, githubUser: string): void {
	mkdirSync(join(root, "agent"), { recursive: true });
	writeFileSync(join(root, "agent", "user.json"), JSON.stringify({ githubUser }));
}
