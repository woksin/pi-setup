import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { main } from "../src/run.ts";
import { realContext, realRun, realWhich } from "../src/context.ts";
import { CANCEL, type Ctx, type Prompter } from "../src/types.ts";
import { assertTempHome, install, REPO, sandbox } from "./helpers/home.ts";
test("installed lanes guides two locked worktrees and runs the ops in a throwaway HOME", { timeout: 120000 }, async () => {
  const box = sandbox(); assertTempHome(box.home);
  const repos = join(box.root, "repos"); const root = join(repos, ".lanes"); const lines: string[] = []; const errors: string[] = [];
  const env: Record<string, string> = { HOME: box.home, TMPDIR: box.root, PATH: [box.stubs, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter), STUB_LOG: box.log,
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const run = (cmd: string, args: string[], expected = 0) => {
    const r = spawnSync(cmd, args, { env, cwd: box.root, encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, expected, `${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}\n${r.error || ""}`); return r;
  };
  const lanes = (expected: number, ...args: string[]) => run(process.execPath, [join(box.home, ".local/share/pi-setup/lanes/lanes.mjs"), "--dir", root, ...args], expected);
  const stub = (name: string, body: string) => writeFileSync(join(box.stubs, name), `#!/bin/sh\necho '${name} '"$*" >> "$STUB_LOG"\n${body}\n`, { mode: 0o755 });
  try {
    for (const name of ["alpha", "beta"]) {
      const remote = join(box.root, `remotes/example/${name}.git`); mkdirSync(remote, { recursive: true });
      run("git", ["init", "--bare", "--initial-branch=main", remote]);
      const seed = join(box.root, `seed-${name}`); run("git", ["clone", remote, seed]);
      writeFileSync(join(seed, "README.md"), name); run("git", ["-C", seed, "add", "."]); run("git", ["-C", seed, "commit", "-m", "seed"]); run("git", ["-C", seed, "push", "origin", "main"]);
      mkdirSync(repos, { recursive: true }); run("git", ["clone", remote, join(repos, name)]);
    }
    const installed = install(box, ["--yes", "--user", "tester", "--repos-root", repos, "--profile", "balanced", "--skip-npm", "--with", "lanes"], { entry: "node" });
    assert.equal(installed.status, 0, installed.stderr); assert.ok(lstatSync(join(box.home, ".local/bin/lanes")).isSymbolicLink());
    const installLog = readFileSync(box.log, "utf8");
    assert.match(installLog, /^pi /m);
    const installLogLength = installLog.length;
    stub("gh", `case "$1 $2" in
  "issue list") echo '[{"number":1,"title":"First","assignees":[{"login":"tester"}]}]' ;;
  "pr list") case "$*" in *example/alpha*) echo '[{"number":7,"isDraft":false,"labels":[],"statusCheckRollup":[{"conclusion":"SUCCESS"}]},{"number":8,"isDraft":true,"labels":[],"statusCheckRollup":[{"conclusion":"SUCCESS"}]},{"number":9,"isDraft":false,"labels":[],"statusCheckRollup":[{"conclusion":"FAILURE"}]}]' ;; *) echo '[]' ;; esac ;;
  *) exit 1 ;;
esac`);
    for (const name of ["pgrep", "osascript", "tmux", "pi-session"]) stub(name, "exit 1");
    const ctx: Ctx = { ...realContext(REPO), env, home: box.home, cwd: box.root, platform: "linux", stdinTTY: true, stdoutTTY: true, which: realWhich(env),
      run: (cmd, args, o) => { assert.equal(o?.env?.HOME ?? env.HOME, box.home); return realRun(cmd, args, { ...o, env: { ...env, ...o?.env } }); },
      out: (s) => lines.push(s), err: (s) => errors.push(s) };
    const selected = [join(repos, "alpha"), join(repos, "beta")];
    const answers: unknown[] = [root, selected, "1", "goal", "Fix the thing", true, true];
    const next = () => { assert.ok(answers.length, "unexpected prompt"); return Promise.resolve(answers.shift() as never); };
    const p: Prompter = { intro: () => {}, outro: () => {}, note: () => {}, spinner: () => ({ start: () => {}, stop: () => {} }), confirm: next, select: next, text: next, multiselect: next, isCancel: (v) => v === CANCEL };
    assert.equal(await main(["lanes"], ctx, p), 0, errors.join("\n")); assert.equal(answers.length, 0);
    const c = JSON.parse(readFileSync(join(root, "lanes.json"), "utf8")); assert.equal(c.lanes.length, 2);
    assert.equal(c.terminal.backend, "auto");
    for (const [i, lane] of c.lanes.entries()) {
      const wt = join(repos, ".worktrees", lane.worktree); assert.ok(existsSync(wt));
      assert.equal(run("git", ["-C", wt, "branch", "--show-current"]).stdout.trim(), i === 0 ? "l1-issue-1" : "l2-fix-the-thing");
      assert.match(run("git", ["-C", wt, "worktree", "list", "--porcelain"]).stdout, new RegExp(`locked lanes ${lane.id}`));
    }
    assert.equal(lines.filter((s) => s.startsWith("cd ") && s.includes("PI_ORCH_ID=L0")).length, 1);
    lanes(0, "status"); lanes(0, "send", "L1", "hello", "-m", "hi", "--from", "L0");
    const original = readdirSync(join(root, "messages")).find((n) => n.includes("hello"))!;
    const path = join(root, "messages", original); const before = readFileSync(path, "utf8");
    assert.equal(lanes(0, "green-prs").stdout.trim(), "example/alpha#7 — staleness unknown: CI/main comparison unavailable or incomplete; verify before merging");
    lanes(0, "green-prs", "--new"); assert.equal(lanes(0, "green-prs", "--ack").stdout.trim(), "acked 1"); lanes(1, "green-prs", "--new");
    lanes(1, "idle-check"); assert.match(lanes(1, "resume-check").stdout, /MISSING watch:/);
    const configBefore = readFileSync(join(root, "lanes.json"), "utf8");
    lanes(3, "nudge", "L1", "hi");
    lanes(0, "close", "L2", "--reassign-to", "L1", "--reason", "done", "--from", "L0");
    assert.match(readFileSync(join(root, "messages/status/L2.status"), "utf8"), /^closed reassigned-to L1/);
    assert.ok(readdirSync(join(root, "messages")).some((n) => n.includes("L0-to-ALL-lane-closed-l2-")));
    assert.equal(readFileSync(path, "utf8"), before); assert.ok(existsSync(join(repos, ".worktrees", c.lanes[1].worktree)));
    assert.equal(readFileSync(join(root, "lanes.json"), "utf8"), configBefore);
    assert.doesNotMatch(readFileSync(box.log, "utf8").slice(installLogLength), /^(?:osascript|tmux|pi|pi-session) /m);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});
