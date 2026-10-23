import { strict as assert } from "node:assert";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { realContext, realRun, realWhich } from "../src/context.ts";
import { main } from "../src/run.ts";
import { CANCEL } from "../src/types.ts";
import type { Ctx, Prompter } from "../src/types.ts";
import { REPO, assertTempHome, install, piPath, sandbox, snapshot } from "./helpers/home.ts";
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

/** An in-process Ctx whose every child process and path lives in the sandbox. */
function ctxFor(box: Sandbox, lines: string[], errs: string[]): Ctx {
  assertTempHome(box.home);
  const env = {
    HOME: box.home, TMPDIR: box.root, STUB_LOG: box.log, STUB_READY: "anthropic,openai-codex,kimi-coding",
    PATH: [box.stubs, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
  };
  return {
    ...realContext(REPO), env, home: box.home, cwd: REPO, stdinTTY: true, stdoutTTY: true, which: realWhich(env),
    run: (cmd, args, o) => {
      assert.equal(o?.env?.HOME ?? env.HOME, box.home);
      return realRun(cmd, args, { ...o, env: { ...env, ...o?.env } });
    },
    out: (l) => lines.push(l), err: (l) => errs.push(l),
  };
}

function scripted(answers: Record<string, unknown[]>) {
  const events: string[] = [];
  const notes: string[] = [];
  const offered: string[][] = [];
  const answer = (kind: string, message: string, fallback: unknown) => {
    events.push(`${kind}:${message}`);
    const queue = Object.entries(answers).find(([key]) => message.includes(key))?.[1];
    return Promise.resolve(queue?.length ? queue.shift() : fallback);
  };
  const p: Prompter = {
    intro: () => {}, outro: () => {}, note: (body) => notes.push(body), spinner: () => ({ start: () => {}, stop: () => {} }),
    confirm: (o) => answer("confirm", o.message, true) as never,
    select: (o) => {
      offered.push(o.options.map((x) => x.value));
      return answer("select", o.message, o.initial) as never;
    },
    text: (o) => answer("text", o.message, o.initial ?? "") as never,
    isCancel: (v) => v === CANCEL,
  };
  return { p, events, notes, offered };
}

test("L10 the conflict prompt comes before Apply; keep writes .pi-setup-new", async () => {
  const { box, path, original, mine } = seeded();
  const s = scripted({ "changed since install": ["keep"] });
  const lines: string[] = [];
  const code = await main(flags(box), ctxFor(box, lines, []), s.p);
  assert.equal(code, 0, lines.join("\n"));
  const conflict = s.events.findIndex((e) => e.includes("changed since install"));
  const apply = s.events.findIndex((e) => e === "confirm:Apply?");
  assert.ok(conflict >= 0 && apply > conflict, s.events.join("\n"));
  assert.ok(readFileSync(path).equals(mine));
  assert.ok(readFileSync(`${path}.pi-setup-new`).equals(original));
});

test("L10 diff shows a note and asks again without the diff choice", async () => {
  const { box, path, mine } = seeded();
  const s = scripted({ "changed since install": ["diff", "keep"] });
  assert.equal(await main(flags(box), ctxFor(box, [], []), s.p), 0);
  assert.ok(s.notes.some((n) => n.includes("edited by the user")), s.notes.join("\n---\n"));
  assert.equal(s.offered.length, 2);
  assert.ok(s.offered[0].includes("diff") && !s.offered[1].includes("diff"));
  assert.ok(readFileSync(path).equals(mine));
});

test("L10 take overwrites with a backup of the user's version", async () => {
  const { box, path, original, mine } = seeded();
  const s = scripted({ "changed since install": ["take"] });
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
  const s = scripted({ "changed since install": [CANCEL] });
  const errs: string[] = [];
  assert.equal(await main(flags(box), ctxFor(box, [], errs), s.p), 1);
  assert.match(errs.join("\n"), /Cancelled; nothing written/);
  assert.deepEqual(snapshot(box.home, true), before);
});

test("L10 declining Apply after keeping writes nothing", async () => {
  const { box } = seeded();
  const before = snapshot(box.home, true);
  const s = scripted({ "changed since install": ["keep"], "Apply?": [false] });
  assert.equal(await main(flags(box), ctxFor(box, [], []), s.p), 1);
  assert.deepEqual(snapshot(box.home, true), before);
});
