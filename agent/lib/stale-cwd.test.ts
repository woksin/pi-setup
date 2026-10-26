import assert from "node:assert/strict";
import { test } from "node:test";
import { probeCwd, recoveryText, safeCwd } from "./stale-cwd.ts";

const enoent = () => { throw Object.assign(new Error("ENOENT: process.cwd failed"), { code: "ENOENT" }); };

test("cwd ok: state ok, nothing to say", () => {
	assert.deepEqual(probeCwd({ cwd: () => "/work/a", sessionCwd: "/work/a" }), { state: "ok", cwd: "/work/a" });
});

test("cwd throws and the session path exists: stale, recovery names the path", () => {
	const probe = probeCwd({ cwd: enoent, exists: () => true, sessionCwd: "/work/a" });
	assert.deepEqual(probe, { state: "stale", sessionCwd: "/work/a", sessionCwdExists: true });
	const text = recoveryText("/work/a", true);
	assert.match(text, /cd \/work\/a && pi -c/);
	assert.match(text, /exit pi/i);
	assert.match(text, /\/reload/);
	assert.ok(!text.includes("\n"));
});

test("cwd throws and the session path is missing: stale, text says the directory is gone", () => {
	const probe = probeCwd({ cwd: enoent, exists: () => false, sessionCwd: "/work/gone" });
	assert.deepEqual(probe, { state: "stale", sessionCwd: "/work/gone", sessionCwdExists: false });
	assert.match(recoveryText("/work/gone", false), /\/work\/gone no longer exists/);
	assert.doesNotMatch(recoveryText("/work/gone", false), /pi -c/);
});

test("stale without a session path, or an exists() that throws", () => {
	assert.deepEqual(probeCwd({ cwd: enoent }), { state: "stale", sessionCwd: undefined, sessionCwdExists: false });
	assert.equal(probeCwd({ cwd: enoent, sessionCwd: "/x", exists: () => { throw new Error("boom"); } }).state, "stale");
	assert.match(recoveryText(undefined), /existing directory/);
});

test("safeCwd never throws", () => {
	assert.equal(safeCwd(), process.cwd());
	const real = process.cwd;
	process.cwd = enoent;
	try {
		assert.equal(safeCwd(), undefined);
		assert.equal(safeCwd("/fallback"), "/fallback");
	} finally { process.cwd = real; }
});
