import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, tempDir } from "./helpers/home.ts";
import { main } from "../src/lanes/main.ts";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";

interface Opts { running?: boolean; dirty?: string; merged?: number; ignored?: number; removeCode?: number; statusCode?: number }
function fixture(o: Opts = {}) {
  const home = realpathSync(tempDir("lanes-close")); const root = join(home, "coord"); mkdirSync(root);
  const clone = join(home, "repos/alpha");
  const c = defaults(root, home, join(home, "repos")); c.terminal.backend = "print";
  c.lanes = [{ id: "L1", repo: "example/alpha", worktree: "l1", branch: "l1", prompt: "prompts/l1.md", group: null }];
  const cwd = join(home, "repos/.worktrees/l1"); mkdirSync(cwd, { recursive: true }); saveConfig(root, c);
  mkdirSync(join(root, "messages"));
  const out: string[] = []; const err: string[] = []; const calls: string[] = [];
  const res = (stdout = "", code = 0) => ({ stdout, code, stderr: "failed", timedOut: false });
  const ctx: LanesCtx = { home, cwd: root, env: {}, platform: "darwin", now: () => new Date(2026, 0, 2, 3, 4, 5), which: () => undefined,
    out: (s) => out.push(s), err: (s) => err.push(s), stdinTTY: true, readStdin: async () => "", sleep: async () => {},
    templatesDir: join(REPO, "installer/lanes/templates"), piAgentDir: join(home, ".pi/agent"), realpath: (p) => p, loadModule: async () => ({}),
    run: async (cmd, args) => {
      if (cmd === "pgrep") return res(o.running ? "101\n" : "", o.running ? 0 : 1);
      if (cmd === "lsof") return res(`p101\nn${cwd}\n`);
      if (cmd === "ps" && args[0] === "-A") return res(o.running ? "101 1 pi\n" : "");
      if (cmd !== "git") return res("", 1);
      const sub = args.slice(2); calls.push(sub.join(" "));
      if (sub[0] === "rev-parse" && sub.includes("--git-common-dir")) return res(join(clone, ".git"));
      if (sub[0] === "rev-parse") return res(cwd);
      if (sub[0] === "status") return res(o.dirty ?? "!! .ai-work/\n", o.statusCode ?? 0);
      if (sub[0] === "symbolic-ref") return res("origin/main\n");
      if (sub[0] === "merge-base") return res("", o.merged ?? 0);
      if (sub[0] === "check-ignore") return res("", o.ignored ?? 0);
      if (sub[0] === "worktree" && sub[1] === "remove") return res("", o.removeCode ?? 0);
      return res();
    } };
  const closed = () => JSON.parse(readFileSync(join(root, "lanes.json"), "utf8")).lanes[0].closed;
  return { home, root, clone, cwd, ctx, out, err, calls, closed, invoke: (...a: string[]) => main(["--dir", root, ...a], ctx) };
}
const removed = (f: ReturnType<typeof fixture>) => f.calls.some((s) => s.startsWith("worktree remove"));

test("merged and clean: archives .ai-work, unlocks, removes without --force", async () => {
  const f = fixture(); mkdirSync(join(f.cwd, ".ai-work"), { recursive: true }); writeFileSync(join(f.cwd, ".ai-work/note.md"), "keep me");
  assert.equal(await f.invoke("close", "L1"), 0);
  const dest = join(f.clone, ".ai-work/keep/removed-worktrees/l1/note.md");
  assert.equal(readFileSync(dest, "utf8"), "keep me");
  const unlock = f.calls.findIndex((s) => s.startsWith("worktree unlock")); const rm = f.calls.findIndex((s) => s.startsWith("worktree remove"));
  assert.ok(unlock >= 0 && rm > unlock); assert.ok(!f.calls.some((s) => /--force| -f\b/.test(s)));
  assert.match(f.out.join("\n"), /worktree removed/); assert.ok(f.closed());
});
test("not merged is left with a reason and the removal hint", async () => {
  const f = fixture({ merged: 1 }); assert.equal(await f.invoke("close", "L1"), 0);
  assert.ok(!removed(f)); assert.ok(f.out.includes("worktree left: not merged")); assert.match(f.out.at(-1)!, /worktree remove/); assert.ok(f.closed());
});
test("dirty worktree (including ignored files) is left", async () => {
  for (const dirty of [" M src/a.ts\n", "?? new.txt\n", "!! node_modules/\n!! .ai-work/\n"]) {
    const f = fixture({ dirty }); assert.equal(await f.invoke("close", "L1"), 0);
    assert.ok(!removed(f)); assert.ok(f.out.some((l) => l.startsWith("worktree left: worktree is dirty"))); assert.ok(f.closed());
  }
});
test("git failures fail closed", async () => {
  for (const o of [{ statusCode: 128 }, { merged: 128 }]) {
    const f = fixture(o); assert.equal(await f.invoke("close", "L1"), 0); assert.ok(!removed(f)); assert.ok(f.out.some((l) => l.startsWith("worktree left:")));
  }
});
test("a running pi keeps the worktree", async () => {
  const f = fixture({ running: true }); assert.equal(await f.invoke("close", "L1"), 0);
  assert.ok(!removed(f)); assert.ok(f.out.includes("worktree left: L1 is still running")); assert.ok(f.closed());
});
test("missing worktree reports the existing message and runs no git", async () => {
  const f = fixture(); const { rmSync } = await import("node:fs"); rmSync(f.cwd, { recursive: true });
  assert.equal(await f.invoke("close", "L1"), 0); assert.ok(f.out.includes("worktree already removed; no removal hint")); assert.deepEqual(f.calls, []); assert.ok(f.closed());
});
test("archive failure leaves the worktree", async () => {
  const f = fixture({ ignored: 1 }); mkdirSync(join(f.cwd, ".ai-work"), { recursive: true });
  assert.equal(await f.invoke("close", "L1"), 0);
  assert.ok(!removed(f)); assert.ok(f.out.some((l) => /^worktree left: archive path is not git-ignored/.test(l))); assert.ok(f.closed());
  const g = fixture(); mkdirSync(join(g.cwd, ".ai-work"), { recursive: true }); mkdirSync(join(g.clone, ".ai-work"), { recursive: true });
  writeFileSync(join(g.clone, ".ai-work/keep"), "a file blocks the archive directory");
  assert.equal(await g.invoke("close", "L1"), 0);
  assert.ok(!removed(g)); assert.ok(g.out.some((l) => /^worktree left: archive of \.ai-work failed/.test(l)));
});
test("git refusing removal re-locks the worktree", async () => {
  const f = fixture({ removeCode: 1 }); assert.equal(await f.invoke("close", "L1"), 0);
  assert.ok(f.calls.some((s) => s.startsWith("worktree lock --reason lanes L1"))); assert.ok(f.out.includes("worktree left: git refused to remove it (re-locked)"));
});
test("--keep-worktree leaves a merged clean worktree", async () => {
  const f = fixture(); assert.equal(await f.invoke("close", "L1", "--keep-worktree"), 0);
  assert.ok(!f.calls.some((s) => s.startsWith("worktree"))); assert.ok(f.out.includes("worktree left: --keep-worktree")); assert.ok(f.closed());
});
test("real git: a merged lane worktree is removed, an unmerged one is kept", async () => {
  const g = (cwd: string, ...a: string[]) => { const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const f = fixture(); const { rmSync } = await import("node:fs"); rmSync(f.cwd, { recursive: true });
  mkdirSync(f.clone, { recursive: true }); g(f.clone, "init", "-q", "-b", "main"); writeFileSync(join(f.clone, ".gitignore"), ".ai-work/\n");
  g(f.clone, "add", "."); g(f.clone, "commit", "-qm", "init"); g(f.clone, "update-ref", "refs/remotes/origin/main", "HEAD"); g(f.clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  g(f.clone, "worktree", "add", "-q", "-b", "l1", f.cwd); g(f.clone, "worktree", "lock", f.cwd); mkdirSync(join(f.cwd, ".ai-work")); writeFileSync(join(f.cwd, ".ai-work/n.md"), "x");
  const real: LanesCtx["run"] = async (cmd, args) => { if (cmd !== "git") return { code: 1, stdout: "", stderr: "", timedOut: false }; const r = spawnSync(cmd, args, { encoding: "utf8" }); return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, timedOut: false }; };
  f.ctx.run = real;
  writeFileSync(join(f.cwd, "extra.txt"), "x"); assert.equal(await f.invoke("close", "L1"), 0); assert.ok(existsSync(f.cwd)); assert.match(f.out.join("\n"), /worktree is dirty/);
  rmSync(join(f.cwd, "extra.txt")); writeFileSync(join(f.cwd, "c.txt"), "c"); g(f.cwd, "add", "."); g(f.cwd, "commit", "-qm", "ahead");
  assert.equal(await f.invoke("close", "L1"), 0); assert.ok(existsSync(f.cwd)); assert.ok(f.out.includes("worktree left: not merged"));
  g(f.clone, "update-ref", "refs/remotes/origin/main", "l1");
  assert.equal(await f.invoke("close", "L1"), 0); assert.equal(existsSync(f.cwd), false);
  assert.equal(readFileSync(join(f.clone, ".ai-work/keep/removed-worktrees/l1/n.md"), "utf8"), "x"); assert.ok(g(f.clone, "branch", "--list", "l1").includes("l1"));
});
