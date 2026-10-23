import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dotnetBlockReason } from "./dotnet-guard.ts";
import dotnetExtension from "../extensions/dotnet-guard.ts";
import guardsExtension from "../extensions/guards.ts";

const blocked = ["build", "test", "publish", "pack", "msbuild", "run"];
test("unwrapped build-type commands are blocked, including paths and wrappers", () => {
	for (const verb of blocked) {
		for (const command of [
			`dotnet ${verb} My.sln`, `cd repo && dotnet ${verb}`, `pwd; dotnet ${verb}`,
			`env X=1 dotnet ${verb}`, `X=1 dotnet ${verb}`, `nice dotnet ${verb}`,
			`nice -n 10 dotnet ${verb}`, `/usr/bin/nice -10 /usr/local/bin/dotnet ${verb}`,
			`bash -c 'dotnet ${verb}'`, `sh -c 'cd repo && dotnet ${verb}'`,
			`env X=1 bash -lc 'nice dotnet ${verb}'`,
		]) {
			const reason = dotnetBlockReason(command);
			assert.ok(reason, command);
			assert.ok(reason.includes(`pi-phase run --kind ${verb === "test" ? "test" : "build"}`), command);
			assert.ok(reason.includes("--timeout 300 --queue-timeout 600 --"), command);
		}
	}
});

test("replacement preserves original arguments and quoting", () => {
	assert.equal(dotnetBlockReason('cd repo && dotnet test "My Tests.csproj" -c Release'),
		'dotnet guard: run .NET work inside pi-phase:\ncd repo && ~/.pi/agent/bin/pi-phase run --kind test --label \'dotnet test\' --timeout 300 --queue-timeout 600 -- dotnet test "My Tests.csproj" -c Release');
	assert.ok(dotnetBlockReason('X="some value" dotnet build')?.endsWith('-- env X="some value" dotnet build'));
});

test("replacement retains leading cd and drops the exec builtin", () => {
	for (const command of ['cd "my repo" && dotnet build -c Release', 'cd "my repo" && exec dotnet build -c Release']) {
		const reason = dotnetBlockReason(command);
		assert.ok(reason?.includes('\ncd "my repo" && ~/.pi/agent/bin/pi-phase run --kind build'), command);
		assert.ok(reason?.endsWith('-- dotnet build -c Release'), command);
	}
	assert.ok(dotnetBlockReason("exec dotnet test")?.endsWith("-- dotnet test"));
});

test("common trailing output redirections and display pipes are guarded", () => {
	for (const suffix of ["2>&1 | tail -n 20", "| head -n 5", "| grep error", "| tee build.log",
		"> build.log 2>&1", ">build.log", ">>build.log", "2>&1", "> 'build output.log' 2>&1",
		"2>&1 | tee build.log | tail -n 20", "2>&1 | /usr/bin/tail -n 20"]) {
		const reason = dotnetBlockReason(`dotnet build My.sln -c Release ${suffix}`);
		assert.ok(reason, suffix);
		assert.ok(reason.includes("-- dotnet build My.sln -c Release\n"), suffix);
		assert.ok(reason.includes("--log FILE --tail N"), suffix);
		assert.ok(!reason.includes(suffix), suffix);
	}
	assert.ok(dotnetBlockReason("cd repo && exec dotnet build 2>&1 | tail -n 20")?.includes(
		"\ncd repo && ~/.pi/agent/bin/pi-phase run --kind build"));
	assert.equal(dotnetBlockReason("pi-phase run --kind build -- dotnet build 2>&1 | tail -n 20"), undefined);
});

test("output filtering never makes mentions or uncertain shell syntax into dotnet commands", () => {
	for (const command of ['echo "dotnet build" | tee x', "git log | grep dotnet",
		"dotnet build < input", "dotnet build `echo My.sln`", "dotnet build $(echo My.sln)",
		"(dotnet build)", "{ dotnet build; }", "dotnet build 2> errors.log", "dotnet build >out extra",
		"dotnet build >out <input", "dotnet build >>$(filename)", "dotnet build | tail -n $(count)",
		'dotnet build "$(project)"', 'dotnet build "`project`"'])
		assert.equal(dotnetBlockReason(command), undefined, command);
});

test("phase scope applies only to its own command, including nested shell payloads", () => {
	for (const command of [
		"~/.pi/agent/bin/pi-phase run --kind build -- dotnet build",
		"cd repo && pi-phase run --kind test -- dotnet test",
		"nice -n 10 pi-phase run --kind test -- bash -c 'dotnet test; dotnet build'",
		"bash -c 'pi-phase run --kind build -- dotnet run'",
	]) assert.equal(dotnetBlockReason(command), undefined, command);
	for (const command of [
		"pi-phase status; dotnet test", "pi-phase run --kind build -- dotnet build; dotnet test",
		"echo 'pi-phase run -- dotnet test'; dotnet build", "pi-phase run -- dotnet build && sh -c 'dotnet test'",
	]) assert.ok(dotnetBlockReason(command), command);
});

test("metadata, bounded formatting and non-build tooling are allowed", () => {
	for (const args of ["--info", "--version", "--list-sdks", "tool restore", "new console", "sln add X.csproj",
		"add package X", "remove package X", "list package", "nuget locals all --list", "format --verify-no-changes",
		"dev-certs https", "workload list", "build-server shutdown", "restore"])
		assert.equal(dotnetBlockReason(`dotnet ${args}`), undefined, args);
});

test("quoted mentions, repo tooling and uncertain syntax never stop a lane", () => {
	for (const command of [
		"grep dotnet file", 'echo "dotnet test"', "printf '%s' 'dotnet build; dotnet test'",
		"git log --grep='dotnet test'", "agent/bin/pi-setup-tests agent", "python3 -m unittest discover -s tests",
		"bash -c 'echo dotnet test'", "cat <<'EOF'\ndotnet test\nEOF", "dotnet 'test", "dotnet $verb",
		"echo ok # dotnet build", 'bash -c "$SCRIPT"', "bash script.sh -c 'dotnet test'",
		"sh -- script.sh -c 'dotnet build'", "env SCRIPT='dotnet test' echo ok",
	]) assert.equal(dotnetBlockReason(command), undefined, command);
});

const ENV = ["PI_GUARDS_FILE", "PI_GUARDS_OFF", "PI_ORCH_ID", "PI_ORCH_MODE_FILE", "PI_ORCH_REPO_ROOT", "PI_ORCH_MESSAGES_DIR"];
let saved: Record<string, string | undefined>;
let dir: string;
beforeEach(() => {
	saved = Object.fromEntries(ENV.map(n => [n, process.env[n]]));
	dir = mkdtempSync(join(tmpdir(), "dotnet-guard-"));
	process.env.PI_GUARDS_FILE = join(dir, "guards.json");
	process.env.PI_ORCH_MODE_FILE = join(dir, "mode");
	process.env.PI_ORCH_REPO_ROOT = join(dir, "repos");
	process.env.PI_ORCH_MESSAGES_DIR = join(dir, "messages");
	delete process.env.PI_GUARDS_OFF;
	delete process.env.PI_ORCH_ID;
	delete (globalThis as any)[Symbol.for("pi.guards")];
});
afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name]; else process.env[name] = value;
	}
	delete (globalThis as any)[Symbol.for("pi.guards")];
	rmSync(dir, { recursive: true, force: true });
});

test("extension is orchestration-only and /guards off dotnet disables it", async () => {
	let handler: any;
	dotnetExtension({ on: (name: string, fn: any) => { assert.equal(name, "tool_call"); handler = fn; } } as any);
	const ctx = { cwd: dir, hasUI: false };
	const event = { toolName: "bash", input: { command: "dotnet test" } };
	assert.equal(await handler(event, ctx), undefined);
	process.env.PI_ORCH_ID = "lane-1";
	assert.equal((await handler(event, ctx)).block, true);
	assert.equal(await handler({ ...event, toolName: "read" }, ctx), undefined);
	assert.equal(await handler({ toolName: "bash", input: {} }, ctx), undefined);
	let command: any;
	guardsExtension({ registerCommand: (_: string, spec: any) => { command = spec; },
		on: () => {}, events: { on: () => {} } } as any);
	await command.handler("off dotnet", ctx);
	assert.equal(await handler(event, ctx), undefined);
	await command.handler("on dotnet", ctx);
	assert.equal((await handler(event, ctx)).block, true);
});
