import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/home.ts";
import { validId, validTopic, messageName, parseMessageName, sessionDirFor } from "../src/lanes/names.ts";
import { defaults, expand, findRoot, loadConfig, preapprovalDefault, saveConfig, validate } from "../src/lanes/config.ts";

test("lane and group ids, topics and message names follow the shared grammar", () => {
  for (const s of ["L0", "R-AI", "GROUP", "A123"]) assert.ok(validId(s));
  for (const s of ["", "a", "L_1", "A--B", "A-1", "A-", "A".repeat(33)]) assert.ok(!validId(s));
  for (const s of ["x", "hello-world", "0", "a".repeat(48)]) assert.ok(validTopic(s));
  for (const s of ["", "Hello", "../x", "a_", "a".repeat(49)]) assert.ok(!validTopic(s));
  const now = new Date(2026, 0, 1, 12, 0);
  const n = messageName("L0", "ALL", "x", now);
  assert.equal(n, "L0-to-ALL-x-1200.md");
  assert.deepEqual(parseMessageName(n), { from: "L0", to: ["ALL"], topic: "x" });
  assert.equal(messageName("L0", "L1", "x", now, 2), "L0-to-L1-x-1200-2.md");
  assert.deepEqual(parseMessageName("R-AI-to-L1-L2-hello-world-1200-3.md"), { from: "R-AI", to: ["L1-L2"], topic: "hello-world" });
  assert.equal(sessionDirFor("/tmp/a:b/c", "/tmp/agent"), "/tmp/agent/sessions/--tmp-a-b-c--");
});

test("legacy named recipients are delimited by HHMM with an optional topic suffix", () => {
  assert.deepEqual(parseMessageName("L0-to-ai-skills-1406-resume.md"), { from: "L0", to: ["ai-skills"], topic: "resume" });
  assert.deepEqual(parseMessageName("L0-to-studio-503-1406-resume.md"), { from: "L0", to: ["studio-503"], topic: "resume" });
  assert.deepEqual(parseMessageName("L0-to-hosted-ci-2327.md"), { from: "L0", to: ["hosted-ci"], topic: "2327" });
  assert.deepEqual(parseMessageName("L0-to-lanes-disk-0400.md"), { from: "L0", to: ["lanes-disk"], topic: "0400" });
  assert.deepEqual(parseMessageName("20261023-074001-L0-to-wave2-0505.md"), { from: "L0", to: ["wave2"], topic: "0505" });
  for (const name of ["L0-to-ai-skills-resume.md", "L0-to-ai-skills-2460.md", "L0-to-ai-skills-1406.exe", "bad-to-ai-skills-1406.md"]) assert.equal(parseMessageName(name), undefined);
});

test("config expansion, validation, root lookup and atomic saves preserve unknown keys", () => {
  const root = tempDir("lanes-config");
  const home = tempDir("lanes-home");
  const c = defaults(root, home, "~/src");
  assert.equal(expand(c.worktreesDir, c, root, home), join(home, "src/.worktrees"));
  assert.equal(expand("messages", c, root, home), join(root, "messages"));
  assert.equal(c.launch.preapproveMcp, false);
  c.extra = { keep: true };
  saveConfig(root, c);
  const sub = join(root, "a/b"); mkdirSync(sub, { recursive: true });
  assert.equal(findRoot(undefined, {}, sub), root);
  assert.equal(findRoot(root, {}, sub), root);
  assert.equal(findRoot(undefined, { LANES_DIR: root }, sub), root);
  assert.deepEqual(loadConfig(root).extra, { keep: true });
  saveConfig(root, c);
  assert.deepEqual(readdirSync(root).sort(), ["a", "lanes.json"]);
  assert.ok(existsSync(join(root, "lanes.json")));
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, "lanes.json"), "utf8")));
  for (const [key, value] of [["version", 2], ["baseBranch", 3], ["terminal", { backend: "bad" }], ["coordinator", { ...c.coordinator, id: "ALL" }]]) {
    assert.throws(() => validate({ ...c, [key]: value }), new RegExp(String(key)));
  }
});

test("missing and unreadable installed defaults are not saved MCP consent", () => {
  const dir = tempDir("lanes-unreadable-defaults"); const templates = join(dir, "templates"); const path = join(dir, "defaults.json");
  assert.equal(preapprovalDefault(templates), false);
  mkdirSync(path); // Deterministic read failure, including under a privileged test runner.
  assert.equal(preapprovalDefault(templates), false); rmSync(path, { recursive: true });
  writeFileSync(path, '{"launch":{"preapproveMcp":true}}');
  if (process.getuid?.() !== 0) {
    chmodSync(path, 0);
    try { assert.equal(preapprovalDefault(templates), false); } finally { chmodSync(path, 0o600); }
  }
  assert.equal(preapprovalDefault(templates), true);
});

test("ops defaults validate and slice-5 configs remain valid", () => {
  const home = tempDir("lanes-ops-config"); const c = defaults(home, home);
  assert.deepEqual(c.idle, { minutes: 75 });
  assert.deepEqual(c.github, { repos: [], author: "@me", excludeLabels: [] });
  const old = { ...c }; delete old.idle; delete old.github;
  assert.doesNotThrow(() => validate(old));
  for (const minutes of [0, -1, 1.5, "75"]) assert.throws(() => validate({ ...c, idle: { minutes } }), /idle/);
  for (const change of [{ repos: ["bad"] }, { author: "" }, { author: "a;bad" }, { excludeLabels: [""] }]) {
    assert.throws(() => validate({ ...c, github: { ...c.github, ...change } }), /github/);
  }
});
