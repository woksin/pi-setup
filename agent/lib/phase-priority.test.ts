import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { grantPriorityRequests, highPriorityRequests, priorityCommandArgs, readGrant, referencesGrantFile, validateGrant } from "./phase-priority.ts";
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

test("detects explicit grants via runner paths and Python scripts with the same shell splitter", () => {
	for (const program of ["pi-phase", "/any/path/pi-phase", "./pi_phase.py",
		"/usr/bin/python3 -B /any/path/pi_phase.py", "python -u -- ./pi_phase.py",
		"python3.14 -X dev -W ignore './path with spaces/pi_phase.py'"]) {
		assert.deepEqual(grantPriorityRequests(`${program} grant-priority --minutes 480`), [["--minutes", "480"]]);
	}
	assert.deepEqual(grantPriorityRequests("X=1 env rtk proxy pi-phase grant-priority --uses=2"), [["--uses=2"]]);
	assert.deepEqual(grantPriorityRequests("bash -lc 'pi-phase grant-priority --uses 1'"), [["--uses", "1"]]);
	assert.deepEqual(grantPriorityRequests("pi-phase grant-priority; ./pi_phase.py grant-priority --minutes 30"),
		[[], ["--minutes", "30"]]);
	for (const command of ["pi-phase revoke-priority", "./pi_phase.py status", "echo pi-phase grant-priority",
		"printf '%s' 'pi-phase grant-priority --minutes 480'", "# pi-phase grant-priority",
		"cat <<'EOF'\npi-phase grant-priority --minutes 480\nEOF",
		"python3 -c 'print(1)' pi_phase.py grant-priority", "python3 -m other pi_phase.py grant-priority",
		"pi-phase run --kind build --label 'grant-priority' -- echo grant-priority",
	]) assert.deepEqual(grantPriorityRequests(command), [], command);
});

test("raw grant-file references are blocked only for bash and write/edit paths", () => {
	for (const command of ["echo '{}' > priority-grant.json", "rm ~/.pi/agent/pi-phase/state/priority-grant.json",
		"python3 -c \"open('priority-grant.json', 'w').write('{}')\"", "echo 'priority-grant.json'",
		"cat <<EOF\npriority-grant.json\nEOF",
	]) assert.equal(referencesGrantFile("bash", { command }), true, command);
	for (const toolName of ["write", "edit"]) {
		for (const path of ["priority-grant.json", "./state/priority-grant.json", "/any/path/priority-grant.json"])
			assert.equal(referencesGrantFile(toolName, { path }), true);
		assert.equal(referencesGrantFile(toolName, { path: "other.json" }), false);
		assert.equal(referencesGrantFile(toolName, { path: "priority-grant.json.backup" }), false);
		assert.equal(referencesGrantFile(toolName, { command: "priority-grant.json" }), false);
		assert.equal(referencesGrantFile(toolName, { path: null }), false);
	}
	assert.equal(referencesGrantFile("read", { path: "priority-grant.json" }), false);
	assert.equal(referencesGrantFile("bash", { command: "pi-phase grant-priority --uses 1" }), false);
	assert.equal(referencesGrantFile("bash", { command: "pi-phase revoke-priority" }), false);
});

test("CI high priority never requests approval, including Python runner paths", () => {
	for (const program of ["pi-phase", "/any/path/pi_phase.py", "python3 -B ./pi_phase.py"]) {
		assert.deepEqual(highPriorityRequests(`${program} run --priority high --kind ci --label watcher -- gh run watch 1`), []);
		assert.deepEqual(highPriorityRequests(`${program} run --kind=ci --priority=high --label=watcher -- gh run watch 1`), []);
	}
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
		tool: (toolName: string, input: unknown) => handlers.get("tool_call")!({ toolName, input }, ctx),
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
		reason: "high priority needs approval from the orchestrator (L0) or the user; ask your parent session/orchestrator, which can grant it" });
	assert.equal(headless.selections.length, 0);
	assert.equal(calls.length, 0);
});

test("direct grant creation prompts even with an existing grant and only Allow proceeds", async () => {
	contents = JSON.stringify({ ...grant, expires: Date.now() / 1000 + 60 });
	for (const command of ["pi-phase grant-priority --minutes 480", "python3 -B /any/path/pi_phase.py grant-priority --minutes 480"]) {
		const app = fake();
		for (const choice of ["Deny", undefined]) {
			app.choose(choice);
			assert.equal((await app.fire(command))?.block, true);
		}
		app.choose("Allow");
		assert.equal(await app.fire(command), undefined);
		assert.deepEqual(app.selections.at(-1), {
			title: "Agent wants to grant high queue priority: --minutes 480", options: ["Allow", "Deny"],
		});
		const headless = fake(false);
		assert.deepEqual(await headless.fire(command), { block: true,
			reason: "high priority needs approval from the orchestrator (L0) or the user; ask your parent session/orchestrator, which can grant it" });
		assert.equal(headless.selections.length, 0);
	}
	assert.equal(calls.length, 0, "the allowed tool call, not the extension, executes an explicit grant");
});

test("grant-file bash references and write/edit paths block without a prompt in all modes", async () => {
	contents = JSON.stringify({ ...grant, expires: Date.now() / 1000 + 60 });
	for (const hasUI of [true, false]) {
		const app = fake(hasUI);
		for (const [toolName, input] of [
			["bash", { command: "echo '{}' > /any/path/priority-grant.json" }],
			["bash", { command: "pi-phase grant-priority; cat priority-grant.json" }],
			["write", { path: "/any/path/priority-grant.json", content: "{}" }],
			["edit", { path: "priority-grant.json", oldText: "1", newText: "20" }],
		] as const) assert.deepEqual(await app.tool(toolName, input), {
			block: true, reason: "grants are created only via user approval (/phase-priority)",
		});
		assert.equal(app.selections.length, 0);
		assert.equal(await app.tool("read", { path: "priority-grant.json" }), undefined);
		assert.equal(await app.tool("write", { path: "other.json", content: "priority-grant.json" }), undefined);
	}
	assert.equal(calls.length, 0);
});

test("revocation stays allowed and CI high priority does not prompt", async () => {
	for (const hasUI of [true, false]) {
		const app = fake(hasUI);
		assert.equal(await app.fire("pi-phase revoke-priority"), undefined);
		assert.equal(await app.fire("python3 ./pi_phase.py revoke-priority"), undefined);
		assert.equal(await app.fire(run.replace("--kind build", "--kind ci")), undefined);
		assert.equal(app.selections.length, 0);
	}
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

test("orchestrator registry keeps only live integer pids and is a protected file", async () => {
	const { readOrchestrators, withinOrchestratorCap } = await import("./phase-priority.ts");
	const path = "/test-home/.pi/agent/pi-phase/state/priority-orchestrators.json";
	contents = JSON.stringify({ pids: [11, 22, "x", 3.5] });
	assert.deepEqual(readOrchestrators(path, pid => pid === 22), [22]);
	contents = undefined;
	assert.deepEqual(readOrchestrators(path, () => true), []);
	assert.equal(referencesGrantFile("bash", { command: `cat ${path}` }), true);
	assert.equal(referencesGrantFile("write", { path }), true);
	assert.equal(withinOrchestratorCap(["--uses", "4"]), true);
	assert.equal(withinOrchestratorCap(["--uses", "11"]), false);
	assert.equal(withinOrchestratorCap(["--minutes=120"]), true);
	assert.equal(withinOrchestratorCap(["--minutes", "480"]), false);
});
