import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	LockTimeoutError, blockingMark, clearForSelection, clearOnSuccess, clearProvider, interpret, limitScope, liveMarks, markKeyFor, merge, readMarks, updateMarks, withMarksLock,
	type Classify, type RawMarks,
} from "./provider-limit-marks.ts";

const NOW = 1_000_000;
const HOUR = 3_600_000;
const classify: Classify = (provider, text) => limitScope({}, provider, text);
const live = (extra: object = {}) => ({ until: NOW + HOUR, since: NOW - 1000, ...extra });

test("limitScope: quota/usage/billing text is account-wide; rate_limit_error and 429 are model-scoped; config patterns extend", () => {
	assert.equal(limitScope({}, "anthropic", "rate_limit_error: exceed your account's rate limit"), "model");
	assert.equal(limitScope({}, "anthropic", "429 Too Many Requests"), "model");
	assert.equal(limitScope({}, "anthropic", "You hit your usage limit"), "account");
	assert.equal(limitScope({}, "openai", "insufficient_quota"), "account");
	assert.equal(limitScope({}, "openai", "Your credit balance is too low"), "account");
	assert.equal(limitScope({ accountWidePatterns: { kimi: ["weekly cap"] } }, "kimi", "Weekly CAP reached"), "account");
	assert.equal(limitScope({ accountWidePatterns: { kimi: ["weekly cap"] } }, "anthropic", "weekly cap"), "model");
	assert.equal(limitScope({ accountWidePatterns: { kimi: ["("] } }, "kimi", "boom"), "model"); // bad regex ignored
});

test("interpret: key with a slash is model scope; scope:account provider key is account scope", () => {
	assert.deepEqual(interpret("anthropic/s", live(), classify), { key: "anthropic/s", provider: "anthropic", ref: "anthropic/s", scope: "model", until: NOW + HOUR, since: NOW - 1000 });
	assert.equal(interpret("anthropic", live({ scope: "account", model: "anthropic/s", reason: "429" }), classify).scope, "account");
});

test("interpret: legacy entry narrows to its model only for a plain rate limit naming a model of that provider", () => {
	const legacy = (extra: object) => interpret("anthropic", live(extra), classify);
	assert.equal(legacy({ model: "anthropic/s", reason: "rate_limit_error: slow down" }).ref, "anthropic/s");
	assert.equal(legacy({ model: "anthropic/s", reason: "HTTP 429" }).scope, "model");
	assert.equal(legacy({ model: "anthropic/s", reason: "429 overloaded_error" }).scope, "account"); // outage
	assert.equal(legacy({ model: "anthropic/s", reason: "503 service unavailable" }).scope, "account");
	assert.equal(legacy({ model: "anthropic/s", reason: "usage limit reached, 429" }).scope, "account"); // quota
	assert.equal(legacy({ model: "anthropic/s", reason: "something odd" }).scope, "account"); // unknown
	assert.equal(legacy({ reason: "rate_limit_error" }).scope, "account"); // no model
	assert.equal(legacy({ model: "openai/x", reason: "rate_limit_error" }).scope, "account"); // other provider's model
	assert.equal(legacy({ model: "anthropic/s" }).scope, "account"); // no reason
});

test("blockingMark: account mark blocks every model of the provider; model mark only its model; latest until wins", () => {
	const raw: RawMarks = { "anthropic/s": live(), openai: live({ scope: "account" }) };
	assert.equal(blockingMark(raw, "anthropic/s", NOW, classify)?.key, "anthropic/s");
	assert.equal(blockingMark(raw, "anthropic/o", NOW, classify), undefined);
	assert.equal(blockingMark(raw, "openai/x", NOW, classify)?.key, "openai");
	const both: RawMarks = { anthropic: live({ scope: "account", until: NOW + 10 }), "anthropic/o": live({ until: NOW + 99 }) };
	assert.equal(blockingMark(both, "anthropic/o", NOW, classify)?.key, "anthropic/o");
	assert.equal(blockingMark({ "anthropic/s": live({ until: NOW - 1 }) }, "anthropic/s", NOW, classify), undefined); // expired
	assert.equal(blockingMark({ junk: null as never }, "x/y", NOW, classify), undefined);
});

test("blockingMark: legacy provider-wide entry blocks only its model when narrowed, whole provider otherwise", () => {
	const narrow: RawMarks = { anthropic: live({ model: "anthropic/s", reason: "rate_limit_error" }) };
	assert.ok(blockingMark(narrow, "anthropic/s", NOW, classify));
	assert.equal(blockingMark(narrow, "anthropic/o", NOW, classify), undefined);
	assert.ok(blockingMark({ anthropic: live() }, "anthropic/o", NOW, classify)); // legacy without model
});

test("markKeyFor and merge: later until kept, expired pruned, unknown keys preserved", () => {
	assert.equal(markKeyFor("account", "anthropic", "anthropic/s"), "anthropic");
	assert.equal(markKeyFor("model", "anthropic", "anthropic/s"), "anthropic/s");
	const raw: RawMarks = { old: live({ until: NOW - 1 }), "anthropic/s": live({ until: NOW + 9 * HOUR }), legacy: live({ model: "x/y" }) };
	const next = merge(raw, "anthropic/s", live({ until: NOW + 1 }), NOW);
	assert.equal(next["anthropic/s"].until, NOW + 9 * HOUR);
	assert.equal(next.old, undefined);
	assert.equal(next.legacy.model, "x/y");
	assert.deepEqual(Object.keys(liveMarks(raw, NOW)).sort(), ["anthropic/s", "legacy"]);
});

test("clearProvider removes the provider key and its model keys only", () => {
	const raw: RawMarks = { anthropic: live(), "anthropic/s": live(), "anthropic-x/y": live(), kimi: live() };
	assert.deepEqual(Object.keys(clearProvider(raw, "anthropic")).sort(), ["anthropic-x/y", "kimi"]);
});

test("clearForSelection: account, own model and blocking legacy keys go; sibling models stay", () => {
	const raw: RawMarks = {
		anthropic: live({ scope: "account" }), "anthropic/a": live(), "anthropic/b": live(), kimi: live(),
	};
	assert.deepEqual(Object.keys(clearForSelection(raw, "anthropic/a", classify)).sort(), ["anthropic/b", "kimi"]);
	const legacySibling: RawMarks = { anthropic: live({ model: "anthropic/b", reason: "rate_limit_error" }) };
	assert.deepEqual(Object.keys(clearForSelection(legacySibling, "anthropic/a", classify)), ["anthropic"]);
	assert.deepEqual(clearForSelection({ anthropic: live() }, "anthropic/a", classify), {}); // legacy provider-wide blocks it
});

test("clearOnSuccess drops only marks older than the request start", () => {
	const raw: RawMarks = { anthropic: live({ scope: "account", since: NOW - 5 }), "anthropic/a": live({ since: NOW + 5 }), "anthropic/b": live({ since: 0 }) };
	assert.deepEqual(Object.keys(clearOnSuccess(raw, "anthropic/a", NOW, classify)).sort(), ["anthropic/a", "anthropic/b"]);
});

test("updateMarks: locked read-modify-write; a fresh mark written meanwhile is not erased by a stale success", () => {
	const dir = mkdtempSync(join(tmpdir(), "plm-"));
	const path = join(dir, "marks.json");
	writeFileSync(path, JSON.stringify({ "anthropic/a": live({ since: NOW - 10 }) }));
	// success commit begins (request started at NOW): another writer records a fresh 429 first
	updateMarks(path, (raw) => merge(raw, "anthropic/a", live({ since: NOW + 5, until: NOW + 2 * HOUR }), NOW));
	updateMarks(path, (raw) => clearOnSuccess(raw, "anthropic/a", NOW, classify));
	assert.equal(readMarks(path)["anthropic/a"].since, NOW + 5);
	assert.equal(existsSync(`${path}.lock`), false);
});

test("withMarksLock: serializes (a held lock is waited on or taken over once stale) and always releases", () => {
	const dir = mkdtempSync(join(tmpdir(), "plm-"));
	const path = join(dir, "marks.json");
	writeFileSync(`${path}.lock`, "");
	const old = (Date.now() - 60_000) / 1000;
	utimesSync(`${path}.lock`, old, old);
	assert.equal(withMarksLock(path, () => existsSync(`${path}.lock`)), true); // stale lock replaced by ours
	assert.equal(existsSync(`${path}.lock`), false);
	assert.throws(() => withMarksLock(path, () => { throw new Error("x"); }), /x/);
	assert.equal(existsSync(`${path}.lock`), false);
	writeFileSync(path, "not json");
	assert.deepEqual(readMarks(path), {});
	assert.equal(readFileSync(path, "utf8"), "not json");
});

test("lock timeout: a destructive update throws and deletes nothing; an additive one keeps other sessions' marks and is logged", () => {
	const dir = mkdtempSync(join(tmpdir(), "plm-"));
	const path = join(dir, "marks.json");
	writeFileSync(path, JSON.stringify({ kimi: live(), "anthropic/a": live() }));
	writeFileSync(`${path}.lock`, ""); // fresh lock held by someone else
	assert.throws(() => updateMarks(path, (raw) => clearProvider(raw, "kimi")), LockTimeoutError);
	assert.deepEqual(Object.keys(readMarks(path)).sort(), ["anthropic/a", "kimi"]);
	const logged: unknown[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => void logged.push(args);
	try {
		updateMarks(path, (raw) => ({ ...clearProvider(raw, "kimi"), "openai/b": live() }), { additive: true });
	} finally {
		console.error = original;
	}
	assert.deepEqual(Object.keys(readMarks(path)).sort(), ["anthropic/a", "kimi", "openai/b"]);
	assert.equal(logged.length, 1);
});

test("a stale lock is taken over exactly once by rename", () => {
	const dir = mkdtempSync(join(tmpdir(), "plm-"));
	const path = join(dir, "marks.json");
	writeFileSync(`${path}.lock`, "");
	const old = (Date.now() - 60_000) / 1000;
	utimesSync(`${path}.lock`, old, old);
	let ran = 0;
	withMarksLock(path, () => { ran++; });
	assert.equal(ran, 1);
	assert.deepEqual(readdirSync(dir), []);
});
