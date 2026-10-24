import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chooseProfile, kimiNote, loadProfiles, pinnedModels, pinWarnings, profileNames, profileOption, profilesDir, spliceRouting } from "../src/profiles.ts";
import { profileChoices } from "../src/wizard.ts";
import type { WizardInput } from "../src/wizard.ts";
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
  assert.deepEqual([pick("anthropic").name, pick("anthropic").provisional], ["balanced-anthropic", false]);
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

const byName = (name: string) => profiles.find((p) => p.name === name)!;
const input = (...ready: string[]) => ({
  detection: { providers: Object.fromEntries(ready.map((id) => [id, { status: "ready" }])) },
  profiles, initial: chooseProfile(new Set(ready), profiles),
}) as unknown as WizardInput;

test("profile summaries are plain words within 90 characters", () => {
  for (const p of profiles) assert.ok(p.summary.length <= 90 && !/quota|\/|\\./.test(p.summary), p.name);
  assert.match(byName("balanced-anthropic").summary, /Claude only \(Opus, Sonnet, Haiku\)/);
});

test("profileOption lists needs and optional providers and disables profiles with missing logins", () => {
  const ready = new Set(["anthropic", "openai-codex"]);
  const balanced = profileOption(byName("balanced"), ready, true);
  assert.equal(balanced.label, "balanced (recommended) · Needs: Claude, ChatGPT; optional: Kimi");
  assert.equal(balanced.disabled, false);
  const kimi = profileOption(byName("kimi-heavy"), ready, false);
  assert.deepEqual([kimi.disabled, kimi.hint], [true, "needs Kimi login"]);
  assert.match(kimi.label, /Needs: Claude, ChatGPT, Kimi$/);
  assert.equal(profileOption(byName("openai-only"), new Set(), false).hint, "needs ChatGPT login");
});

test("profile choices put the chooser's pick first, the rest by rank, and disable what cannot run", () => {
  const { options, initial } = profileChoices(input("anthropic", "openai-codex"));
  assert.equal(options[0].value, "balanced");
  assert.match(options[0].label, /\(recommended\)/);
  const rest = options.slice(1).map((o) => profiles.find((p) => p.name === o.value)!.rank);
  assert.deepEqual(rest, [...rest].sort((a, b) => b - a));
  assert.deepEqual(options.filter((o) => o.disabled).map((o) => o.value), ["kimi-heavy"]);
  assert.equal(options.find((o) => o.value === "openai-only")?.disabled, false);
  assert.equal(options.find((o) => o.value === "kimi-heavy")?.disabled, true);
  assert.equal(initial, "balanced");
});

test("with nothing ready only the provisional balanced stays selectable", () => {
  const { options } = profileChoices(input());
  assert.deepEqual(options.filter((o) => !o.disabled).map((o) => o.value), ["balanced"]);
  const balanced = options.find((o) => o.value === "balanced")!;
  assert.equal(balanced.hint, "installs now; log in later and run ./install.sh --profile auto");
  assert.equal(options[0].value, "balanced");
});
