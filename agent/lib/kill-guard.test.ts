import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killBlockReason } from "./kill-guard.ts";
import killExtension from "../extensions/kill-guard.ts";
import guardsExtension from "../extensions/guards.ts";

const blocked = [
	"pkill -f foo", "pkill foo", "pkill -9 -u me foo", "killall dotnet",
	"sudo /usr/bin/pkill -f foo", "cd repo && killall -9 dotnet",
	"pgrep -f x | xargs kill", "kill $(pgrep -f x)", "kill `pgrep -f x`",
	'kill -9 "$(pgrep -f x)"',
	"ps aux | grep x | awk '{print $2}' | xargs kill -9",
	"kill $(ps aux | grep x | awk '{print $2}')",
];

test("name kills and process-search pipelines/substitutions are blocked with ownership guidance", () => {
	for (const command of blocked) {
		const reason = killBlockReason(command);
		assert.ok(reason, command);
		for (const text of ["other sessions' processes", "ps -o pid,ppid,pgid,command", "own process group or cwd",
			"lsof -p", "numeric PIDs", "pi-phase", "/guards off kill"]) assert.ok(reason.includes(text), command);
	}
});

test("numeric and job kills, literal mentions and script invocations are allowed", () => {
	for (const command of [
		"kill 1234", "kill -TERM 1234 5678", "kill -0 99", "kill -0", "kill %1", "kill -9 %job", "ls",
		'echo "pkill is bad"', "printf '%s' 'killall dotnet'", "echo ok # pkill foo",
		"cat <<'EOF' > script.sh\npkill -f foo\nkillall dotnet\nEOF\nls",
		"bash cleanup.sh", "~/.pi/agent/bin/pi-phase run --kind test -- ./test.sh",
		"pgrep -f x; kill 1234", "ps aux | grep x; kill 1234",
	]) assert.equal(killBlockReason(command), undefined, command);
});

test("commands after a quoted heredoc are still guarded", () => {
	assert.ok(killBlockReason("cat <<'EOF' > script.sh\necho ok\nEOF\npkill -f foo"));
});

const ENV = ["PI_GUARDS_FILE", "PI_GUARDS_OFF"];
let saved: Record<string, string | undefined>;
let dir: string;
let previousState: unknown;
const key = Symbol.for("pi.guards");
beforeEach(() => {
	saved = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
	dir = mkdtempSync(join(tmpdir(), "kill-guard-"));
	process.env.PI_GUARDS_FILE = join(dir, "guards.json");
	delete process.env.PI_GUARDS_OFF;
	previousState = (globalThis as any)[key];
	delete (globalThis as any)[key];
});
afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name]; else process.env[name] = value;
	}
	if (previousState === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = previousState;
	rmSync(dir, { recursive: true, force: true });
});

test("tool_call blocks before bash execution and /guards off kill is the user's switch", async () => {
	let handler: any;
	killExtension({ on: (name: string, fn: any) => { assert.equal(name, "tool_call"); handler = fn; } } as any);
	const event = { toolName: "bash", input: { command: blocked[0] } };
	assert.equal(handler(event).block, true);
	assert.equal(handler({ ...event, toolName: "read" }), undefined);
	assert.equal(handler({ toolName: "bash", input: {} }), undefined);
	assert.equal(handler({ toolName: "bash", input: { command: 123 } }), undefined);
	assert.equal(handler({ toolName: "bash", input: { command: "kill 1234" } }), undefined);
	let command: any;
	guardsExtension({ registerCommand: (_: string, spec: any) => { command = spec; },
		on: () => {}, events: { on: () => {} } } as any);
	const ctx = { hasUI: true, ui: { setStatus: () => {}, notify: () => {} } };
	await command.handler("off kill", ctx);
	assert.equal(handler(event), undefined);
	await command.handler("on kill", ctx);
	assert.equal(handler(event).block, true);
});
