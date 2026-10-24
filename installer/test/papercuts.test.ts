import { strict as assert } from "node:assert";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { COMPONENTS, hintFor } from "../src/components.ts";
import { main } from "../src/run.ts";
import { install, installLines, sandbox } from "./helpers/home.ts";
import { ctxFor, scripted } from "./helpers/prompter.ts";
import type { Sandbox } from "./helpers/home.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => rmSync(b.root, { recursive: true, force: true })));

function box(): Sandbox {
  const b = sandbox();
  boxes.push(b);
  return b;
}

const base = (b: Sandbox, extra: string[] = []) => ["--user", "einari", "--skip-npm", ...extra, ...(extra.includes("--repos-root") ? [] : ["--repos-root", join(b.root, "repos")])];

test("(a) a profile picked through Change… is labelled as picked, not as a flag", async () => {
  const b = box();
  const s = scripted({ "How do you": ["custom"], "Profile ": ["change"], "Pick a profile": ["openai-only"] });
  assert.equal(await main(base(b), ctxFor(b, [], []), s.p), 0);
  const plan = s.notes.find((n) => n.includes("Profile:")) ?? "";
  assert.match(plan, /Profile: openai-only \(you picked it\)/);
  assert.doesNotMatch(plan, /requested with --profile/);
});

test("(b) accepting the pre-selected root does not say 'you typed it'", async () => {
  const b = box();
  const s = scripted({});
  const args = ["--user", "einari", "--skip-npm"];
  assert.equal(await main(args, ctxFor(b, [], []), s.p), 0);
  const plan = s.notes.find((n) => n.includes("Repositories root:")) ?? "";
  assert.doesNotMatch(plan, /Repositories root:.*you typed it/);
  assert.match(plan, /Repositories root:.*(default|best match found|saved)/);
});

test("(c) the guided flow prints a count line, not one line per file", async () => {
  const b = box();
  const lines: string[] = [];
  assert.equal(await main(base(b), ctxFor(b, lines, []), scripted({}).p), 0, lines.join("\n"));
  assert.deepEqual(installLines(lines.join("\n")), []);
  assert.ok(lines.some((l) => /^Wrote \d+ files \(0 changed, 0 backed up\)$/.test(l)), lines.join("\n"));
  const plain = box();
  const out = install(plain, ["--yes", ...base(plain)]);
  assert.ok(installLines(out.stdout).length > 100);
});

test("(d) an unchanged rerun ends up to date without Review; first install reaches Review", async () => {
  const b = box();
  assert.equal(install(b, ["--yes", ...base(b)]).status, 0);
  const s = scripted({});
  assert.equal(await main(base(b), ctxFor(b, [], []), s.p), 0);
  assert.ok(!s.events.includes("select:Review"), s.events.join("\n"));
  assert.match(s.outros.at(-1) ?? "", /Installed, with \d+ things? to finish/);
  const first = box();
  const f = scripted({});
  assert.equal(await main(base(first), ctxFor(first, [], []), f.p), 0);
  assert.ok(f.events.includes("select:Review"));
  assert.equal(f.selects.find((s) => s.message === "Review")?.initial, "install");
});

test("(e) the Python OK line is printed only without a prompter", async () => {
  const b = box();
  const guided: string[] = [];
  assert.equal(await main(base(b), ctxFor(b, guided, []), scripted({}).p), 0);
  assert.ok(!guided.some((l) => /^Python \d/.test(l)), guided.join("\n"));
  const plain = box();
  // Under heavy load the version probe can time out; then the same line is a stderr warning instead.
  const r = install(plain, ["--yes", ...base(plain)]);
  assert.match(`${r.stdout}\n${r.stderr}`, /^(warning: )?Python (\d|version unknown)/m);
});

test("(f) every extras row has a hint", () => {
  for (const def of COMPONENTS) {
    for (const on of [true, false]) assert.ok(hintFor(def, on).trim().length > 0, def.id);
  }
});

test("(g) keeping an edit reaches Review once; an unchanged rerun skips Review and is up to date", async () => {
  const b = box();
  assert.equal(install(b, ["--yes", ...base(b)]).status, 0);
  appendFileSync(join(b.home, ".pi/agent/extensions/guards.ts"), "\n// edited by the user\n");
  const first = scripted({ "changed since install": ["keep"] });
  assert.equal(await main(base(b), ctxFor(b, [], []), first.p), 0);
  assert.ok(first.events.includes("select:Review"), first.events.join("\n"));
  assert.equal(first.selects.find((s) => s.message === "Review")?.initial, "install");
  const again = scripted({ "changed since install": ["keep"] });
  assert.equal(await main(base(b), ctxFor(b, [], []), again.p), 0);
  assert.ok(!again.events.includes("select:Review"), again.events.join("\n"));
  assert.match(again.outros.at(-1) ?? "", /Installed, with \d+ things? to finish/);
});
