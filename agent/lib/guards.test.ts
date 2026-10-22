/** Guard compatibility regressions: every registered name shares status,
 * persistence and command behaviour; extension safety checks must stay intact.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { GUARD_NAMES, guardStatus, isGuardOff, setGuards } from "./guards.ts";
import guardsExtension from "../extensions/guards.ts";
import cratisExtension, { DEFAULT_PRODUCTION_CONFIG, classifyCratisInvocations, forwardedPorts, readOnlyList, productionSources, productionTarget } from "../extensions/cratis-cli-guard.ts";
import waitExtension, { assess, PollTracker } from "../extensions/wait-guard.ts";

const key = Symbol.for("pi.guards");
let directory: string;
let file: string;
let previousFile: string | undefined;
let previousEnv: string | undefined;
let previousState: unknown;
let warnings: string[];
const ORCH_ENV = ["PI_ORCH_ID", "PI_ORCH_MODE_FILE", "PI_ORCH_REPO_ROOT", "PI_ORCH_MESSAGES_DIR", "PI_GUARD_DECISIONS_LOG"];
let previousOrch: Record<string, string | undefined>;
let context = "Test context: chronicle://user:<password>@localhost\n";

let productionDirectory = "";
const CRATIS_CONFIG = JSON.stringify({ activeContext: "default", contexts: {
	default: { server: "chronicle://localhost:35000", clientId: "dev" },
	"my-dev": { server: "chronicle://localhost:36000", clientId: "dev" },
	"fwd-dev": { server: "chronicle://localhost:37000", clientId: "dev" },
	studio: { server: "chronicle://localhost:1", clientId: "Cratis-Studio" },
	cloud: { server: "chronicle://x.upcloudlb.com:7443", clientId: "dev" },
} });
beforeEach(() => {
	previousFile = process.env.PI_GUARDS_FILE;
	previousEnv = process.env.PI_GUARDS_OFF;
	previousState = (globalThis as any)[key];
	directory = mkdtempSync(join(tmpdir(), "pi-guards-test-"));
	file = join(directory, "guards.json");
	process.env.PI_GUARDS_FILE = file;
	delete process.env.PI_GUARDS_OFF;
	delete (globalThis as any)[key];
	warnings = [];
	// Guard tests run outside orchestration unless a test opts in with PI_ORCH_ID.
	previousOrch = Object.fromEntries(ORCH_ENV.map(name => [name, process.env[name]]));
	delete process.env.PI_ORCH_ID;
	process.env.PI_ORCH_MODE_FILE = join(directory, "orchestration-mode");
	process.env.PI_ORCH_REPO_ROOT = join(directory, "repos");
	process.env.PI_ORCH_MESSAGES_DIR = join(directory, "messages");
	process.env.PI_GUARD_DECISIONS_LOG = join(directory, "guard-decisions.jsonl");
	context = "Test context: chronicle://user:<password>@localhost\n";
	productionDirectory = mkdtempSync(join(tmpdir(), "pi-prod-test-"));
	process.env.PI_CRATIS_PRODUCTION_FILE = join(productionDirectory, "cratis-production.json");
	writeFileSync(process.env.PI_CRATIS_PRODUCTION_FILE, JSON.stringify(DEFAULT_PRODUCTION_CONFIG));
	productionSources.readProcessList = async () => "/sbin/launchd\n";
	productionSources.readCratisConfig = () => CRATIS_CONFIG;
	mock.method(console, "warn", (message: string) => { warnings.push(message); });
	mock.method(childProcess, "execFile", (_command: string, _args: string[], _options: unknown, callback: Function) => {
		if (context === "") callback(new Error("no context"), "");
		else callback(null, context);
	});
	syncBuiltinESMExports();
});

afterEach(() => {
	mock.timers.reset();
	for (const [name, value] of Object.entries(previousOrch)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	mock.restoreAll();
	syncBuiltinESMExports();
	if (previousFile === undefined) delete process.env.PI_GUARDS_FILE;
	else process.env.PI_GUARDS_FILE = previousFile;
	if (previousEnv === undefined) delete process.env.PI_GUARDS_OFF;
	else process.env.PI_GUARDS_OFF = previousEnv;
	if (previousState === undefined) delete (globalThis as any)[key];
	else (globalThis as any)[key] = previousState;
	// Only this test's fresh, uniquely named directory is removed.
	rmSync(directory, { recursive: true });
});

function fake(hasUI = true) {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const listeners = new Map<string, Function[]>();
	const notices: { text: string; type: string }[] = [];
	const selections: { title: string; options: string[]; opts?: any }[] = [];
	const statuses: { key: string; text: string | undefined }[] = [];
	let choice: string | undefined = "Yes, run it";
	const ctx: any = {
		hasUI,
		ui: {
			notify: (text: string, type: string) => notices.push({ text, type }),
			select: async (title: string, options: string[], opts?: any) => {
				selections.push({ title, options, opts });
				return choice === HANG ? new Promise<string | undefined>(() => {}) : choice;
			},
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
		},
	};
	const pi: any = {
		registerCommand: (name: string, options: unknown) => commands.set(name, options),
		on: (name: string, handler: Function) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => handlers.set(name, handlers.get(name)!.filter(value => value !== handler));
		},
		getActiveTools: () => ["bash", "job_start"],
		events: {
			on: (name: string, handler: Function) => {
				listeners.set(name, [...(listeners.get(name) ?? []), handler]);
				return () => listeners.set(name, listeners.get(name)!.filter(value => value !== handler));
			},
			emit: (name: string, data: unknown) => { for (const handler of listeners.get(name) ?? []) handler(data); },
		},
	};
	return {
		pi, ctx, commands, notices, selections, statuses,
		choose: (value: string | undefined) => { choice = value; },
		fire: async (name: string, event: unknown = {}) => {
			for (const handler of handlers.get(name) ?? []) {
				const result = await handler(event, ctx);
				if (result?.block) return result;
			}
			return undefined;
		},
	};
}

const HANG = "\u0000hang";
function decisions() {
	try { return readFileSync(process.env.PI_GUARD_DECISIONS_LOG!, "utf8").trim().split("\n").map(line => JSON.parse(line)); }
	catch { return []; }
}

function entry(name: string) { return guardStatus().find(status => status.name === name)!; }
function stored(off = false, overrides: Record<string, boolean> = {}) {
	return { off: Object.fromEntries(GUARD_NAMES.map(name => [name, overrides[name] ?? off])) };
}
function bash(command: string, timeout?: number) {
	return { toolName: "bash", input: { command, ...(timeout !== undefined ? { timeout } : {}) } };
}
function approval(pi: any) {
	let accepting = true;
	let claimed: (() => string) | undefined;
	pi.events.emit("pi-mcp-adapter:tool-approval-request", {
		prefixedToolName: "test_delete",
		claim: (handler: () => string) => {
			assert.equal(accepting, true, "approval must be claimed during synchronous emission");
			if (claimed) return false;
			claimed = handler;
			return true;
		},
	});
	accepting = false;
	return claimed;
}

test("missing file defaults to on, warns once and never creates a file", () => {
	assert.deepEqual(guardStatus(), GUARD_NAMES.map(name => ({ name, off: false, source: "default" })));
	assert.equal(isGuardOff("cratis"), false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /guards default to on/);
	assert.equal(existsSync(file), false);
});

test("missing file honors deliberate env opt-outs, below session overrides", () => {
	process.env.PI_GUARDS_OFF = "cratis,mcp";
	assert.deepEqual(guardStatus(), GUARD_NAMES.map(name => ({
		name, off: ["cratis", "mcp"].includes(name), source: ["cratis", "mcp"].includes(name) ? "env" : "default",
	})));
	setGuards("mcp", false);
	assert.deepEqual(entry("mcp"), { name: "mcp", off: false, source: "session" });
	assert.equal(existsSync(file), false);
});

test("precedence is session over persisted over env, including explicit on", () => {
	process.env.PI_GUARDS_OFF = "cratis,mcp,wait";
	writeFileSync(file, JSON.stringify({ off: { cratis: false, mcp: true } }));
	assert.deepEqual(entry("wait"), { name: "wait", off: true, source: "env" });
	assert.deepEqual(entry("cratis"), { name: "cratis", off: false, source: "persisted" });
	setGuards(["mcp"], false);
	assert.deepEqual(entry("mcp"), { name: "mcp", off: false, source: "session" });
	setGuards("cratis", true);
	assert.deepEqual(entry("cratis"), { name: "cratis", off: true, source: "session" });
});

test("all expands in env and session, and on reverses off", () => {
	process.env.PI_GUARDS_OFF = " all ";
	assert.ok(guardStatus().every(status => status.off && status.source === "env"));
	setGuards("all", false);
	assert.ok(guardStatus().every(status => !status.off && status.source === "session"));
	setGuards(["all"], true);
	assert.ok(guardStatus().every(status => status.off));
	assert.equal(existsSync(file), false);
});

test("unknown guard throws a clear error before changing any state", () => {
	assert.throws(() => setGuards(["cratis", "unknown"], true), new RegExp(`Unknown guard 'unknown'.*${GUARD_NAMES.join(", ")} or all`));
	assert.throws(() => setGuards(["all", "unknown"], true), /Unknown guard/);
	assert.throws(() => isGuardOff("unknown" as any), /Unknown guard/);
	assert.ok(guardStatus().every(status => !status.off));
});

test("invalid env fails safe with a clear warning", () => {
	process.env.PI_GUARDS_OFF = "cratis,unknown";
	assert.ok(guardStatus().every(status => !status.off));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /Unknown guard 'unknown'/);
});

test("corrupt file fails safe, warns once, and permits an explicit session override", () => {
	process.env.PI_GUARDS_OFF = "all";
	writeFileSync(file, "{invalid");
	assert.ok(guardStatus().every(status => !status.off));
	assert.equal(isGuardOff("wait"), false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /Cannot read.*Guards default to on/);
	setGuards("cratis", true);
	assert.equal(isGuardOff("cratis"), true);
	assert.equal(isGuardOff("mcp"), false);
});

test("invalid persistent schema also fails safe", () => {
	for (const data of [null, [], {}, { off: { unknown: true } }, { off: { cratis: "off" } }, { off: [], extra: true }]) {
		writeFileSync(file, JSON.stringify(data));
		assert.ok(guardStatus().every(status => !status.off));
	}
	assert.equal(warnings.length, 1);
});

test("persist round-trip merges settings, replaces selected session values and reaches another process", () => {
	process.env.PI_GUARDS_OFF = "all";
	setGuards("cratis", true);
	setGuards("mcp", false, { persist: true });
	assert.deepEqual(entry("mcp"), { name: "mcp", off: false, source: "persisted" });
	assert.equal(entry("cratis").source, "session");
	setGuards("cratis", false, { persist: true });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), stored());
	assert.equal(entry("cratis").source, "persisted");
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import { guardStatus } from ${JSON.stringify(new URL("./guards.ts", import.meta.url).href)};
		console.log(JSON.stringify(guardStatus()));
	`], { encoding: "utf8", env: process.env });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), guardStatus());
	setGuards("all", true, { persist: true });
	assert.ok(guardStatus().every(status => status.off && status.source === "persisted"));
	setGuards("all", false, { persist: true });
	assert.ok(guardStatus().every(status => !status.off && status.source === "persisted"));
});

test("repairing a corrupt file persists all guards on without re-enabling env opt-outs", async () => {
	process.env.PI_GUARDS_OFF = "all";
	writeFileSync(file, "{invalid");
	assert.ok(guardStatus().every(status => !status.off));
	const app = fake();
	guardsExtension(app.pi);
	await app.commands.get("guards").handler("on wait --persist", app.ctx);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), stored());
	assert.ok(guardStatus().every(status => !status.off && status.source === "persisted"));
	assert.equal(existsSync(`${file}.lock`), false);
});

test("repairing an unreadable file also persists fail-safe values instead of env", () => {
	process.env.PI_GUARDS_OFF = "all";
	writeFileSync(file, JSON.stringify({ off: { cratis: true } }));
	const read = fs.readFileSync;
	const reader = mock.method(fs, "readFileSync", (...args: any[]) => {
		if (args[0] === file) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
		return (read as any)(...args);
	});
	syncBuiltinESMExports();
	assert.ok(guardStatus().every(status => !status.off));
	setGuards("wait", false, { persist: true });
	reader.mock.restore();
	syncBuiltinESMExports();
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), stored());
	assert.equal(existsSync(`${file}.lock`), false);
});

test("persistent named updates retain only persisted values and fill omissions with on", () => {
	process.env.PI_GUARDS_OFF = "all";
	writeFileSync(file, JSON.stringify({ off: { cratis: true } }));
	setGuards("cratis", false); // process-only override must not change the stored cratis value
	setGuards("wait", true, { persist: true });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), stored(false, { cratis: true, wait: true }));
	assert.equal(entry("cratis").source, "session");
	assert.equal(isGuardOff("mcp"), false);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(existsSync(`${file}.lock`), false);
});

test("first persisted write fills every guard with on rather than inheriting env", () => {
	process.env.PI_GUARDS_OFF = "all";
	assert.ok(guardStatus().every(status => status.off));
	setGuards("wait", false, { persist: true });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), stored());
	assert.ok(guardStatus().every(status => !status.off));
});

test("concurrent child-process named updates all survive", { timeout: 10000 }, async () => {
	writeFileSync(file, JSON.stringify({ off: { cratis: false, mcp: false, wait: false } }));
	const children = GUARD_NAMES.map(name => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", `
			import fs from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			import { setGuards } from ${JSON.stringify(new URL("./guards.ts", import.meta.url).href)};
			const read = fs.readFileSync;
			fs.readFileSync = (...args) => {
				const result = read(...args);
				if (args[0] === process.env.PI_GUARDS_FILE) {
					// Force overlapping read/merge attempts: unlocked writes would lose two updates.
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
				}
				return result;
			};
			syncBuiltinESMExports();
			process.once("message", () => {
				setGuards(${JSON.stringify(name)}, true, { persist: true });
				process.disconnect();
			});
			process.send("ready");
		`], { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
		let stderr = "";
		child.stderr!.on("data", chunk => { stderr += chunk; });
		const ready = new Promise<void>((resolve, reject) => {
			child.once("message", () => resolve());
			child.once("error", reject);
		});
		const finished = new Promise<{ code: number | null; stderr: string }>(resolve => {
			child.once("close", code => resolve({ code, stderr }));
		});
		return { child, ready, finished };
	});
	try {
		await Promise.all(children.map(child => child.ready));
		for (const { child } of children) child.send("go");
		const results = await Promise.all(children.map(child => child.finished));
		for (const result of results) assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), stored(true));
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(existsSync(`${file}.lock`), false);
	} finally {
		for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
		await Promise.all(children.map(child => child.finished));
	}
});

test("an abandoned stale persistence lock is recovered", () => {
	writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2147483647 }));
	const old = new Date(Date.now() - 10000);
	utimesSync(`${file}.lock`, old, old);
	setGuards("mcp", true, { persist: true });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), stored(false, { mcp: true }));
	assert.equal(existsSync(`${file}.lock`), false);
});

test("a live lock is not stolen even when old; /guards reports timeout without writing", async () => {
	const original = JSON.stringify({ off: { cratis: true, mcp: false, wait: false } });
	writeFileSync(file, original);
	writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid }));
	const old = new Date(Date.now() - 10000);
	utimesSync(`${file}.lock`, old, old);
	const app = fake();
	guardsExtension(app.pi);
	await app.commands.get("guards").handler("off wait --persist", app.ctx);
	assert.equal(app.notices.at(-1)?.type, "error");
	assert.match(app.notices.at(-1)!.text, /Cannot acquire guards persistence lock .* within 1000ms; try again/);
	assert.equal(readFileSync(file, "utf8"), original);
	assert.equal(readFileSync(`${file}.lock`, "utf8"), JSON.stringify({ pid: process.pid }));
	assert.equal(isGuardOff("wait"), false);
	unlinkSync(`${file}.lock`);
});

test("write failures release the lock and leave no temporary file", () => {
	const original = JSON.stringify({ off: { cratis: false, mcp: false, wait: false } });
	writeFileSync(file, original);
	mock.method(fs, "renameSync", () => { throw new Error("rename failed"); });
	syncBuiltinESMExports();
	assert.throws(() => setGuards("mcp", true, { persist: true }), /rename failed/);
	assert.equal(readFileSync(file, "utf8"), original);
	assert.deepEqual(readdirSync(directory), ["guards.json"]);
});

test("external persisted edits are read on every call, but session still wins", () => {
	writeFileSync(file, JSON.stringify({ off: { wait: false } }));
	assert.equal(isGuardOff("wait"), false);
	writeFileSync(file, JSON.stringify({ off: { wait: true } }));
	assert.equal(isGuardOff("wait"), true);
	setGuards("wait", false);
	assert.equal(isGuardOff("wait"), false);
});

test("separate module instances use the same global process state", async () => {
	setGuards("mcp", true);
	const other = await import("./guards.ts?second-instance");
	assert.equal(other.isGuardOff("mcp"), true);
	other.setGuards("mcp", false);
	assert.equal(isGuardOff("mcp"), false);
});

test("cratis on prompts with the existing title/options, allows yes and blocks no", async () => {
	const app = fake();
	cratisExtension(app.pi);
	assert.equal(await app.fire("tool_call", bash("cratis chronicle replay observer")), undefined);
	assert.deepEqual(app.selections[0].options, ["No", "Yes, run it"]);
	assert.equal(app.selections[0].title,
		"⚠️ cratis command that may change state:\n\n  cratis chronicle replay observer\n\nActive context:\nTest context: chronicle://user:***@localhost\n\n" +
		"Check the target (--server / CHRONICLE_CONNECTION_STRING override the context). Run it?");
	app.choose("No");
	assert.deepEqual(await app.fire("tool_call", bash("cratis prologue start")), {
		block: true, reason: "cratis-cli-guard: the user declined this cratis command.",
	});
	app.choose(undefined);
	assert.equal((await app.fire("tool_call", bash("cratis chronicle replay observer")))?.block, true);
	assert.equal(app.notices.length, 0);
});

test("cratis on still blocks without UI", async () => {
	const app = fake(false);
	cratisExtension(app.pi);
	const result = await app.fire("tool_call", bash("cratis chronicle replay observer"));
	assert.equal(result?.block, true);
	assert.match(result.reason, /state-changing or unrecognised cratis command\(s\) blocked without a UI/);
	assert.equal(app.selections.length, 0);
});

test("cratis off allows risky calls without prompting, including headless, and does not notify for reads", async () => {
	setGuards("cratis", true);
	for (const hasUI of [true, false]) {
		const app = fake(hasUI);
		cratisExtension(app.pi);
		for (const command of ["cratis chronicle replay observer", "cratis prologue start"]) {
			assert.equal(await app.fire("tool_call", bash(command)), undefined);
		}
		assert.equal(app.selections.length, 0);
		assert.equal(app.notices.length, hasUI ? 2 : 0);
		if (hasUI) assert.equal(app.notices[0].text, "cratis-cli-guard off: allowed 'cratis chronicle replay observer'");
		await app.fire("tool_call", bash("cratis chronicle jobs list"));
		await app.fire("tool_call", bash("printf 'cratis chronicle replay'"));
		assert.equal(app.notices.length, hasUI ? 2 : 0);
	}
});

test("cratis classifier ignores heredoc bodies and quoted prose but still finds real command lines", () => {
	// Regression for the L0 stall: prose in a message file was classified as a cratis call.
	for (const command of [
		"cat > .ai-work/x/messages/m.md <<'EOF'\n...run cratis chronicle observers replay...\nEOF",
		"mkdir -p .ai-work/x/messages && cat > .ai-work/x/messages/m.md <<'EOF'\ncratis chronicle observers replay x\nEOF\necho done >> STATE.md",
		"cat > a.md <<'EOF'\ncratis chronicle observers replay x\nEOF\nmv a.md b.md && cat b.md",
		"echo 'cratis chronicle observers replay' > .ai-work/m.md && printf '%s' \"cratis chronicle replay\"",
		"git commit -m 'cratis chronicle observers replay'",
	]) assert.deepEqual(classifyCratisInvocations(command), [], command);
	for (const command of [
		"cratis chronicle observers replay x",
		"cd repo && cratis chronicle observers replay x",
		"cat > a.md <<'EOF'\nx\nEOF\ncratis chronicle observers replay x",
		"cat > m.sh <<'EOF'\ncratis chronicle observers replay x\nEOF\nbash m.sh",
		"cat > m.sh <<'EOF'\ncratis chronicle observers replay x\nEOF\nchmod +x m.sh; ./m.sh",
		"PATH=/tmp:$PATH; cat > m.md <<'EOF'\ncratis chronicle observers replay x\nEOF",
		"tee m.md <<'EOF' | bash\ncratis chronicle observers replay x\nEOF",
		"cat <<'EOF' | sh\ncratis chronicle observers replay x\nEOF",
		"cat > m.md <<EOF\n$(cratis chronicle observers replay x)\nEOF\necho hi",
		"bash -c 'cratis chronicle observers replay x'",
	]) assert.equal(classifyCratisInvocations(command).filter(i => !i.readOnly).length > 0, true, command);
});

test("cratis heredoc message with prose never prompts, in any session", async () => {
	const app = fake();
	cratisExtension(app.pi);
	assert.equal(await app.fire("tool_call", bash("cat > .ai-work/x/messages/m.md <<'EOF'\n...run cratis chronicle observers replay...\nEOF")), undefined);
	assert.equal(app.selections.length, 0);
});

test("cratis prompt outside orchestration has a 60 s limit and a timeout denies with an actionable reason", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const app = fake();
	cratisExtension(app.pi);
	app.choose(HANG);
	const pending = app.fire("tool_call", bash("cratis chronicle replay observer"));
	for (let i = 0; i < 5 && !app.selections.length; i++) await new Promise(resolve => setImmediate(resolve));
	assert.equal(app.selections[0].opts.timeout, 60000);
	mock.timers.tick(60000);
	const result = await pending;
	assert.equal(result?.block, true);
	assert.match(result.reason, /no answer to the confirmation within 60 s[\s\S]*Report the exact command/);
	assert.deepEqual(decisions().map(d => [d.guard, d.decision]), [["cratis", "timeout:deny"]]);
	assert.equal(existsSync(process.env.PI_ORCH_MESSAGES_DIR!), false);
});

test("cratis in orchestration never prompts: allows and logs, denies production targets immediately", async () => {
	process.env.PI_ORCH_ID = "L0";
	for (const hasUI of [true, false]) {
		const app = fake(hasUI);
		cratisExtension(app.pi);
		app.choose(HANG);
		assert.equal(await app.fire("tool_call", bash("cratis chronicle observers replay x")), undefined);
		assert.equal(await app.fire("tool_call", bash("cratis prologue start")), undefined);
		for (const command of ["cratis chronicle observers replay x --server chronicle://prod-db:35000", "CHRONICLE_CONNECTION_STRING=chronicle://production:35000 cratis chronicle jobs stop 1"]) {
			const result = await app.fire("tool_call", bash(command));
			assert.equal(result?.block, true, command);
			assert.match(result.reason, /denied on production \(read-only list: diagnose, auth status,[^)]*\); ask L0\. Matched rule: the command names a production target\./);
		}
		context = "Context: production\nServer: chronicle://cluster:35000\n";
		assert.match((await app.fire("tool_call", bash("cratis chronicle observers replay x")))?.reason, /active cratis context is a production context/);
		context = "";
		assert.match((await app.fire("tool_call", bash("cratis chronicle observers replay x")))?.reason, /could not be read/);
		context = "Test context: chronicle://user:<password>@localhost\n";
		assert.equal(await app.fire("tool_call", bash("cratis chronicle jobs list")), undefined);
		assert.equal(app.selections.length, 0);
	}
	assert.deepEqual(decisions().map(d => d.decision), ["allow", "allow", "deny", "deny", "deny", "deny", "allow", "allow", "allow", "deny", "deny", "deny", "deny", "allow"]);
	assert.equal(productionTarget("cratis chronicle replay --server chronicle://localhost:35000", "dev"), undefined);
	assert.match(productionTarget("x", "dev", { CHRONICLE_CONNECTION_STRING: "chronicle://prod:1" })!, /CHRONICLE_CONNECTION_STRING/);
	assert.equal(productionTarget("cratis chronicle replay products", "dev"), undefined);
});

async function orchestrated(command: string, ctxText: string, ps = "/sbin/launchd\n", hasUI = true) {
	process.env.PI_ORCH_ID = "L0";
	context = ctxText;
	productionSources.readProcessList = async () => { if (ps === "FAIL") throw new Error("ps failed"); return ps; };
	const app = fake(hasUI);
	cratisExtension(app.pi);
	app.choose(HANG);
	const result = await app.fire("tool_call", bash(command));
	assert.equal(app.selections.length, 0, "never prompts in orchestration");
	return result;
}
const PROD_CTX = "Context: ro-verify-1\nServer: chronicle://localhost:35931/x\nClient ID: someone\n";
const DEV_CTX = "Context: default\nServer: chronicle://localhost:35000/Ada\nClient ID: dev\n";

test("production list: read-only commands stay allowed (and logged), state-changing ones are denied", async () => {
	for (const command of ["cratis chronicle observers list --context ro-verify-1", "cratis chronicle events tail --context ro-verify-1", "cratis chronicle events get x", "cratis chronicle jobs list"]) {
		assert.equal(await orchestrated(command, PROD_CTX, "kubectl port-forward svc/chronicle 35931:35000\n"), undefined, command);
	}
	assert.deepEqual(decisions().map(d => d.decision), ["allow", "allow", "allow", "allow"]);
	assert.match(decisions()[0].detail, /^read-only: cratis chronicle observers list/);
	for (const command of ["cratis chronicle observers replay x --context ro-verify-1", "cratis chronicle observers replay x"]) {
		const result = await orchestrated(command, command.includes("--context") ? DEV_CTX : PROD_CTX);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /context ro-verify-1 is listed in cratis-production\.json/);
	}
});

test("production list: listed context, client id, host and port-forward port deny; ps failure and dev context do not", async () => {
	const replay = "cratis chronicle observers replay x";
	assert.match((await orchestrated(`${replay} --context=L3C-9`, DEV_CTX))?.reason, /context L3C-9 is listed/);
	assert.match((await orchestrated(replay, "Context: diag-77\nServer: chronicle://localhost:1\n"))?.reason, /context diag-77 is listed/);
	assert.match((await orchestrated(replay, "Context: x\nServer: chronicle://localhost:1\nClient ID: Cratis-Studio\n"))?.reason, /client id Cratis-Studio is listed/);
	assert.match((await orchestrated(`${replay} --server chronicle://a.upcloudlb.com:7443`, DEV_CTX))?.reason, /host upcloudlb\.com/);
	assert.match((await orchestrated(replay, "Context: x\nServer: chronicle://localhost:35931/e\n", "kubectl --kubeconfig k port-forward -n infrastructure svc/chronicle 35931:35000\n"))?.reason, /localhost:35931 .*port-forward/);
	assert.match((await orchestrated(`${replay} --server chronicle://localhost:4444`, DEV_CTX, "/usr/bin/kubectl port-forward svc/c 4444\n"))?.reason, /localhost:4444/);
	// ps failure alone, unlisted localhost contexts, and a port-forward on another port are allowed.
	assert.equal(await orchestrated(replay, "Context: x\nServer: chronicle://localhost:35931/e\n", "FAIL"), undefined);
	assert.equal(await orchestrated(replay, DEV_CTX), undefined);
	assert.equal(await orchestrated(replay, DEV_CTX, "kubectl port-forward svc/chronicle 35931:35000\n"), undefined);
	assert.match((await orchestrated(replay, DEV_CTX, "kubectl port-forward svc/chronicle 35000:35000\n"))?.reason, /localhost:35000/);
});

test("production list: read at every check, missing or invalid file falls back to defaults with one log line", async () => {
	const replay = "cratis chronicle observers replay x";
	writeFileSync(process.env.PI_CRATIS_PRODUCTION_FILE!, JSON.stringify({ ...DEFAULT_PRODUCTION_CONFIG, contexts: ["default"] }));
	assert.match((await orchestrated(replay, DEV_CTX))?.reason, /context default is listed/);
	unlinkSync(process.env.PI_CRATIS_PRODUCTION_FILE!);
	assert.match((await orchestrated(`${replay} --context ro-check-1`, DEV_CTX))?.reason, /listed in cratis-production\.json/);
	assert.deepEqual(decisions().map(d => d.decision), ["deny", "config", "deny"]);
	writeFileSync(process.env.PI_CRATIS_PRODUCTION_FILE!, "{not json");
	assert.match((await orchestrated(`${replay} --context diag-1`, DEV_CTX))?.reason, /listed in/);
});

test("production list: --context not in the list is looked up in ~/.cratis/config.json", async () => {
	const replay = "cratis chronicle observers replay x";
	assert.equal(await orchestrated(`${replay} --context my-dev`, PROD_CTX), undefined, "active prod context does not leak into a named dev context");
	assert.equal(await orchestrated(`${replay} --context=MY-DEV`, DEV_CTX, "kubectl port-forward svc/c 35000:35000\n"), undefined);
	assert.match((await orchestrated(`${replay} --context fwd-dev`, DEV_CTX, "kubectl port-forward svc/c 37000:35000\n"))?.reason, /localhost:37000 .*port-forward/);
	assert.match((await orchestrated(`${replay} --context studio`, DEV_CTX))?.reason, /client id Cratis-Studio is listed/);
	assert.match((await orchestrated(`${replay} --context cloud`, DEV_CTX))?.reason, /host upcloudlb\.com/);
	assert.match((await orchestrated(`${replay} --context nope`, DEV_CTX))?.reason, /context nope is not defined in ~\/\.cratis\/config\.json/);
	productionSources.readCratisConfig = () => { throw new Error("no file"); };
	assert.match((await orchestrated(`${replay} --context my-dev`, DEV_CTX))?.reason, /context my-dev is not defined/);
	assert.equal(await orchestrated("cratis chronicle observers list --context nope", DEV_CTX), undefined, "read-only is never looked up");
});

test("production list: extraReadOnly extends the read-only list; the denial names command, list and rule", async () => {
	const file = process.env.PI_CRATIS_PRODUCTION_FILE!;
	const command = "cratis chronicle events read --context ro-verify-1";
	const denied = await orchestrated(command, DEV_CTX);
	assert.equal(denied?.block, true);
	assert.ok(denied.reason.includes(command));
	assert.ok(denied.reason.includes(`denied on production (read-only list: ${readOnlyList().join(", ")}); ask L0`));
	assert.match(denied.reason, /Matched rule: context ro-verify-1 is listed in cratis-production\.json/);
	assert.equal(readOnlyList().join(", ").startsWith("diagnose, auth status, applications list"), true);
	writeFileSync(file, JSON.stringify({ ...DEFAULT_PRODUCTION_CONFIG, extraReadOnly: ["Events Read", "observers  STATE"] }));
	assert.equal(await orchestrated(command, DEV_CTX), undefined);
	assert.equal(await orchestrated("cratis chronicle observers state x --context ro-verify-1", DEV_CTX), undefined);
	const other = await orchestrated("cratis chronicle observers replay x --context ro-verify-1", DEV_CTX);
	assert.ok(other.reason.includes(`(read-only list: ${readOnlyList().join(", ")}, events read, observers state); ask L0`));
	assert.deepEqual(classifyCratisInvocations("cratis chronicle events read", 0, ["events read"]).map(i => i.readOnly), [true]);
	assert.deepEqual(classifyCratisInvocations("cratis chronicle events read").map(i => i.readOnly), [false]);
});

test("production list: outside orchestration the prompt shows the production reason", async () => {
	const app = fake();
	cratisExtension(app.pi);
	context = PROD_CTX;
	await app.fire("tool_call", bash("cratis chronicle observers replay x"));
	assert.match(app.selections[0].title, /PRODUCTION: context ro-verify-1 is listed in cratis-production\.json/);
	assert.deepEqual(app.selections[0].options, ["No", "Yes, run it"]);
});

test("forwardedPorts parses kubectl port-forward forms and reports ps failure as unknown", async () => {
	productionSources.readProcessList = async () => "kubectl port-forward -n infrastructure svc/chronicle 35931:35000\nkubectl port-forward pod/x 8080\nkubectl port-forward svc/y :9000\nvim kubectl-port-forward.md\n";
	assert.deepEqual(await forwardedPorts(), [35931, 8080]);
	productionSources.readProcessList = async () => { throw new Error("x"); };
	assert.equal(await forwardedPorts(), undefined);
});

test("wait in orchestration allows over-limit timeouts (logged) but keeps immediate polling denials", async () => {
	const outside = fake();
	waitExtension(outside.pi);
	assert.equal((await outside.fire("tool_call", bash("printf ok", 601)))?.block, true);
	process.env.PI_ORCH_ID = "L0";
	const app = fake();
	waitExtension(app.pi);
	const event = bash("printf ok", 601);
	assert.equal(await app.fire("tool_call", event), undefined);
	assert.equal((event.input as any).timeout, 601);
	const poll = bash("while true; do gh pr checks 1; sleep 30; done");
	assert.deepEqual(await app.fire("tool_call", poll), { block: true, reason: assess(poll.input.command, undefined, true).block });
	assert.equal(app.selections.length, 0);
	assert.deepEqual(decisions().map(d => [d.guard, d.decision]), [["wait", "allow"]]);
});

test("wait on keeps original block messages and default timeout", async () => {
	const app = fake();
	waitExtension(app.pi);
	const event = bash("while true; do gh pr checks 1; sleep 30; done");
	assert.deepEqual(await app.fire("tool_call", event), { block: true, reason: assess(event.input.command, undefined, true).block });
	const plain = bash("printf ok");
	assert.equal(await app.fire("tool_call", plain), undefined);
	assert.equal((plain.input as any).timeout, 600);
	assert.equal((await app.fire("tool_call", bash("printf ok", 601)))?.block, true);
	assert.equal(app.notices.length, 0);
});

test("PollTracker blocks the third identical status query within 15 minutes only", () => {
	const t = new PollTracker();
	const q = "gh pr checks 12 --repo Cratis/Arc";
	assert.equal(t.check(q, 0), false);
	assert.equal(t.check("gh  pr checks 12   --repo Cratis/Arc", 60_000), false);
	assert.equal(t.check(q, 120_000), true);
	assert.equal(t.check("gh pr checks 13 --repo Cratis/Arc", 120_000), false);
	assert.equal(t.check(q, 16 * 60_000 + 60_000), false);
	for (const other of ["gh run view 5 --log-failed", "gh pr checks 12 --watch", "git status", "gh api repos/x/y/actions/runs"])
		for (let i = 0; i < 4; i++) assert.equal(t.check(other, 0), false);
});

test("PollTracker only counts real gh invocations, keeps quoted arguments distinct and resets on push", () => {
	const t = new PollTracker();
	for (let i = 0; i < 4; i++) assert.equal(t.check('printf "gh pr checks 12"', 0), false);
	for (let i = 0; i < 4; i++) assert.equal(t.check("gh pr view 12; printf statusCheckRollup", 0), false);
	for (let i = 0; i < 4; i++) assert.equal(t.check("cat <<'EOF'\ngh pr checks 12\nEOF", 0), false);
	assert.equal(t.check('gh run list --workflow "Deploy Prod"', 0), false);
	assert.equal(t.check('gh run list --workflow "Deploy Prod"', 0), false);
	assert.equal(t.check('gh run list --workflow "Deploy  Prod"', 0), false);
	assert.equal(t.check('gh run list --workflow "Deploy Prod"', 0), true);
	assert.equal(t.check('gh run list --workflow "Deploy Prod"; printf -- "--log-failed"', 0), true);
	assert.equal(t.check("git push origin HEAD", 0), false);
	assert.equal(t.check('gh run list --workflow "Deploy Prod"', 0), false);
	assert.equal(t.check("rtk proxy gh pr checks 9 && echo x", 0), false);
	assert.equal(t.check("GH_PAGER= gh pr checks 9", 0), false);
	assert.equal(t.check("gh pr checks 9", 0), true);
});

test("foreground watch is detected only in real gh invocations", () => {
	assert.ok(assess("cd x && gh run watch 5 --exit-status", undefined, true).block);
	assert.ok(assess("gh pr checks 3 --repo o/r --watch", undefined, true).block);
	assert.equal(assess("cat > notes.md <<'EOF'\nUse gh run watch <id> --exit-status\nEOF", undefined, true).block, undefined);
	assert.equal(assess('git commit -m "document gh pr checks --watch"', undefined, true).block, undefined);
	assert.ok(assess("gh pr checks 1 \\\n  --watch", undefined, true).block);
	assert.ok(assess("timeout 500 gh run watch 1", undefined, true).block);
	assert.ok(assess("timeout -k 5 --foreground 500 gh run watch 1", undefined, true).block);
	assert.ok(assess('bash -c "gh run watch 1"', undefined, true).block);
	assert.ok(assess("sh -lc 'cd x && gh pr checks 2 --watch'", undefined, true).block);
	assert.equal(assess("bash scripts/watch-docs.sh", undefined, true).block, undefined);
});

test("PollTracker keeps double-quoted backslashes that the shell keeps", () => {
	const t = new PollTracker();
	assert.equal(t.check('gh run list --workflow "Deploy\\ Prod"', 0), false);
	assert.equal(t.check('gh run list --workflow "Deploy\\ Prod"', 0), false);
	assert.equal(t.check('gh run list --workflow "Deploy Prod"', 0), false);
	assert.equal(t.check('gh run list --workflow "Deploy\\ Prod"', 0), true);
});

test("wait on blocks a repeated status poll across calls", async () => {
	const app = fake();
	waitExtension(app.pi);
	assert.equal(await app.fire("tool_call", bash("gh run list --repo o/r --limit 1")), undefined);
	assert.equal(await app.fire("tool_call", bash("gh run list --repo o/r --limit 1")), undefined);
	assert.equal((await app.fire("tool_call", bash("gh run list --repo o/r --limit 1")))?.block, true);
});

test("wait off allows every block class, preserves explicit timeouts and sets the default even headless", async () => {
	setGuards("wait", true);
	for (const hasUI of [true, false]) {
		const app = fake(hasUI);
		waitExtension(app.pi);
		for (const command of [
			"while true; do gh pr checks 1; sleep 30; done",
			"for x in 1 2; do sleep 30; done", "sleep 60", "gh run watch 123", "gh pr checks 1 --watch",
		]) {
			const event = bash(command);
			assert.equal(await app.fire("tool_call", event), undefined);
			assert.equal((event.input as any).timeout, 600);
		}
		const long = bash("printf ok", 900);
		assert.equal(await app.fire("tool_call", long), undefined);
		assert.equal(long.input.timeout, 900);
		assert.equal(app.notices.length, hasUI ? 6 : 0);
		const safe = bash("printf ok", 10);
		assert.equal(await app.fire("tool_call", safe), undefined);
		assert.equal(safe.input.timeout, 10);
		assert.equal(app.notices.length, hasUI ? 6 : 0);
	}
});

test("MCP off synchronously claims allow_once with UI or headless; on does not claim", async () => {
	for (const hasUI of [true, false]) {
		const app = fake(hasUI);
		guardsExtension(app.pi);
		await app.fire("session_start");
		setGuards("mcp", false);
		assert.equal(approval(app.pi), undefined);
		setGuards("mcp", true);
		const handler = approval(app.pi);
		assert.ok(handler);
		assert.equal(await handler(), "allow_once");
		assert.equal(app.notices.length, hasUI ? 1 : 0);
		if (hasUI) assert.equal(app.notices[0].text, "mcp guard off: allowed 'test_delete'");
		setGuards("mcp", false);
		assert.equal(approval(app.pi), undefined);
	}
});

test("MCP off never replaces an existing claimant", async () => {
	const app = fake();
	app.pi.events.on("pi-mcp-adapter:tool-approval-request", (request: any) => request.claim(() => "deny"));
	guardsExtension(app.pi);
	await app.fire("session_start");
	setGuards("mcp", true);
	assert.equal(await approval(app.pi)!(), "deny");
	assert.equal(app.notices.length, 0);
});

test("/guards status, default all, named lists, persist parsing and footer set/clear", async () => {
	const app = fake();
	guardsExtension(app.pi);
	const command = app.commands.get("guards");
	assert.ok(command);
	await app.fire("session_start");
	assert.deepEqual(app.statuses.at(-1), { key: "guards", text: undefined });
	await command.handler("", app.ctx);
	assert.equal(app.notices.at(-1)?.text, GUARD_NAMES.map(name => `${name}: on (default)`).join("\n"));
	await command.handler("off", app.ctx);
	assert.ok(guardStatus().every(status => status.off && status.source === "session"));
	assert.equal(app.statuses.at(-1)?.text, `guards off: ${GUARD_NAMES.join(",")}`);
	assert.equal(existsSync(file), false);
	await command.handler("on all", app.ctx);
	assert.equal(app.statuses.at(-1)?.text, undefined);
	await command.handler("  off   cratis   mcp  ", app.ctx);
	assert.equal(app.statuses.at(-1)?.text, "guards off: cratis,mcp");
	await command.handler("on --persist cratis mcp", app.ctx);
	assert.equal(app.statuses.at(-1)?.text, undefined);
	assert.equal(entry("cratis").source, "persisted");
	await command.handler("off wait --persist", app.ctx);
	assert.deepEqual(entry("wait"), { name: "wait", off: true, source: "persisted" });
	assert.equal(app.statuses.at(-1)?.text, "guards off: wait");
});

test("/guards rejects invalid arguments without changing state", async () => {
	const app = fake();
	guardsExtension(app.pi);
	for (const args of ["toggle", "--persist", "off wait --bad", "on --persist --persist", "off all unknown"]) {
		await app.commands.get("guards").handler(args, app.ctx);
		assert.equal(app.notices.at(-1)?.type, "error");
		assert.ok(guardStatus().every(status => !status.off));
	}
	assert.match(app.notices.at(-1)!.text, /Unknown guard 'unknown'/);
	assert.equal(existsSync(file), false);
});

test("subagent-results shares the named switch and persistence contract", () => {
	assert.equal(isGuardOff("subagent-results"), false);
	setGuards("subagent-results", true);
	assert.deepEqual(entry("subagent-results"), { name: "subagent-results", off: true, source: "session" });
	setGuards("subagent-results", false, { persist: true });
	assert.deepEqual(entry("subagent-results"), { name: "subagent-results", off: false, source: "persisted" });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), stored());
});

test("lane-policy has named env/persisted/session precedence and operator persistence", async () => {
	process.env.PI_GUARDS_OFF = "lane-policy";
	assert.deepEqual(entry("lane-policy"), { name: "lane-policy", off: true, source: "env" });
	writeFileSync(file, JSON.stringify({ off: { "lane-policy": false } }));
	assert.deepEqual(entry("lane-policy"), { name: "lane-policy", off: false, source: "persisted" });
	setGuards("lane-policy", true);
	assert.deepEqual(entry("lane-policy"), { name: "lane-policy", off: true, source: "session" });
	const app = fake(); guardsExtension(app.pi);
	await app.commands.get("guards").handler("on lane-policy --persist", app.ctx);
	assert.deepEqual(entry("lane-policy"), { name: "lane-policy", off: false, source: "persisted" });
	assert.equal(JSON.parse(readFileSync(file, "utf8")).off["lane-policy"], false);
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import { guardStatus } from ${JSON.stringify(new URL("./guards.ts", import.meta.url).href)};
		console.log(JSON.stringify(guardStatus().find(x => x.name === "lane-policy")));
	`], { env: process.env, encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { name: "lane-policy", off: false, source: "persisted" });
	setGuards("lane-policy", true);
	writeFileSync(file, "{bad");
	assert.equal(isGuardOff("lane-policy"), true, "explicit session override still wins over corrupt persisted settings");
	delete (globalThis as any)[key];
	assert.equal(isGuardOff("lane-policy"), false, "corrupt persisted settings override environment opt-out");
});

test("/guards completions replace the full argument prefix", () => {
	const app = fake();
	guardsExtension(app.pi);
	const complete = app.commands.get("guards").getArgumentCompletions;
	assert.deepEqual(complete("o").map((item: any) => item.value), ["off", "on"]);
	assert.deepEqual(complete("off cr").map((item: any) => item.value), ["off cratis"]);
	assert.deepEqual(complete("off sub").map((item: any) => item.value), ["off subagent-results"]);
	assert.deepEqual(complete("off lane").map((item: any) => item.value), ["off lane-policy"]);
	assert.deepEqual(complete("on wait --p").map((item: any) => item.value), ["on wait --persist"]);
	assert.equal(complete("off nonexistent"), null);
});

test("footer picks up env and external persisted changes at lifecycle/tool boundaries", async () => {
	process.env.PI_GUARDS_OFF = "mcp";
	const app = fake();
	guardsExtension(app.pi);
	await app.fire("session_start");
	assert.equal(app.statuses.at(-1)?.text, "guards off: mcp");
	writeFileSync(file, JSON.stringify({ off: { mcp: false, wait: true } }));
	await app.fire("before_agent_start");
	assert.equal(app.statuses.at(-1)?.text, "guards off: wait");
	writeFileSync(file, JSON.stringify({ off: { mcp: false, wait: false } }));
	await app.fire("tool_call", bash("printf ok"));
	assert.equal(app.statuses.at(-1)?.text, undefined);
	unlinkSync(file);
	await app.fire("agent_end");
	assert.equal(app.statuses.at(-1)?.text, "guards off: mcp");
});
