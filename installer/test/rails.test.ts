import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/run.ts";
import { COMPONENT_IDS } from "../src/components.ts";
import { CANCEL } from "../src/types.ts";
import { sandbox, snapshot } from "./helpers/home.ts";
import type { Sandbox } from "./helpers/home.ts";
import { railsCtxFor as ctxFor, scripted } from "./helpers/prompter.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => rmSync(b.root, { recursive: true, force: true })));
function box() { const b = sandbox(); boxes.push(b); return b; }
const flags = (b: Sandbox) => ["--skip-npm", "--no-launchd", "--repos-root", join(b.root, "repos")];
const titles = ["You", "Repositories", "AI logins", "Profile", "Extras", "Review"];

function tracedContext(b: Sandbox) {
  const diagnostics: string[] = [];
  const ctx = ctxFor(b, { errors: diagnostics });
  const run = ctx.run;
  ctx.run = async (cmd, args, options) => {
    const result = await run(cmd, args, options);
    diagnostics.push(JSON.stringify({ cmd, args, ...result }));
    return result;
  };
  return { ctx, diagnostics };
}

test("recommended with ready logins asks only mode and Review, then installs", async () => {
  const b = box(); const s = scripted();
  assert.equal(await main(flags(b), ctxFor(b), s.p), 0);
  assert.deepEqual(s.events, ["select:How do you want to set up?", "select:Review"]);
  assert.deepEqual(s.steps, ["Step 1 of 1 · Review"]);
  assert.match(readFileSync(join(b.home, ".pi/agent/user.json"), "utf8"), /einari/);
  assert.match(s.notes[0], /Nothing is written until you confirm/);
  assert.match(s.notes[0], /Ctrl-C quits at any time/);
});

test("Review explains the lanes default on or off and Extras can opt out", async () => {
  for (const backend of [false, true]) {
    const b = box(); const ctx = ctxFor(b); const which = ctx.which;
    ctx.which = (name) => name === "tmux" && backend ? "/stub/tmux" : which(name);
    const s = scripted(backend ? { "Review": ["change", "install"], "Change which step": ["extras"], "Extras": [[]] } : {});
    assert.equal(await main(flags(b), ctx, s.p), 0);
    const reviews = s.notes.filter((n) => n.startsWith("GitHub login"));
    assert.match(reviews[0], backend
      ? /\nlanes: on: backend found; run several pi sessions in parallel, coordinated by one session/
      : /\nlanes: off: no tmux or macOS Terminal found; run several pi sessions in parallel, coordinated by one session/);
    if (backend) assert.match(reviews.at(-1)!, /\nlanes: off: your choice;/);
    const manifest = JSON.parse(readFileSync(join(b.home, ".pi/agent/.pi-setup/manifest.json"), "utf8"));
    assert.equal(manifest.components.lanes.on, false);
    const rerun = scripted();
    assert.equal(await main(flags(b), ctx, rerun.p), 0);
    assert.ok(!rerun.events.some((e) => e.startsWith("confirm:Preapprove")), "saved off stays off even with a backend");
  }
});

test("recommended backend installs lanes with safe MCP defaults and a single setup command hint", async () => {
  for (const unattended of [false, true]) {
    const b = box(); const ctx = ctxFor(b); const which = ctx.which;
    ctx.which = (name) => name === "tmux" ? "/stub/tmux" : which(name);
    const s = scripted(); const lines: string[] = []; ctx.out = (line) => lines.push(line);
    assert.equal(await main([...flags(b), ...(unattended ? ["--yes"] : [])], ctx, s.p), 0);
    const dir = join(b.home, ".local/share/pi-setup/lanes");
    assert.equal(JSON.parse(readFileSync(join(dir, "defaults.json"), "utf8")).launch.preapproveMcp, false);
    assert.match([...lines, ...s.notes].join("\n"), /Optional: set up parallel sessions now: \.\/install\.sh lanes/);
    assert.ok(!s.events.some((e) => e.includes("Set up a coordinator")));
  }
});

test("recommended without a saved or gh login asks You as Step 1 of 2", async () => {
  const b = box(); const s = scripted({ "GitHub login": ["alice"] });
  const ctx = ctxFor(b); ctx.env.STUB_LOGIN = "";
  assert.equal(await main(flags(b), ctx, s.p), 0);
  assert.deepEqual(s.steps, ["Step 1 of 2 · You", "Step 2 of 2 · Review"]);
  assert.match(s.notes.join("\n"), /scheduled-job names/);
});

test("customise shows six steps in order with honest counters", async () => {
  const b = box(); const s = scripted({ "How do you": ["custom"] });
  const { ctx, diagnostics } = tracedContext(b);
  const code = await main(["--skip-npm", "--no-launchd"], ctx, s.p);
  assert.equal(code, 0, diagnostics.join("\n"));
  assert.deepEqual(s.steps, titles.map((title, i) => `Step ${i + 1} of 6 · ${title}`));
  assert.match(s.notes.join("\n"), /Claude ✓[\s\S]*ChatGPT ✓[\s\S]*Kimi ✓/);
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
  const { ctx, diagnostics } = tracedContext(b);
  const code = await main(flags(b), ctx, s.p);
  assert.equal(code, 0, diagnostics.join("\n"));
  assert.deepEqual(s.events, [
    "select:How do you want to set up?", "select:Review", "select:Change which step?",
    "select:Profile balanced: you have Claude, ChatGPT and Kimi: each role goes where it is strongest", "select:Pick a profile", "select:Review",
  ]);
  assert.match(s.notes.findLast((n) => n.startsWith("GitHub login")) ?? "", /Profile: openai-only \(you picked it\)/);
});

test("Cancel at Review writes nothing", async () => {
  for (const cancel of ["cancel", CANCEL]) {
    const b = box(); const before = snapshot(b.home, true);
    const s = scripted({ "Review": [cancel] }); const errors: string[] = [];
    assert.equal(await main(flags(b), ctxFor(b, { errors }), s.p), 1);
    assert.deepEqual(snapshot(b.home, true), before);
    assert.match(errors.join("\n"), /Cancelled; nothing written/);
  }
});

test("rerun defaults to current choices, names active profile and skips Review when unchanged", async () => {
  const b = box(); const bins = (c: ReturnType<typeof ctxFor>) => { c.env.PATH = [join(b.home, ".local/bin"), join(b.home, ".pi/agent/bin")].join(":"); return c; };
  assert.equal(await main(flags(b), bins(ctxFor(b)), scripted().p), 0);
  const s = scripted();
  assert.equal(await main(flags(b), bins(ctxFor(b)), s.p), 0);
  assert.equal(s.selects[0].initial, "recommended");
  assert.equal(s.selects[0].labels[0], "Update with your current choices (recommended)");
  assert.match(s.notes[0], /installed.*balanced/);
  assert.deepEqual(s.events, ["select:How do you want to set up?"]);
  assert.match(s.outros.at(-1) ?? "", /Installed, with \d+ things? to finish/);
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
  assert.deepEqual(s.steps, ["Step 1 of 3 · AI logins", "Step 2 of 3 · Profile", "Step 3 of 3 · Review", "Step 3 of 3 · Review"]);
  assert.deepEqual(s.offered.find((choices) => choices.includes("logins")), ["logins", "profile", "review"]);
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
  const s = scripted({ "Log in to your": ["continue"] }); assert.equal(await main(flags(b), ctx, s.p), 0);
  assert.deepEqual(s.steps, ["Step 1 of 2 · AI logins", "Step 2 of 2 · Review"]);
  assert.match(s.notes.join("\n"), /Claude ✗[\s\S]*ChatGPT ✗[\s\S]*Kimi ✗/);
});

function selectHook(p: ReturnType<typeof scripted>["p"], after: (message: string, answer: unknown) => void) {
  const select = p.select;
  p.select = (async (o: Parameters<typeof select>[0]) => {
    const answer = await select(o);
    after(o.message, answer);
    return answer;
  }) as typeof select;
}

test("the logins step shows each provider with its role", async () => {
  const b = box(); const s = scripted({ "How do you": ["custom"] });
  assert.equal(await main(flags(b), ctxFor(b), s.p), 0);
  const note = s.notes.find((n) => n.includes("Claude ✓")) ?? "";
  assert.match(note, /Claude ✓ \(main model in most profiles\)/);
  assert.match(note, /ChatGPT ✓ \(coding in most profiles\)/);
  assert.match(note, /Kimi ✓ \(optional, research\)/);
  assert.equal(s.selects.find((x) => x.message.startsWith("Log in to"))?.initial, "continue");
});

test("Log in now re-probes through the injected probe and flips ChatGPT to ready", async () => {
  const b = box(); const ctx = ctxFor(b); ctx.env.STUB_READY = "";
  const s = scripted({ "How do you": ["custom"], "Log in to your": ["login", "continue"] });
  let probes = 0;
  const run = ctx.run;
  ctx.run = (cmd, args, o) => { if (cmd === "pi" && args[0] === "auth") probes++; return run(cmd, args, o); };
  selectHook(s.p, (message, answer) => { if (message.startsWith("Log in to") && answer === "login") ctx.env.STUB_READY = "openai-codex"; });
  assert.equal(await main(flags(b), ctx, s.p), 0);
  const logins = s.selects.filter((x) => x.message.startsWith("Log in to"));
  assert.deepEqual(logins.map((x) => x.initial), ["login", "continue"]);
  const notes = s.notes.filter((n) => n.includes("Claude ") && n.includes("Kimi "));
  assert.match(notes[0], /ChatGPT ✗/);
  assert.match(notes[1], /Claude ✗[\s\S]*ChatGPT ✓/);
  assert.match(s.notes.join("\n"), /run pi, type \/login/);
  assert.equal(probes, 6);
  assert.match(s.notes.findLast((n) => n.startsWith("GitHub login")) ?? "", /Profile: openai-only/);
});

test("a missing pi shows the install command; after installing it, Check again re-detects pi and probes providers", async () => {
  const b = box(); const ctx = ctxFor(b); ctx.env.STUB_READY = "anthropic";
  const which = ctx.which; let installed = false;
  ctx.which = (name) => name === "pi" && !installed ? undefined : which(name);
  let probes = 0;
  const run = ctx.run;
  ctx.run = (cmd, args, o) => { if (cmd === "pi" && args[0] === "auth") probes++; return run(cmd, args, o); };
  const s = scripted({ "How do you": ["custom"], "Install pi first": ["login"], "Continue?": [false] });
  selectHook(s.p, (message, answer) => { if (message === "Install pi first" && answer === "login") installed = true; });
  assert.equal(await main(flags(b), ctx, s.p), 0);
  const asked = s.selects.filter((x) => /^(Install pi first|Log in to your)/.test(x.message)).map((x) => x.message);
  assert.deepEqual(asked, ["Install pi first", "Log in to your AI providers"]);
  assert.ok(s.selects.some((x) => x.labels.includes("Check again")));
  const stepNotes = s.notes.filter((n) => n.includes("Kimi "));
  assert.match(stepNotes[0], /npm install -g @earendil-works\/pi-coding-agent/);
  assert.doesNotMatch(stepNotes[1], /pi is not installed/);
  assert.match(stepNotes[1], /Claude ✓/);
  assert.equal(probes, 3);
  assert.doesNotMatch(s.notes.join("\n"), /pi was not found on PATH/);
});

test("customise skips Profile only for an explicit profile name", async () => {
  const b = box(); const s = scripted({ "How do you": ["custom"] });
  assert.equal(await main([...flags(b), "--user", "alice", "--profile", "openai-only"], ctxFor(b), s.p), 0);
  assert.ok(!s.steps.some((step) => step.includes("Profile")), s.steps.join("\n"));
});
