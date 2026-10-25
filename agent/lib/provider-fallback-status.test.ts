import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codeFingerprint, fallbackStatusLines } from "./provider-fallback-status.ts";

const base = { originalRef: "anthropic/a", current: "openai/b", reason: "anthropic limited until 14:05", provider: "anthropic", commandRegistered: true, stale: false };

test("fallbackStatusLines: reason, expiry, both undo commands", () => {
	const lines = fallbackStatusLines({ ...base, until: new Date(2026, 9, 25, 14, 5).getTime() });
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^provider-fallback: on openai\/b instead of anthropic\/a — anthropic limited until 14:05 \(until .*\)$/);
	assert.equal(lines[1], "undo: /provider-restore anthropic · shell: provider-restore anthropic");
	assert.ok(lines.every((line) => line.length < 160));
});

test("fallbackStatusLines: no command registered, restore note and stale hint", () => {
	const lines = fallbackStatusLines({ ...base, commandRegistered: false, restoreNote: "restoreWhenExpired is disabled", stale: true, reason: undefined });
	assert.match(lines[0], /instead of anthropic\/a — cannot switch back: restoreWhenExpired is disabled$/);
	assert.equal(lines[1], "undo: shell: provider-restore anthropic");
	assert.match(lines[2], /changed on disk since this session loaded it: \/reload when idle/);
});

test("codeFingerprint changes with size, marks a missing file and never throws", () => {
	const dir = mkdtempSync(join(tmpdir(), "fp-"));
	const file = join(dir, "a.ts");
	writeFileSync(file, "one");
	const first = codeFingerprint([file, join(dir, "missing.ts")]);
	assert.match(first, /\|-$/);
	writeFileSync(file, "longer content");
	assert.notEqual(codeFingerprint([file, join(dir, "missing.ts")]), first);
	assert.equal(codeFingerprint([]), "");
});
