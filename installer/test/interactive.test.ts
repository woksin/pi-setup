import { strict as assert } from "node:assert";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/run.ts";
import { CANCEL } from "../src/types.ts";
import { install, piPath, sandbox, snapshot } from "./helpers/home.ts";
import { ctxFor, scripted } from "./helpers/prompter.ts";
import type { Sandbox } from "./helpers/home.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => rmSync(b.root, { recursive: true, force: true })));

const flags = (box: Sandbox) => ["--user", "einari", "--repos-root", join(box.root, "repos"), "--profile", "balanced", "--skip-npm"];

/** Install once through the shim, then edit one managed file. */
function seeded(): { box: Sandbox; path: string; original: Buffer; mine: Buffer } {
  const box = sandbox();
  boxes.push(box);
  assert.equal(install(box, ["--yes", ...flags(box)]).status, 0);
  const path = piPath(box, "extensions/guards.ts");
  const original = readFileSync(path);
  appendFileSync(path, "\n// edited by the user\n");
  return { box, path, original, mine: readFileSync(path) };
}

test("L10 the conflict prompt comes before Install; keep writes .pi-setup-new", async () => {
  const { box, path, original, mine } = seeded();
  const s = scripted({ "you edited": ["decide"], "changed since install": ["keep"] });
  const lines: string[] = [];
  const code = await main(flags(box), ctxFor(box, lines, []), s.p);
  assert.equal(code, 0, lines.join("\n"));
  const conflict = s.events.findIndex((e) => e.includes("changed since install"));
  const install = s.events.findIndex((e) => e === "select:Review");
  assert.ok(conflict >= 0 && install > conflict, s.events.join("\n"));
  assert.ok(readFileSync(path).equals(mine));
  assert.ok(readFileSync(`${path}.pi-setup-new`).equals(original));
});

test("L10 diff shows a note and asks again without the diff choice", async () => {
  const { box, path, mine } = seeded();
  const s = scripted({ "you edited": ["decide"], "changed since install": ["diff", "keep"] });
  assert.equal(await main(flags(box), ctxFor(box, [], []), s.p), 0);
  assert.ok(s.notes.some((n) => n.includes("edited by the user")), s.notes.join("\n---\n"));
  const offered = s.offered.filter((options) => options.includes("take"));
  assert.equal(offered.length, 2);
  assert.ok(offered[0].includes("diff") && !offered[1].includes("diff"));
  assert.ok(readFileSync(path).equals(mine));
});

test("L10 take overwrites with a backup of the user's version", async () => {
  const { box, path, original, mine } = seeded();
  const s = scripted({ "you edited": ["decide"], "changed since install": ["take"] });
  assert.equal(await main(flags(box), ctxFor(box, [], []), s.p), 0);
  assert.ok(readFileSync(path).equals(original));
  assert.ok(!existsSync(`${path}.pi-setup-new`));
  const runs = readdirSync(piPath(box, ".pi-setup/backups"));
  assert.equal(runs.length, 1);
  assert.ok(readFileSync(piPath(box, ".pi-setup/backups", runs[0], "extensions/guards.ts")).equals(mine));
});

test("L10 cancelling at the conflict prompt writes nothing", async () => {
  const { box } = seeded();
  const before = snapshot(box.home, true);
  const s = scripted({ "you edited": ["decide"], "changed since install": [CANCEL] });
  const errs: string[] = [];
  assert.equal(await main(flags(box), ctxFor(box, [], errs), s.p), 1);
  assert.match(errs.join("\n"), /Cancelled; nothing written/);
  assert.deepEqual(snapshot(box.home, true), before);
});

test("L10 cancelling Review after keeping writes nothing", async () => {
  const { box } = seeded();
  const before = snapshot(box.home, true);
  const s = scripted({ "you edited": ["decide"], "changed since install": ["keep"], "Review": ["cancel"] });
  assert.equal(await main(flags(box), ctxFor(box, [], []), s.p), 1);
  assert.deepEqual(snapshot(box.home, true), before);
});

test("the conflict prompt says '1 file you edited' for one file", async () => {
  const { box } = seeded();
  const s = scripted({ "you edited": ["keep"] });
  assert.equal(await main(flags(box), ctxFor(box, [], []), s.p), 0);
  assert.ok(s.events.includes("select:1 file you edited"), s.events.join("\n"));
});
