import { strict as assert } from "node:assert";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { lstatSync } from "node:fs";
import { REPO, findBackups, homeEntries, install, installLines, piPath, sandbox, stubLog } from "./helpers/home.ts";
import type { Sandbox } from "./helpers/home.ts";

const boxes: Sandbox[] = [];
function fresh(): Sandbox {
  const box = sandbox();
  boxes.push(box);
  return box;
}
after(() => {
  for (const box of boxes) rmSync(box.root, { recursive: true, force: true });
});

const ARGS = (box: Sandbox) => ["--yes", "--with", "cratis", "--user", "einari", "--repos-root", join(box.root, "repos")];
const profileCalls = (box: Sandbox) => stubLog(box).filter((l) => l.startsWith("python3") && l.includes("pi-profile"));

describe("install (e2e)", () => {
  test("(a) clean-HOME install through install.sh", () => {
    const box = fresh();
    const run = install(box, ARGS(box));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^Health check: /m);
    const user = JSON.parse(readFileSync(piPath(box, "user.json"), "utf8"));
    assert.deepEqual(user, { githubUser: "einari", reposRoot: join(box.root, "repos") });
    assert.match(readFileSync(piPath(box, "AGENTS.md"), "utf8"), /--add-assignee einari/);
    assert.equal(readFileSync(piPath(box, "profiles/ACTIVE"), "utf8"), "balanced\n");
    assert.ok(readdirSync(join(box.home, ".agents/skills")).includes("github-issue-hygiene"));
    const npm = stubLog(box).filter((l) => l.startsWith("npm install"));
    assert.equal(npm.length, 1);
    assert.match(npm[0], /^npm install @woksin\/pi-jobs@0\.3\.1 @woksin\/pi-context-budget@0\.5\.0 @woksin\/pi-recover@0\.1\.1 @woksin\/pi-orch@0\.1\.1 --save-exact --legacy-peer-deps --no-audit --no-fund --loglevel=error cwd=/);
    assert.equal(realpathSync(npm[0].split("cwd=")[1]), realpathSync(piPath(box, "npm")));
    const checks = stubLog(box).filter((l) => l.startsWith("pi auth check"));
    assert.equal(checks.length, 3);
    for (const c of checks) {
      assert.ok(c.includes("--no-refresh"), c);
      assert.ok(!c.includes("--credentials"), c);
    }
    assert.ok(!/Kimi is not logged in/.test(run.stdout));
  });

  test("(b) no-TTY --yes run completes without a prompt, also via node directly", () => {
    const box = fresh();
    const run = install(box, ARGS(box), { entry: "node", env: { CI: "" } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Setup finished\. Next: follow steps 1–\d above\./);
    assert.match(run.stdout, /Next steps:\n(  \d\. .*\n)+.*Start with: pi/);
  });

  test("(c) a re-run is a no-op", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    const before = stubLog(box).length;
    const again = install(box, []);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.doesNotMatch(again.stdout, /Installed \d+ files/);
    assert.deepEqual(findBackups(piPath(box)), []);
    const newCalls = stubLog(box).slice(before);
    assert.ok(!newCalls.some((l) => l.startsWith("npm install")), newCalls.join("\n"));
    assert.deepEqual(profileCalls(box), []);
    assert.match(again.stdout, /Everything up to date/);
  });

  test("(d) --dry-run writes nothing and runs neither npm nor pi-profile", () => {
    const box = fresh();
    const run = install(box, [...ARGS(box), "--dry-run"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(homeEntries(box), []);
    assert.ok(installLines(run.stdout).length > 50);
    assert.deepEqual(stubLog(box).filter((l) => l.startsWith("npm install")), []);
    assert.deepEqual(profileCalls(box), []);
  });

  test("(e) argument errors exit 1 and write nothing", () => {
    for (const args of [["--user"], ["--repos-root", "--dry-run"], ["--unknown"], ["--user", ""]]) {
      const box = fresh();
      const run = install(box, args);
      assert.equal(run.status, 1, args.join(" "));
      assert.ok(run.stderr.length > 0);
      assert.deepEqual(homeEntries(box), [], args.join(" "));
    }
  });

  test("(f) node missing or too old: names Node first, exit 1, nothing written, nothing installed", () => {
    const box = fresh();
    const fake = join(box.root, "fakenode");
    mkdirSync(fake);
    writeFileSync(join(fake, "node"), '#!/bin/sh\ncase "$1" in -e) exit 1 ;; -p) echo 20.0.0 ;; esac\n');
    chmodSync(join(fake, "node"), 0o755);
    const noInstall = [...ARGS(box), "--no-install-prereqs"];
    const old = install(box, noInstall, { path: `${fake}:/usr/bin:/bin` });
    assert.equal(old.status, 1);
    assert.match(old.stderr, /Node\.js >= 22\.19.*found 20\.0\.0/);
    const empty = join(box.root, "empty");
    mkdirSync(empty);
    const missing = install(box, noInstall, { path: empty });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Node\.js >= 22\.19/);
    assert.deepEqual(homeEntries(box), []);
  });

  test("(g) user.json keeps unknown keys and is written atomically", () => {
    const box = fresh();
    mkdirSync(piPath(box), { recursive: true });
    writeFileSync(piPath(box, "user.json"), JSON.stringify({ orchRepoRoot: "/keep", githubUser: "old", reposRoot: "/old" }));
    const run = install(box, ARGS(box), { env: { STUB_READY: "" } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const text = readFileSync(piPath(box, "user.json"), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(text)), ["orchRepoRoot", "githubUser", "reposRoot"]);
    assert.equal(JSON.parse(text).orchRepoRoot, "/keep");
    assert.equal(JSON.parse(text).githubUser, "einari");
    assert.deepEqual(findBackups(piPath(box)), []);
    const runs = readdirSync(piPath(box, ".pi-setup/backups"));
    assert.equal(runs.length, 1);
    assert.equal(JSON.parse(readFileSync(piPath(box, ".pi-setup/backups", runs[0], "user.json"), "utf8")).githubUser, "old");
    assert.deepEqual(readdirSync(piPath(box)).filter((n) => n.includes(".tmp-")), []);
    const again = install(box, []);
    assert.doesNotMatch(again.stdout, /Installed \d+ files/);
    assert.equal(readFileSync(piPath(box, "user.json"), "utf8"), text);
  });

  test("openai-only login picks openai-only, applies it live and re-runs quietly", () => {
    const box = fresh();
    const run = install(box, ARGS(box), { ready: "openai-codex" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(readFileSync(piPath(box, "profiles/ACTIVE"), "utf8"), "openai-only\n");
    const dir = join(REPO, "agent/profiles/openai-only/agents");
    for (const f of readdirSync(dir)) {
      assert.equal(readFileSync(piPath(box, "agents", f), "utf8"), readFileSync(join(dir, f), "utf8"), f);
    }
    assert.match(run.stdout, /Kimi is not logged in|openai-only/);
    const again = install(box, [], { ready: "openai-codex" });
    assert.doesNotMatch(again.stdout, /Installed \d+ files/);
    assert.deepEqual(profileCalls(box), []);
  });

  test("an existing ACTIVE plus --profile switches ACTIVE without ever calling pi-profile", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    const run = install(box, ["--yes", "--profile", "openai-only"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(profileCalls(box), []);
    assert.equal(readFileSync(piPath(box, "profiles/ACTIVE"), "utf8"), "openai-only\n");
    const again = install(box, ["--yes"]);
    assert.doesNotMatch(again.stdout, /Installed \d+ files/);
    assert.deepEqual(profileCalls(box), []);
  });

  test("Kimi missing is said once in the summary", () => {
    const box = fresh();
    const run = install(box, ARGS(box), { ready: "anthropic,openai-codex" });
    assert.equal(run.stdout.split("\n").filter((l) => /Kimi roles fall back to GPT/.test(l)).length, 1, run.stdout);
  });

  test("an unknown --profile fails before any write", () => {
    const box = fresh();
    const run = install(box, [...ARGS(box), "--profile", "nope"]);
    assert.equal(run.status, 1);
    assert.deepEqual(homeEntries(box), []);
  });

  test("auth.json content never reaches the output", () => {
    const box = fresh();
    mkdirSync(piPath(box), { recursive: true });
    writeFileSync(piPath(box, "auth.json"), '{"anthropic":{"key":"SENTINEL-SECRET-123"}}');
    const run = install(box, ARGS(box));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(!(run.stdout + run.stderr).includes("SENTINEL-SECRET-123"));
  });

  test("--plan --json prints one JSON object and writes nothing", () => {
    const box = fresh();
    const run = install(box, [...ARGS(box), "--plan", "--json"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const data = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(data), ["settings", "detection", "profile", "actions", "warnings", "exitCode"]);
    assert.equal(data.settings.githubUser, "einari");
    assert.ok(data.actions.length > 50);
    assert.deepEqual(homeEntries(box), []);
  });

  for (const mode of ["--dry-run", "--plan"]) {
    test(`${mode} with an existing ~/.pi/agent makes zero pi calls and changes nothing`, () => {
      const box = fresh();
      mkdirSync(piPath(box), { recursive: true });
      writeFileSync(piPath(box, "user.json"), '{"githubUser":"einari","reposRoot":"/tmp/r"}');
      const snapshot = () => {
        const out: string[] = [];
        const walk = (d: string) => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            const st = lstatSync(p);
            out.push(`${p} ${st.mtimeMs} ${st.size}`);
            if (e.isDirectory()) walk(p);
          }
        };
        walk(box.home);
        return out.sort();
      };
      const before = snapshot();
      const run = install(box, ["--yes", mode]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.deepEqual(stubLog(box).filter((l) => l.startsWith("pi ")), []);
      assert.deepEqual(snapshot(), before);
      assert.match(run.stdout + run.stderr, /provisional: the real install picks by logged-in providers/);
    });
  }
});
