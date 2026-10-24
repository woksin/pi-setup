import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/run.ts";
import { COMPONENT_IDS } from "../src/components.ts";
import { CANCEL } from "../src/types.ts";
import { sandbox, snapshot } from "./helpers/home.ts";
import type { Sandbox } from "./helpers/home.ts";
import { ctxFor, scripted } from "./helpers/prompter.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => rmSync(b.root, { recursive: true, force: true })));
function box() { const b = sandbox(); boxes.push(b); return b; }
const flags = (b: Sandbox) => ["--skip-npm", "--no-launchd", "--repos-root", join(b.root, "repos")];
const titles = ["You", "Repositories", "AI logins", "Profile", "Extras", "Review"];

test("recommended with ready logins asks only mode and Review, then installs", async () => {
  const b = box(); const s = scripted();
  assert.equal(await main(flags(b), ctxFor(b), s.p), 0);
  assert.deepEqual(s.events, ["select:How do you want to set up?", "select:Review"]);
  assert.deepEqual(s.steps, ["Step 1 of 1 · Review"]);
  assert.match(readFileSync(join(b.home, ".pi/agent/user.json"), "utf8"), /einari/);
  assert.match(s.notes[0], /Nothing is written until you confirm/);
  assert.match(s.notes[0], /Ctrl-C quits at any time/);
});

test("recommended without a saved or gh login asks You as Step 1 of 2", async () => {
  const b = box(); const s = scripted({ "GitHub login": ["alice"] });
  writeFileSync(join(b.stubs, "gh"), "#!/bin/sh\nexit 1\n");
  assert.equal(await main(flags(b), ctxFor(b), s.p), 0);
  assert.deepEqual(s.steps, ["Step 1 of 2 · You", "Step 2 of 2 · Review"]);
  assert.match(s.notes.join("\n"), /scheduled-job names/);
});

test("customise shows six steps in order with honest counters", async () => {
  const b = box(); const s = scripted({ "How do you": ["custom"] });
  assert.equal(await main(["--skip-npm", "--no-launchd"], ctxFor(b), s.p), 0);
  assert.deepEqual(s.steps, titles.map((title, i) => `Step ${i + 1} of 6 · ${title}`));
  assert.match(s.notes.join("\n"), /Claude ✓.*ChatGPT ✓.*Kimi ✓/);
});

test("user and root flags drop their steps from the count", async () => {
  const b = box(); const s = scripted({ "How do you": ["custom"] });
  assert.equal(await main(["--user", "alice", ...flags(b)], ctxFor(b), s.p), 0);
  assert.deepEqual(s.steps, titles.slice(2).map((title, i) => `Step ${i + 1} of 4 · ${title}`));
});

test("Review Change a step reasks only Profile and retains the new choice", async () => {
  const b = box(); const s = scripted({
    "Review": ["change", "install"], "Change which step": ["profile"],
    "Profile ": ["change"], "Pick a profile": ["openai-only"],
  });
  assert.equal(await main(flags(b), ctxFor(b), s.p), 0);
  assert.deepEqual(s.events, [
    "select:How do you want to set up?", "select:Review", "select:Change which step?",
    "select:Profile balanced: you have Claude, ChatGPT and Kimi: each role goes where it is strongest", "select:Pick a profile", "select:Review",
  ]);
  assert.match(s.notes.at(-1) ?? "", /Profile: openai-only \(you picked it\)/);
});

test("Cancel at Review writes nothing", async () => {
  for (const cancel of ["cancel", CANCEL]) {
    const b = box(); const before = snapshot(b.home, true);
    const s = scripted({ "Review": [cancel] }); const errors: string[] = [];
    assert.equal(await main(flags(b), ctxFor(b, [], errors), s.p), 1);
    assert.deepEqual(snapshot(b.home, true), before);
    assert.match(errors.join("\n"), /Cancelled; nothing written/);
  }
});

test("rerun defaults to current choices, names active profile and skips Review when unchanged", async () => {
  const b = box(); assert.equal(await main(flags(b), ctxFor(b), scripted().p), 0);
  const s = scripted();
  assert.equal(await main(flags(b), ctxFor(b), s.p), 0);
  assert.equal(s.selects[0].initial, "recommended");
  assert.equal(s.selects[0].labels[0], "Update with your current choices (recommended)");
  assert.match(s.notes[0], /installed.*balanced/);
  assert.deepEqual(s.events, ["select:How do you want to set up?"]);
  assert.match(s.outros.at(-1) ?? "", /Everything is up to date/);
});

test("Show every file returns to Review without writing until Install", async () => {
  const b = box(); const before = snapshot(b.home, true);
  const s = scripted({ "Review": ["files", "cancel"] });
  assert.equal(await main(flags(b), ctxFor(b), s.p), 1);
  assert.equal(s.events.filter((e) => e === "select:Review").length, 2);
  assert.match(s.notes.join("\n"), /install .*\.pi\/agent\//);
  assert.deepEqual(snapshot(b.home, true), before);
});

test("fixed profile and extras skip steps and cannot be edited at Review", async () => {
  const b = box(); const s = scripted({ "How do you": ["custom"], "Review": ["change", "cancel"], "Change which step": ["review"] });
  assert.equal(await main([
    ...flags(b), "--user", "alice", "--profile", "auto", ...COMPONENT_IDS.flatMap((id) => ["--without", id]),
  ], ctxFor(b), s.p), 1);
  assert.deepEqual(s.steps, ["Step 1 of 2 · AI logins", "Step 2 of 2 · Review", "Step 2 of 2 · Review"]);
  assert.deepEqual(s.offered.find((choices) => choices.includes("logins")), ["logins", "review"]);
});

test("recommended lanes asks only the necessary trust question before Review", async () => {
  const b = box(); const s = scripted({ "Review": ["cancel"] }); const before = snapshot(b.home, true);
  assert.equal(await main([...flags(b), "--with", "lanes"], ctxFor(b), s.p), 1);
  assert.deepEqual(s.steps, ["Step 1 of 2 · Extras", "Step 2 of 2 · Review"]);
  assert.equal(s.events.length, 3);
  assert.match(s.events[1], /^confirm:Preapprove project MCP servers\?/);
  assert.deepEqual(snapshot(b.home, true), before);
});

test("cancelling at mode or a custom step writes nothing", async () => {
  for (const answers of [{ "How do you": [CANCEL] }, { "How do you": ["custom"], "Profile ": [CANCEL] }]) {
    const b = box(); const s = scripted(answers); const before = snapshot(b.home, true);
    assert.equal(await main(flags(b), ctxFor(b), s.p), 1);
    assert.deepEqual(snapshot(b.home, true), before);
    assert.ok(!s.events.includes("select:Review"));
  }
});

test("recommended without ready providers shows the status-only login step", async () => {
  const b = box(); const ctx = ctxFor(b); ctx.env.STUB_READY = "";
  const s = scripted(); assert.equal(await main(flags(b), ctx, s.p), 0);
  assert.deepEqual(s.steps, ["Step 1 of 2 · AI logins", "Step 2 of 2 · Review"]);
  assert.match(s.notes.join("\n"), /Claude ✗.*ChatGPT ✗.*Kimi ✗/);
});
