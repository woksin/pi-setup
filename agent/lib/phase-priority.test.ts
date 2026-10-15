import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { highPriorityRequests, priorityCommandArgs, readGrant, validateGrant } from "./phase-priority.ts";
import extension from "../extensions/phase-priority.ts";

const run = "~/.pi/agent/bin/pi-phase run --kind build --label 'Release build' --priority high -- dotnet build";
const request = { kind: "build", label: "Release build" };
const grant = { expires: 200, created: 100, uses: 1, granted_by: "user" };
let contents: string | undefined;
let failure: Error | undefined;
let calls: { path: string; args: string[] }[];

beforeEach(() => {
	contents = undefined;
	failure = undefined;
	calls = [];
	mock.method(os, "homedir", () => "/test-home");
	mock.method(fs, "readFileSync", () => {
		if (contents === undefined) throw new Error("missing");
		return contents;
	});
	mock.method(childProcess, "execFile", (path: string, args: string[], _options: unknown, callback: Function) => {
		calls.push({ path, args });
		callback(failure ?? null, failure ? "" : "pi-phase: result\n", failure ? "command failed" : "");
	});
	syncBuiltinESMExports();
});
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });

test("detects high priority with both flag forms, options in either order and quoted label", () => {
	assert.deepEqual(highPriorityRequests(run), [request]);
	assert.deepEqual(highPriorityRequests("pi-phase run --priority=high --kind=integration --label=tests -- test"),
		[{ kind: "integration", label: "tests" }]);
	assert.deepEqual(highPriorityRequests("cd repo && X=1 rtk proxy " + run), [request]);
	assert.deepEqual(highPriorityRequests(run + "; " + run), [request, request]);
	assert.deepEqual(highPriorityRequests(run.replace(" --kind", " \\\n--kind")), [request]);
	assert.deepEqual(highPriorityRequests("bash -lc " + JSON.stringify(run)), [request]);
	assert.deepEqual(highPriorityRequests('"/path with spaces/pi-phase" run --priority "high" --kind test --label "unit suite"'),
		[{ kind: "test", label: "unit suite" }]);
});

test("quoted mentions, comments, heredoc bodies and producer arguments do not request priority", () => {
	for (const command of [
		`printf '%s' "${run}"`, `git commit -m "${run}"`, `# ${run}`,
		"cat <<'EOF'\n" + run + "\nEOF", "cat <<-EOF\n\t" + run + "\n\tEOF",
		"cat <<A <<'B'\n" + run + "\nA\n" + run + "\nB",
		"pi-phase run --kind build --label 'pi-phase run --priority high' -- echo --priority high",
		"pi-phase run --label x -- echo --priority high", "pi-phase run --label x echo --priority high",
		"pi-phase status --priority high", "other-pi-phase run --priority high",
		"pi-phase run --label '--priority' --kind high -- echo", "pi-phase run --priority low -- echo",
		"pi-phase run --priority high --priority normal -- echo",
	]) assert.deepEqual(highPriorityRequests(command), [], command);
	assert.deepEqual(highPriorityRequests("cat <<EOF\n" + run + "\nEOF\n" + run), [request]);
});

test("validates grants strictly with epoch-second expiry, count and unlimited uses", () => {
	assert.deepEqual(validateGrant(grant, 150), grant);
	assert.deepEqual(validateGrant({ ...grant, uses: null }, 150), { ...grant, uses: null });
	for (const value of [undefined, null, [], {}, { ...grant, expires: 150 },
		{ ...grant, expires: Infinity }, { ...grant, expires: "200" }, { ...grant, created: "100" },
		{ ...grant, created: 201 }, { ...grant, uses: 0 }, { ...grant, uses: 21 },
		{ ...grant, uses: 1.5 }, { ...grant, uses: true }, { ...grant, uses: "1" },
		{ ...grant, granted_by: "" }, { ...grant, extra: true },
	]) assert.equal(validateGrant(value, 150), undefined, JSON.stringify(value));
});

test("reads grants and fails closed on missing or corrupt files", () => {
	assert.equal(readGrant("grant", 150), undefined);
	contents = "{invalid";
	assert.equal(readGrant("grant", 150), undefined);
	contents = JSON.stringify(grant);
	assert.deepEqual(readGrant("grant", 150), grant);
	assert.equal(readGrant("grant", 200), undefined);
});

function fake(hasUI = true) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const selections: { title: string; options: string[] }[] = [];
	const notices: { message: string; type: string }[] = [];
	let choice: string | undefined = "Deny";
	const ctx: any = { hasUI, ui: {
		select: async (title: string, options: string[]) => { selections.push({ title, options }); return choice; },
		notify: (message: string, type: string) => notices.push({ message, type }),
	} };
	const pi: any = {
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	};
	extension(pi);
	return { ctx, selections, notices, choose: (value: string | undefined) => { choice = value; },
		fire: (command = run, toolName = "bash") => handlers.get("tool_call")!({ toolName, input: { command } }, ctx),
		command: (args: string) => commands.get("phase-priority").handler(args, ctx),
	};
}

test("UI approval invokes the single CLI grant writer with once or 30-minute scope", async () => {
	const app = fake();
	app.choose("Allow once");
	assert.equal(await app.fire(), undefined);
	assert.deepEqual(app.selections[0], {
		title: "Agent asks for high queue priority: build 'Release build'",
		options: ["Allow once", "Allow for 30 minutes", "Deny"],
	});
	assert.deepEqual(calls[0], { path: "/test-home/.pi/agent/bin/pi-phase", args: ["grant-priority", "--uses", "1"] });
	app.choose("Allow for 30 minutes");
	assert.equal(await app.fire(), undefined);
	assert.deepEqual(calls[1].args, ["grant-priority", "--minutes", "30"]);
});

test("denial, dismissal and headless requests block without creating grants", async () => {
	const app = fake();
	for (const choice of ["Deny", undefined]) {
		app.choose(choice);
		assert.deepEqual(await app.fire(), { block: true, reason: "High queue priority denied; rerun without --priority high." });
	}
	const headless = fake(false);
	assert.deepEqual(await headless.fire(), { block: true,
		reason: "high priority needs user approval; ask the parent session/user, who can run /phase-priority allow" });
	assert.equal(headless.selections.length, 0);
	assert.equal(calls.length, 0);
});

test("a valid grant bypasses prompting including headless; expired or invalid grants do not", async () => {
	contents = JSON.stringify({ ...grant, expires: Date.now() / 1000 + 60 });
	for (const hasUI of [true, false]) {
		const app = fake(hasUI);
		assert.equal(await app.fire(), undefined);
		assert.equal(app.selections.length, 0);
	}
	for (const value of [grant, { ...grant, uses: 0 }, null]) {
		contents = JSON.stringify(value);
		assert.equal((await fake(false).fire())?.block, true);
	}
	assert.equal(calls.length, 0);
});

test("unrelated calls need no approval and failed grant writing blocks execution", async () => {
	const app = fake(false);
	assert.equal(await app.fire("echo hi"), undefined);
	assert.equal(await app.fire(run.replace("high", "normal")), undefined);
	assert.equal(await app.fire(run, "read"), undefined);
	const ui = fake();
	ui.choose("Allow once");
	failure = new Error("failed");
	assert.deepEqual(await ui.fire(), { block: true, reason: "Cannot grant high priority: command failed" });
});

test("slash command maps status, allow, allow-once and revoke to CLI and notifies result", async () => {
	const app = fake();
	for (const [input, args] of [
		["", ["status"]], ["status", ["status"]], ["allow", ["grant-priority", "--minutes", "30"]],
		["allow 480", ["grant-priority", "--minutes", "480"]], ["allow-once", ["grant-priority", "--uses", "1"]],
		["revoke", ["revoke-priority"]],
	] as const) {
		assert.deepEqual(priorityCommandArgs(input), args);
		await app.command(input);
		assert.deepEqual(calls.at(-1)?.args, args);
		assert.deepEqual(app.notices.at(-1), { message: "pi-phase: result", type: "info" });
	}
	for (const input of ["allow 0", "allow 481", "allow -1", "allow 1.5", "allow Infinity", "allow 30 extra", "allow-once 2", "status extra", "unknown"]) {
		assert.throws(() => priorityCommandArgs(input), /Usage:/);
		const count = calls.length;
		await app.command(input);
		assert.equal(calls.length, count);
		assert.equal(app.notices.at(-1)?.type, "error");
	}
	failure = new Error("failed");
	await app.command("revoke");
	assert.deepEqual(app.notices.at(-1), { message: "command failed", type: "error" });
});
