import assert from "node:assert/strict";
import { test } from "node:test";
import { GUIDELINE, registerBrowserGate } from "../extensions/browser-gate.ts";

const BROWSER = ["browser_click", "browser_new_page"];

function setup(options: { messages?: any[]; env?: string; registered?: string[] } = {}) {
	const calls = { set: 0 };
	process.env.PI_BROWSER_GATE = options.env ?? "on";
	const handlers: Record<string, Function> = {};
	const registered = [{ name: "read" }, ...(options.registered ?? BROWSER).map((name) => ({ name }))];
	let active = registered.map((tool) => tool.name);
	let loader: any;
	const pi: any = {
		on: (name: string, fn: Function) => { handlers[name] = fn; },
		registerTool: (tool: any) => { loader = tool; registered.push({ name: tool.name }); active.push(tool.name); },
		getAllTools: () => registered,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { calls.set++; active = names; },
	};
	let messages = options.messages ?? [];
	registerBrowserGate(pi, () => messages);
	return { calls, register: (name: string) => { registered.push({ name }); active.push(name); }, pi, handlers, registered, getActive: () => active, loader: () => loader, setMessages: (m: any[]) => { messages = m; } };
}

test("gated: browser tools are pruned on before_agent_start, loader stays, and the guideline is registered", async () => {
	const s = setup();
	assert.ok(s.loader().promptGuidelines.includes(GUIDELINE));
	await s.handlers.before_agent_start({}, {});
	assert.deepEqual(s.getActive(), ["read", "browser_enable"]);
});

test("browser_enable activates every browser tool and returns the names", async () => {
	const s = setup();
	await s.handlers.before_agent_start({}, {});
	const result = await s.loader().execute();
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /browser_click, browser_new_page/);
	for (const name of BROWSER) assert.ok(s.getActive().includes(name));
});

test("browser_enable reports an error when no browser tools are registered", async () => {
	const s = setup({ registered: [] });
	const result = await s.loader().execute();
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /No browser_\* tools are registered/);
});

test("eager mode changes nothing and exposes no loader", async () => {
	const s = setup({ env: "off" });
	await s.handlers.before_agent_start({}, {});
	assert.deepEqual(s.getActive(), ["read", ...BROWSER]);
});

test("resumed session whose transcript declares browser tools keeps them active", async () => {
	const s = setup({ messages: [{ role: "system", toolsAdded: BROWSER.map((name) => ({ name })) }] });
	await s.handlers.session_start({}, {});
	await s.handlers.before_agent_start({}, {});
	for (const name of BROWSER) assert.ok(s.getActive().includes(name));
});

test("tools re-registered on a second session_start are pruned again", async () => {
	const s = setup();
	await s.handlers.session_start({}, {});
	assert.deepEqual(s.getActive(), ["read", "browser_enable"]);
	s.pi.setActiveTools([...s.getActive(), ...BROWSER]); // pi-browser-use registers again and activates them
	await s.handlers.session_start({}, {});
	await s.handlers.before_agent_start({}, {});
	assert.deepEqual(s.getActive(), ["read", "browser_enable"]);
});

test("enabled state survives session_tree and the next before_agent_start", async () => {
	const s = setup();
	await s.handlers.before_agent_start({}, {});
	await s.loader().execute();
	await s.handlers.session_tree({}, {});
	await s.handlers.before_agent_start({}, {});
	for (const name of BROWSER) assert.ok(s.getActive().includes(name));
});

test("resume with late registration: tools registered after session_start stay enabled", async () => {
	const s = setup({ registered: [], messages: [{ role: "system", toolsAdded: BROWSER.map((name) => ({ name })) }] });
	await s.handlers.session_start({}, {}); // pi-browser-use has not registered yet
	for (const name of BROWSER) s.register(name);
	await s.handlers.before_agent_start({}, {});
	for (const name of BROWSER) assert.ok(s.getActive().includes(name));
	await s.handlers.before_agent_start({}, {});
	for (const name of BROWSER) assert.ok(s.getActive().includes(name), "stays latched");
});

test("resume where the transcript only shows a browser_enable call enables on late registration", async () => {
	const s = setup({ registered: [], messages: [{ role: "assistant", content: [{ type: "toolCall", name: "browser_enable" }] }] });
	await s.handlers.session_start({}, {});
	s.register("browser_click");
	await s.handlers.before_agent_start({}, {});
	assert.ok(s.getActive().includes("browser_click"));
});

test("a browser tool another extension deactivated after enabling stays inactive", async () => {
	const s = setup();
	await s.handlers.before_agent_start({}, {});
	await s.loader().execute();
	s.pi.setActiveTools(s.getActive().filter((name: string) => name !== "browser_click"));
	await s.handlers.before_agent_start({}, {});
	assert.ok(!s.getActive().includes("browser_click"));
	assert.ok(s.getActive().includes("browser_new_page"));
});

test("a browser tool registered after enabling is activated once", async () => {
	const s = setup();
	await s.handlers.before_agent_start({}, {});
	await s.loader().execute();
	s.pi.setActiveTools(s.getActive().filter((name: string) => name !== "browser_click"));
	s.register("browser_hover");
	s.pi.setActiveTools(s.getActive().filter((name: string) => name !== "browser_hover"));
	await s.handlers.before_agent_start({}, {});
	assert.ok(s.getActive().includes("browser_hover"));
});

test("config flipped to eager mid-session does not strand hidden tools (mode latched at session_start)", async () => {
	const s = setup();
	await s.handlers.session_start({}, {});
	assert.deepEqual(s.getActive(), ["read", "browser_enable"]);
	process.env.PI_BROWSER_GATE = "off";
	await s.handlers.before_agent_start({}, {});
	assert.deepEqual(s.getActive(), ["read", "browser_enable"], "still gated, loader kept");
});

test("no setActiveTools call when nothing changes", async () => {
	const s = setup();
	await s.handlers.before_agent_start({}, {});
	const after = s.calls.set;
	await s.handlers.before_agent_start({}, {});
	await s.handlers.session_tree({}, {});
	assert.equal(s.calls.set, after);
});
