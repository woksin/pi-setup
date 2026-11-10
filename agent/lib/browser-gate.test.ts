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

test("desiredActive hides browser tools until enabled and keeps other extensions' tools", () => {
	const browserNames = ["browser_click", "browser_new_page"];
	const active = ["read", "custom", "browser_click", "browser_new_page"];
	assert.deepEqual(desiredActive({ active, browserNames, enabled: false, mode: "gated" }), ["read", "custom", "browser_enable"]);
	assert.deepEqual(desiredActive({ active: ["read"], browserNames, enabled: true, mode: "gated" }), ["read", "browser_click", "browser_new_page", "browser_enable"]);
	assert.deepEqual(desiredActive({ active: ["read", "browser_enable", ...browserNames], browserNames, enabled: false, mode: "eager" }), ["read", ...browserNames]);
	assert.deepEqual(desiredActive({ active: ["read", "browser_enable"], browserNames: [], enabled: false, mode: "gated" }), ["read"]);
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
	assert.equal(enabledFromTranscript(messages, ["browser_click"], true), true);
	assert.equal(enabledFromTranscript(messages, ["browser_new_page"], true), false);
	assert.equal(enabledFromTranscript([{ role: "user" }], ["browser_click"], true), true);
	assert.equal(enabledFromTranscript([{ role: "user" }], ["browser_click"], false), undefined);
	assert.equal(enabledFromTranscript([], ["browser_click"], true), undefined);
});
