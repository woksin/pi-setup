import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const required = (name: string) => { const value = process.env[name]; assert.ok(value, `${name} must explicitly name its source checkout`); return resolve(value); };
const setup = required("PI_USAGE_SETUP_SOURCE"), jobs = required("PI_USAGE_JOBS_SOURCE"), orch = required("PI_USAGE_ORCH_SOURCE");
const load = (root: string, file: string) => import(pathToFileURL(join(root, file)).href);
const [{ shellInvocations }, other, { parkedStatus }, { parking }, { laneStatus }, { createJobsExtension }, { default: killGuard }, { busFixture, nativeBusFixture }] = await Promise.all([
	load(setup, "agent/lib/shell-invocations.ts"), load(orch, "src/lib/shell-invocations.ts"), load(setup, "agent/extensions/inbox-rearm.ts"),
	load(orch, "src/lib/poller.ts"), load(jobs, "src/subscription.ts"), load(jobs, "src/extension.ts"), load(setup, "agent/extensions/kill-guard.ts"), load(orch, "test/bus-harness.ts"),
]);
const output = join(setup, ".ai-work/usage-reduction"); mkdirSync(output, { recursive: true });
const fixture = () => { const root = mkdtempSync(join(output, "security-fixture-")), inbox = join(root, "inbox"), status = join(root, "status"); mkdirSync(inbox); mkdirSync(status); return { root, inbox, status, file: join(status, "L1.status"), env: { ...process.env, INBOX_DIR: inbox, LANE_STATUS_DIR: status } }; };
const forms = (command: string) => [["bash", { command }], ["job_start", { command }], ["job_watch", { check: command }], ["job_subscribe", { check: command }]] as const;

test("separate packages have identical execution normalization contracts", () => {
	const inputs: [string, unknown][] = [...forms("git push"), ["unknown", { command: "git push" }], ["multi_tool_use", { tool_uses: [{ recipient_name: "functions.job_subscribe", parameters: { check: "printf ok", cwd: "child" } }], cwd: "parent" }]];
	for (const [name] of forms("ok")) for (const malformed of [null, {}, [], { command: 7 }, { check: false }, { command: "ok", check: "ok", cwd: null }]) inputs.push([name, malformed]);
	let nested: unknown = { check: "git push" }, name = "job_subscribe";
	for (let i = 0; i < 6; i++) { nested = { tool_uses: [{ recipient_name: name, parameters: nested }] }; name = "multi_tool_use.parallel"; }
	inputs.push([name, nested]);
	for (const [name, input] of inputs) assert.deepEqual(shellInvocations(name, input, "/root"), other.shellInvocations(name, input, "/root"));
	assert.equal(readFileSync(join(setup, "agent/lib/shell-invocations.ts"), "utf8"), readFileSync(join(orch, "src/lib/shell-invocations.ts"), "utf8"));
});

test("real lane-status producer is understood by all consumers without assessment auto-unparking", () => {
	const f = fixture();
	const produce = (...args: string[]) => { const result = spawnSync(join(setup, "agent/bin/lane-status"), args, { env: f.env, encoding: "utf8", timeout: 3000 }); assert.equal(result.status, 0, result.stderr); };
	const check = (expected: string, orchExpected: string) => {
		assert.equal(laneStatus({ lane: "L1", inboxDir: f.inbox, statusPath: f.file }).state, expected);
		assert.equal(parkedStatus("L1", f.env), expected === "eligible" ? undefined : expected);
		assert.equal(parking("L1", Date.now(), f.env), orchExpected);
	};
	check("eligible", "ordinary");
	produce("set", "L1", "working"); check("eligible", "ordinary");
	for (const assessment of ["2099-01-01T00:00:00Z", "2000-01-01T00:00:00Z"]) {
		produce("set", "L1", "parked", "dependency / owner", "--until", assessment); check("parked", "parked");
	}
	produce("set", "L1", "working"); check("eligible", "ordinary");
	for (const kind of ["waiting-on", "barred-by"]) {
		produce("set", "L1", kind, "dependency", "--until", "2099-01-01T00:00:00Z"); check("eligible", "parked");
		produce("set", "L1", kind, "dependency", "--until", "2000-01-01T00:00:00Z"); check("eligible", "uncertain");
	}
	produce("close", "L1", "--reassign-to", "L2", "--reason", "completed"); check("eligible", "ordinary");
	for (const line of ["working since nonsense", "working since 2026-02-30T00:00:00Z", "working since 2026-01-01T00:00:00Z\ntrailing", 'parked "owner" until nonsense', 'closed reassigned-to L2 at nonsense']) { writeFileSync(f.file, line); check("invalid", "uncertain"); }
});

test("all status consumers reject unsafe file types under a hard child deadline", () => {
	const f = fixture();
	const script = `const [{parkedStatus},{parking},{laneStatus}]=await Promise.all([import(${JSON.stringify(pathToFileURL(join(setup, "agent/extensions/inbox-rearm.ts")).href)}),import(${JSON.stringify(pathToFileURL(join(orch, "src/lib/poller.ts")).href)}),import(${JSON.stringify(pathToFileURL(join(jobs, "src/subscription.ts")).href)})]); console.log(JSON.stringify([parkedStatus('L1'),parking('L1',Date.now(),process.env),laneStatus({lane:'L1',statusPath:${JSON.stringify(f.file)},inboxDir:${JSON.stringify(f.inbox)}}).state]));`;
	const check = () => { const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env: f.env, encoding: "utf8", timeout: 3000 }); assert.equal(result.status, 0, String(result.error || result.stderr)); assert.deepEqual(JSON.parse(result.stdout), ["invalid", "uncertain", "invalid"]); };
	writeFileSync(f.file, "x".repeat(4097)); check(); unlinkSync(f.file);
	mkdirSync(f.file); check();
	const dirFile = f.file; const otherFile = join(f.status, "other.status"); writeFileSync(otherFile, "working since 2026-01-01T00:00:00Z");
	// Use another lane after the directory fixture; never remove a potentially live directory.
	const linked = join(f.status, "L2.status"); symlinkSync(otherFile, linked);
	const second = script.replaceAll("'L1'", "'L2'").replaceAll(JSON.stringify(dirFile), JSON.stringify(linked));
	const linkResult = spawnSync(process.execPath, ["--input-type=module", "--eval", second], { env: f.env, encoding: "utf8", timeout: 3000 }); assert.equal(linkResult.status, 0, linkResult.stderr); assert.deepEqual(JSON.parse(linkResult.stdout), ["invalid", "uncertain", "invalid"]);
	const fifo = join(f.status, "L3.status"), made = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 3000 }); assert.equal(made.status, 0, made.stderr);
	const third = script.replaceAll("'L1'", "'L3'").replaceAll(JSON.stringify(dirFile), JSON.stringify(fifo));
	const fifoResult = spawnSync(process.execPath, ["--input-type=module", "--eval", third], { env: f.env, encoding: "utf8", timeout: 3000 }); assert.equal(fifoResult.status, 0, String(fifoResult.error || fifoResult.stderr)); assert.deepEqual(JSON.parse(fifoResult.stdout), ["invalid", "uncertain", "invalid"]);
});

test("owner holds apply equally to foreground, jobs and subscription checks", async () => {
	const h = busFixture({ id: "R-Test" });
	try {
		await h.start();
		h.store.send({ from: "L0", to: "R-Test", kind: "hold", repo: "Test", blocks: ["push"], subject: "hold push", body: "hold", requiresAck: false, ackDeadlineMin: 30 });
		for (const [toolName, input] of forms("git push")) assert.match((await h.emit("tool_call", { toolName, input })).reason, /hold/);
		for (const [toolName, input] of forms("git status")) assert.equal(await h.emit("tool_call", { toolName, input }), undefined);
	} finally { h.stop(); }
});

for (const command of ["pkill -f dotnet", "git push"]) test(`native SDK rejects subscription before actual jobs handler can create sentinel: ${command}`, async () => {
	const f = fixture(), sentinel = join(f.root, "SENTINEL"); let manager: any;
	const h = await nativeBusFixture({ id: "L1", root: f.root, extensions: [killGuard, createJobsExtension({ subscriptions: true, env: f.env, logRoot: join(f.root, "logs"), onManager: (value: any) => { manager = value; } })],
		toolCall: { name: "job_subscribe", arguments: { check: `${command}; touch '${sentinel}'`, lane: "L1", inboxDir: f.inbox, intervalSeconds: 10, timeoutSeconds: 30 } } });
	try {
		assert.ok(h.session.getActiveToolNames().includes("job_subscribe"));
		await h.session.prompt("fixture tool request");
		const result = h.session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "job_subscribe");
		assert.ok(result?.isError, JSON.stringify(h.session.messages));
		assert.equal(manager.list().length, 0); assert.equal(existsSync(sentinel), false); assert.deepEqual(h.errors, []);
	} finally { await h.shutdown(); }
});
