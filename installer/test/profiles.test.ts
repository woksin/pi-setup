import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chooseProfile, kimiNote, loadProfiles, pinnedModels, pinWarnings, profileNames, profilesDir, spliceRouting } from "../src/profiles.ts";
import { REPO } from "./helpers/home.ts";

const profiles = loadProfiles(REPO);
const pick = (...ready: string[]) => chooseProfile(new Set(ready), profiles);

test("every profile directory has valid, neutral profile.json", () => {
  assert.deepEqual(profiles.map((p) => p.name).sort(), profileNames(REPO));
  for (const p of profiles) {
    assert.ok(p.summary && p.requires.length && p.uses.length && p.rank > 0, p.name);
    assert.ok(!/woksin|\/Volumes/.test(p.summary), p.name);
  }
});

test("requires cover every provider each profile pins", () => {
  for (const p of profiles) {
    const pinned = new Set(pinnedModels(join(profilesDir(REPO), p.name)).map((m) => m.split("/")[0]));
    assert.deepEqual([...pinned].sort(), [...new Set(p.uses)].sort(), p.name);
    for (const r of p.requires) assert.ok(pinned.has(r), `${p.name} requires ${r}`);
  }
});

test("the chooser takes the highest rank whose requirements are ready", () => {
  assert.equal(pick("anthropic", "openai-codex", "kimi-coding").name, "balanced");
  assert.equal(pick("anthropic", "openai-codex").name, "balanced");
  assert.equal(pick("openai-codex").name, "openai-only");
  const none = pick();
  assert.deepEqual([none.name, none.provisional], ["balanced", true]);
  assert.match(none.reason, /rerun \.\/install\.sh --profile auto/);
  assert.deepEqual([pick("anthropic").name, pick("anthropic").provisional], ["balanced", true]);
  assert.match(pick("anthropic", "openai-codex").reason, /Kimi roles \(ops, scout\) fall back to GPT/);
});

test("the Kimi note appears only when the profile uses Kimi and Kimi is missing", () => {
  const balanced = profiles.find((p) => p.name === "balanced");
  assert.match(kimiNote(balanced, new Set(["anthropic"])) ?? "", /Kimi roles fall back to GPT/);
  assert.equal(kimiNote(balanced, new Set(["kimi-coding"])), undefined);
  assert.equal(kimiNote(profiles.find((p) => p.name === "openai-only"), new Set()), undefined);
});

test("pinned models missing from a non-empty catalog warn only for ready providers", () => {
  const pins = ["anthropic/a", "openai-codex/b"];
  assert.deepEqual(pinWarnings(pins, new Set(["anthropic"]), new Set(["x/y"])), ["Pinned model anthropic/a is not in this pi's model catalog."]);
  assert.deepEqual(pinWarnings(pins, new Set(["anthropic"]), new Set()), []);
  assert.deepEqual(pinWarnings(pins, new Set(["anthropic"]), null), []);
});

test("spliceRouting matches pi-profile on every profile's routing.md", () => {
  const agents = readFileSync(join(REPO, "agent/AGENTS.md"));
  for (const name of profileNames(REPO)) {
    if (!readdirSync(join(profilesDir(REPO), name)).includes("routing.md")) continue;
    const out = spliceRouting(agents, readFileSync(join(profilesDir(REPO), name, "routing.md"))).toString();
    assert.ok(out.includes("<!-- pi-profile:routing:end -->"), name);
  }
  assert.throws(() => spliceRouting(Buffer.from("no markers"), Buffer.from("x")), /routing markers not found/);
});
