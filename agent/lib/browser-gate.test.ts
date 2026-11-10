import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desiredActive, enabledFromTranscript, loadGateConfig, splitBrowserTools, transcriptToolNames } from "./browser-gate.ts";

const tools = ["read", "browser_click", "browser_enable", "browserish", "web_search", "browser_new_page"].map((name) => ({ name }));

test("splitBrowserTools selects browser_ names, never the loader or lookalikes", () => {
	assert.deepEqual(splitBrowserTools(tools), ["browser_click", "browser_new_page"]);
	assert.deepEqual(splitBrowserTools(tools, ["web_"]), ["web_search"]);
});

test("desiredActive hides new browser tools until enabled and only touches tools not seen before", () => {
	const browserNames = ["browser_click", "browser_new_page"];
	const active = ["read", "custom", "browser_click", "browser_new_page"];
	assert.deepEqual(desiredActive({ active, browserNames, seen: [], enabled: false, mode: "gated" }), { active: ["read", "custom", "browser_enable"], seen: browserNames });
	assert.deepEqual(desiredActive({ active: ["read"], browserNames, seen: [], enabled: true, mode: "gated" }), { active: ["read", ...browserNames, "browser_enable"], seen: browserNames });
	// seen tools keep their state: a deliberately deactivated tool stays off, a tool outside the set stays on
	assert.deepEqual(desiredActive({ active: ["read", "browser_new_page", "browser_enable"], browserNames, seen: browserNames, enabled: true, mode: "gated" }).active, ["read", "browser_new_page", "browser_enable"]);
	assert.deepEqual(desiredActive({ active: ["read", "browser_enable"], browserNames: [], seen: [], enabled: false, mode: "gated" }).active, ["read"]);
	assert.deepEqual(desiredActive({ active: ["read", "browser_enable", ...browserNames], browserNames, seen: [], enabled: false, mode: "eager" }).active, ["read", ...browserNames]);
});

test("config: default gated; env beats file; broken file gives defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-cfg-"));
	const file = join(dir, "browser-gate.json");
	assert.equal(loadGateConfig({}, join(dir, "none.json")).mode, "gated");
	writeFileSync(file, JSON.stringify({ mode: "eager" }));
	assert.equal(loadGateConfig({}, file).mode, "eager");
	assert.equal(loadGateConfig({ PI_BROWSER_GATE: "on" }, file).mode, "gated");
	assert.equal(loadGateConfig({ PI_BROWSER_GATE: "OFF" }, join(dir, "none.json")).mode, "eager");
	writeFileSync(file, "{ broken");
	assert.equal(loadGateConfig({}, file).mode, "gated");
});

test("transcript scan applies toolsAdded/toolsRemoved in order and is undefined without declarations", () => {
	assert.equal(transcriptToolNames([{ role: "user" }]), undefined);
	const messages = [
		{ role: "system", toolsAdded: [{ name: "browser_click" }, { name: "read" }] },
		{ role: "system", toolsRemoved: [{ name: "read" }] },
	];
	assert.deepEqual([...transcriptToolNames(messages)!], ["browser_click"]);
	assert.equal(enabledFromTranscript(messages, true), true);
	assert.equal(enabledFromTranscript([{ role: "system", toolsAdded: [{ name: "read" }] }], true), undefined);
	assert.equal(enabledFromTranscript([{ role: "user" }], true), true, "legacy transcript keeps eager tools");
	assert.equal(enabledFromTranscript([{ role: "user" }], false), undefined);
	assert.equal(enabledFromTranscript([], true), undefined);
	const call = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", name }] });
	assert.equal(enabledFromTranscript([{ role: "system", toolsAdded: [{ name: "read" }] }, call("browser_enable")], false), true);
	assert.equal(enabledFromTranscript([{ role: "system", toolsAdded: [{ name: "read" }] }, { role: "toolResult", toolName: "browser_click" }], false), true);
});
