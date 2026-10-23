import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, REPO } from "./helpers/home.ts";
import { defaults, validate, saveConfig, loadConfig, effectiveParent } from "../src/lanes/config.ts";
import { main } from "../src/lanes/main.ts";
import { parseMessageName } from "../src/lanes/names.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
function fixture() {
  const root = tempDir("lanes-orch"); const c = defaults(root, root, join(root, "repos"));
  c.lanes = [{ id: "L1", repo: "example/alpha", worktree: "l1", branch: "l1", prompt: "prompts/L1.md", group: null }];
  saveConfig(root, c); const out: string[] = []; const err: string[] = []; const calls: string[][] = [];
  const ctx: LanesCtx = { cwd: root, home: root, piAgentDir: join(root, ".pi/agent"), env: {}, platform: "darwin", now: () => new Date(), which: () => undefined,
    templatesDir: join(REPO, "installer/lanes/templates"), out: s => out.push(s), err: s => err.push(s), realpath: p => p, stdinTTY: true, readStdin: async () => "", loadModule: async () => ({}),
    run: async (cmd, args) => { calls.push([cmd, ...args]); if (args.includes("add")) mkdirSync(args.at(-2)!, { recursive: true }); return { code: cmd === "pgrep" || args.includes("show-ref") ? 1 : 0, stdout: args.includes("get-url") ? "https://host/example/alpha.git" : "", stderr: "", timedOut: false }; } };
  return { root, c, out, err, ctx, calls, invoke: (...a: string[]) => main(["--dir", root, ...a], ctx) };
}
test("hierarchy validates roles, parents, cycles, worktrees and unique repo orchestrators", () => {
  for (const patch of [{ role: "bad" }, { parent: "NO" }, { parent: "L1" }, { role: "repo-orch", parent: "L2" }]) {
    const f = fixture(); Object.assign(f.c.lanes[0], patch); assert.throws(() => validate(f.c));
  }
  const f = fixture(); assert.equal(effectiveParent(f.c.lanes[0], f.c), "L0");
  f.c.lanes.push({ ...f.c.lanes[0], id: "R-A", worktree: "ra", role: "repo-orch" });
  assert.equal(effectiveParent(f.c.lanes[0], f.c), "R-A");
  f.c.lanes.push({ ...f.c.lanes[1], id: "R-B", worktree: "rb" }); assert.throws(() => validate(f.c));
});
test("second lane creates candidate orchestrator, reparents, notifies and renders briefs", async () => {
  const f = fixture(); assert.equal(await f.invoke("add", "L2", "--repo", "example/alpha"), 0);
  const c = loadConfig(f.root); const orch = c.lanes.find(l => l.role === "repo-orch")!;
  assert.equal(orch.id, "R-ALPHA"); assert.equal(c.lanes[0].parent, orch.id);
  assert.ok(f.calls.some(a => a.includes("r-alpha-candidate")));
  assert.match(readFileSync(join(f.root, orch.prompt), "utf8"), /inbox-watch R-ALPHA/);
  assert.match(readFileSync(join(f.root, "prompts/L2.md"), "utf8"), /Report to R-ALPHA/);
  assert.equal(await f.invoke("status"), 0); assert.match(f.out.at(-1)!, /ROLE\s+PARENT/);
});
test("promotion, opt out and ID collision are explicit", async () => {
  const f = fixture(); assert.equal(await f.invoke("add", "L2", "--repo", "example/alpha", "--orchestrator", "L1"), 0);
  assert.equal(loadConfig(f.root).lanes[0].role, "repo-orch");
  const g = fixture(); assert.equal(await g.invoke("add", "L2", "--repo", "example/alpha", "--no-orchestrator"), 0); assert.ok(g.err.some(s => /no repo-orch/.test(s)));
  const h = fixture(); h.c.lanes.push({ ...h.c.lanes[0], repo: "example/beta", id: "R-ALPHA", worktree: "other" }); saveConfig(h.root, h.c);
  assert.equal(await h.invoke("add", "L2", "--repo", "example/alpha"), 1); assert.equal(h.calls.length, 0);
});
test("send routes lane to repo parent, direct and orchestrator bypass; timestamp names parse", async () => {
  const f = fixture(); f.c.lanes.push({ ...f.c.lanes[0], id: "R-A", role: "repo-orch", worktree: "ra" }); saveConfig(f.root, f.c);
  assert.equal(await f.invoke("send", "L0", "report", "-m", "hi", "--from", "L1"), 0); assert.match(f.out.at(-1)!, /L1-to-R-A/); assert.match(f.err.at(-1)!, /routed to R-A/);
  await f.invoke("send", "L0", "report", "-m", "hi", "--from", "L1", "--direct"); assert.match(f.out.at(-1)!, /L1-to-L0/);
  await f.invoke("send", "L0", "report", "-m", "hi", "--from", "R-A"); assert.match(f.out.at(-1)!, /R-A-to-L0/);
  assert.deepEqual(parseMessageName("20261023-074001-L0-to-L15-x.md"), { from: "L0", to: ["L15"], topic: "x" });
});
