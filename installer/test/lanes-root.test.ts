import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { REPO, tempDir } from "./helpers/home.ts";

function fixture() {
  const home = realpathSync(tempDir("lanes-root"));
  const stubs = join(home, "stubs"); mkdirSync(stubs);
  writeFileSync(join(stubs, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("LANES_")));
  Object.assign(env, { HOME: home, PATH: `${stubs}:${process.env.PATH}`, XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: join(home, "agent"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" });
  function run(cwd: string, cmd: string, args: string[], expected = 0) {
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, expected, `${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}\n${r.error || ""}`);
    return r;
  }
  const lanes = (cwd: string, args: string[], expected?: number) => run(cwd, process.execPath, [join(REPO, "installer/dist/lanes.mjs"), ...args], expected);
  const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);
  function config(root: string, id: string) {
    mkdirSync(root, { recursive: true });
    const c = defaults(root, home); c.coordinator.id = id; saveConfig(root, c);
    return root;
  }
  const status = (cwd: string, id: string, ...args: string[]) => assert.match(lanes(cwd, ["status", ...args]).stdout, new RegExp(`^${id}\\s+coord\\b`, "m"));
  return { home, env, lanes, git, config, status };
}

test("linked worktrees use the main checkout and its parents before the saved default", () => {
  const { home, env, lanes, git, config, status } = fixture();
  lanes(home, ["init", "saved coord", "--coordinator", "L1"]);
  const main = join(home, "main"); const checkout = join(main, "repo with spaces");
  const worktree = join(home, "worktree"); const cwd = join(worktree, "nested");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init"); git(checkout, "commit", "--allow-empty", "-m", "seed");
  git(checkout, "worktree", "add", "--detach", worktree); mkdirSync(cwd);

  status(cwd, "L1");
  lanes(cwd, ["register", "L9", "--pid", String(process.pid), "--cwd", cwd]);
  lanes(cwd, ["--dir", join(home, "saved coord"), "unregister", "L9"]);

  config(main, "L2"); status(cwd, "L2");
  lanes(cwd, ["register", "L9", "--pid", String(process.pid), "--cwd", cwd]);
  lanes(cwd, ["--dir", main, "unregister", "L9"]);

  config(worktree, "L3"); status(cwd, "L3");
  env.LANES_DIR = config(join(home, "env"), "L4"); status(cwd, "L4");
  const explicit = config(join(home, "explicit"), "L5"); status(cwd, "L5", "--dir", explicit);
});

test("existing folders seed a missing default; init can switch it, and missing configs are ignored", () => {
  const { home, lanes, config, status } = fixture();
  const first = config(join(home, "first"), "L1"); const second = config(join(home, "second"), "L2");
  status(home, "L1", "--dir", first);
  status(home, "L2", "--dir", second);
  status(home, "L1");
  lanes(home, ["init", "second"]); status(home, "L2");
  rmSync(join(second, "lanes.json"));
  lanes(home, ["status"], 2);
  mkdirSync(join(second, "lanes.json"));
  lanes(home, ["status"], 2);
  status(first, "L1");
});
