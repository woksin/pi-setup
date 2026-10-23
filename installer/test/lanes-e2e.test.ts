import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertTempHome, REPO, tempDir } from "./helpers/home.ts";

test("built lanes bundle coordinates two real locked worktrees without starting sessions", () => {
  const home = assertTempHome(tempDir("lanes-e2e"));
  const stubs = join(home, "stubs"); mkdirSync(stubs);
  const log = join(home, "stubs.log");
  const env = { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}`, STUB_LOG: log, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  for (const key of ["TMUX", "TERM_PROGRAM", "PI_CODING_AGENT_DIR", "LANES_DIR", "LANES_TEMPLATES"]) delete env[key];
  for (const name of ["pgrep", "lsof", "osascript", "tmux", "pi", "pi-session"]) writeFileSync(join(stubs, name), `#!/bin/sh\necho '${name} '"$*" >> "$STUB_LOG"\nexit ${name === "pi-session" ? 0 : 1}\n`, { mode: 0o755 });
  const run = (cmd: string, args: string[], cwd = home) => {
    const r = spawnSync(cmd, args, { env, cwd, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, `${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}\n${r.error || ""}`); return r;
  };
  const root = join(home, "coord"); const repos = join(home, "repos");
  const lanes = (...args: string[]) => run(process.execPath, [join(REPO, "installer/dist/lanes.mjs"), ...args]);
  try {
    for (const name of ["alpha", "beta"]) {
      const remote = join(home, "remotes/example", `${name}.git`); mkdirSync(remote, { recursive: true });
      run("git", ["init", "--bare", "--initial-branch=main", remote]);
      const scratch = join(home, `seed-${name}`); run("git", ["clone", remote, scratch]);
      writeFileSync(join(scratch, "README.md"), name);
      if (name === "alpha") writeFileSync(join(scratch, ".mcp.json"), '{"mcpServers":{"test":{"command":"false"}}}');
      run("git", ["-C", scratch, "add", "."]); run("git", ["-C", scratch, "commit", "-m", "seed"]); run("git", ["-C", scratch, "push", "origin", "main"]);
      mkdirSync(repos, { recursive: true }); run("git", ["clone", remote, join(repos, name)]);
    }
    lanes("init", root, "--repos-root", repos, "--terminal", "print");
    const invoke = (...args: string[]) => lanes("--dir", root, ...args);
    const first = invoke("add", "L1", "--repo", "example/alpha", "--issue", "1");
    assert.match(first.stdout, /MCP preapproval is off/);
    // Opt-in only through an explicit saved setting; exercises the guarded skip path.
    const configPath = join(root, "lanes.json"); const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.launch.preapproveMcp = true; writeFileSync(configPath, JSON.stringify(config));
    const skip = invoke("start", "L1"); assert.match(skip.stderr, /MCP preapproval skipped: adapter not found/);
    invoke("add", "L2", "--repo", "example/beta", "--goal", "Fix the thing");
    const started = invoke("start", "coordinator");
    assert.equal(started.stdout.trim().split("\n").filter((s) => s.startsWith("cd ")).length, 1);
    assert.match(started.stdout, /PI_ORCH_ID=L0.*@/);
    invoke("send", "L1", "hello-world", "-m", "hi", "--from", "L0");
    const status = invoke("status");
    for (const id of ["L0", "L1", "L2"]) assert.match(status.stdout, new RegExp(`^${id}\\s`, "m"));
    assert.match(status.stdout, /L1.*L0-to-L1-hello-world/);
    const c = JSON.parse(readFileSync(configPath, "utf8")); assert.equal(c.lanes.length, 2);
    for (const lane of c.lanes) {
      const wt = join(repos, ".worktrees", lane.worktree); assert.ok(existsSync(wt));
      assert.equal(run("git", ["-C", wt, "branch", "--show-current"]).stdout.trim(), lane.branch);
      assert.equal(run("git", ["-C", wt, "rev-parse", "HEAD"]).stdout, run("git", ["-C", wt, "rev-parse", "origin/main"]).stdout);
      assert.match(run("git", ["-C", wt, "worktree", "list", "--porcelain"]).stdout, /locked lanes L[12]/);
      assert.ok(!readFileSync(join(root, lane.prompt), "utf8").includes("{{"));
    }
    assert.equal(c.lanes[0].branch, "l1-issue-1"); assert.equal(c.lanes[1].branch, "l2-fix-the-thing");
    const message = readdirSync(join(root, "messages")).find((n) => /^L0-to-L1-hello-world-\d{4}\.md$/.test(n));
    assert.ok(message); assert.equal(readFileSync(join(root, "messages", message), "utf8"), "hi");
    assert.doesNotMatch(readFileSync(log, "utf8"), /^(?:osascript|tmux|pi|pi-session) /m);
    assert.equal(invoke("init", root).status, 0);
    const duplicate = spawnSync(process.execPath, [join(REPO, "installer/dist/lanes.mjs"), "--dir", root, "add", "L1", "--repo", "example/alpha"], { env, encoding: "utf8", timeout: 60000 });
    assert.equal(duplicate.status, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
