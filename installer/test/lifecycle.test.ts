import { strict as assert } from "node:assert";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { after, describe, test } from "node:test";
import { REPO, backupDirs, findBackups, install, loggedInstalls, piPath, sandbox, snapshot, stubLog } from "./helpers/home.ts";
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

const ARGS = (box: Sandbox, user = "einari") => ["--yes", "--skip-npm", "--with", "cratis", "--user", user, "--repos-root", join(box.root, "repos")];
const RERUN = ["--skip-npm"];
const manifestOf = (box: Sandbox) => JSON.parse(readFileSync(piPath(box, ".pi-setup/manifest.json"), "utf8"));
const rel = (box: Sandbox, abs: string) => abs.slice(box.home.length + 1);
const EDIT = (box: Sandbox) => piPath(box, "extensions", "guards.ts");
const mutate = (path: string) => appendFileSync(path, "\n// edited by the user\n");

describe("manifest and re-runs (lifecycle e2e)", () => {
  test("L1 a clean install writes a manifest that matches the disk and names no checkout or remote", () => {
    const box = fresh();
    const run = install(box, ARGS(box));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const text = readFileSync(piPath(box, ".pi-setup/manifest.json"), "utf8");
    const m = JSON.parse(text);
    const paths = loggedInstalls(box).map((l) => l.slice("install ".length));
    assert.ok(paths.length > 50);
    for (const path of paths) {
      const r = rel(box, path);
      const sha = m.files[r]?.sha256 ?? m.json[r]?.sha256After;
      assert.ok(sha, `no entry for ${r}`);
      assert.equal(sha, createHash("sha256").update(readFileSync(path)).digest("hex"), r);
    }
    assert.ok(!text.includes(REPO), "manifest names the checkout");
    assert.ok(!text.includes("github.com/woksin"), "manifest names the remote");
  });

  test("L2 a re-run is a no-op: nothing written, manifest bytes unchanged", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    const before = snapshot(box.home, true);
    const manifest = readFileSync(piPath(box, ".pi-setup/manifest.json"));
    const again = install(box, RERUN);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /Everything up to date/);
    assert.doesNotMatch(again.stdout, /Installed \d+ files/);
    assert.deepEqual(snapshot(box.home, true), before);
    assert.ok(readFileSync(piPath(box, ".pi-setup/manifest.json")).equals(manifest));
  });

  test("L2b a plain re-run does not run npm again and writes nothing; --reinstall-npm or a changed package.json does", () => {
    const box = fresh();
    const npmCalls = () => stubLog(box).filter((l) => l.startsWith("npm install")).length;
    assert.equal(install(box, ["--yes", "--with", "cratis", "--user", "einari", "--repos-root", join(box.root, "repos")]).status, 0);
    assert.equal(npmCalls(), 1);
    const before = snapshot(box.home, true);
    const again = install(box, []);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /Everything up to date/);
    assert.equal(npmCalls(), 1);
    assert.deepEqual(snapshot(box.home, true), before);
    assert.equal(install(box, ["--reinstall-npm"]).status, 0);
    assert.equal(npmCalls(), 2);
    mutate(piPath(box, "npm/package.json"));
    assert.equal(install(box, []).status, 0);
    assert.equal(npmCalls(), 3);
    assert.equal(install(box, []).status, 0);
    assert.equal(npmCalls(), 3);
  });

  test("L3 a file you changed is kept, the repo version goes to .pi-setup-new, and a third run writes nothing", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    const path = EDIT(box);
    const original = readFileSync(path);
    mutate(path);
    const mine = readFileSync(path);
    const run = install(box, RERUN);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(readFileSync(path).equals(mine));
    assert.ok(readFileSync(`${path}.pi-setup-new`).equals(original));
    assert.match(run.stdout, /1 file\(s\) you changed|Review the files you changed/);
    const before = snapshot(box.home, true);
    const third = install(box, RERUN);
    assert.match(third.stdout, /Everything up to date\. 1 file\(s\) you changed were kept/);
    assert.deepEqual(snapshot(box.home, true), before);
  });

  test("L4 a changed rendering updates untouched files with a backup and keeps edited ones", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    const agents = readFileSync(piPath(box, "AGENTS.md"));
    const skill = join(box.home, ".agents/skills/github-issue-hygiene/SKILL.md");
    mutate(skill);
    const mine = readFileSync(skill);
    const run = install(box, ARGS(box, "another-user"));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(readFileSync(piPath(box, "AGENTS.md"), "utf8"), /--add-assignee another-user/);
    const dirs = backupDirs(box);
    assert.equal(dirs.length, 1);
    assert.ok(readFileSync(piPath(box, ".pi-setup/backups", dirs[0], "AGENTS.md")).equals(agents));
    assert.ok(readFileSync(skill).equals(mine));
    assert.match(readFileSync(`${skill}.pi-setup-new`, "utf8"), /--add-assignee another-user/);
    assert.deepEqual(findBackups(box.home), []);
  });

  test("L6 a legacy install without a manifest is adopted; only the changed file is replaced, and uninstall restores it", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    rmSync(piPath(box, ".pi-setup/manifest.json"));
    const path = EDIT(box);
    mutate(path);
    const mine = readFileSync(path);
    const run = install(box, RERUN);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(loggedInstalls(box), [`install ${path}`]);
    const m = manifestOf(box);
    assert.equal(m.files[rel(box, path)].origin, "replaced");
    assert.ok(readFileSync(piPath(box, ".pi-setup/backups", m.files[rel(box, path)].backup)).equals(mine));
    const user = readFileSync(piPath(box, "user.json"));
    const out = install(box, ["uninstall", "--yes"]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.ok(readFileSync(path).equals(mine), "the user's pre-install file is back");
    assert.ok(!existsSync(piPath(box, "AGENTS.md")));
    assert.ok(readFileSync(piPath(box, "user.json")).equals(user), "user.json untouched");
    assert.ok(!existsSync(piPath(box, ".pi-setup")));
  });

  test("L7 a tampered manifest makes uninstall refuse and change nothing", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    const good = readFileSync(piPath(box, ".pi-setup/manifest.json"), "utf8");
    for (const bad of ["../x", "/etc/hosts", ".pi/agent/auth.json", ".pi/agent/sessions/s.jsonl", ".pi/agent/.pi-setup/manifest.json"]) {
      const m = JSON.parse(good);
      m.files[bad] = { sha256: "0".repeat(64), mode: 420, source: { release: null, commit: null }, origin: "new" };
      writeFileSync(piPath(box, ".pi-setup/manifest.json"), JSON.stringify(m));
      const before = snapshot(box.home, true);
      const run = install(box, ["uninstall", "--yes"]);
      assert.equal(run.status, 1, bad);
      assert.match(run.stderr, /manifest path rejected/, bad);
      assert.deepEqual(snapshot(box.home, true), before, bad);
    }
  });

  test("L8 uninstall with no manifest says nothing is tracked and writes nothing", () => {
    const box = fresh();
    const run = install(box, ["uninstall", "--yes"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /nothing is tracked/);
    assert.deepEqual(snapshot(box.home), {});
  });

  test("L9 the dry runs and a dry prune write nothing", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    assert.equal(install(box, ARGS(box, "another-user")).status, 0);
    assert.equal(backupDirs(box).length, 1);
    const before = snapshot(box.home, true);
    for (const args of [[...ARGS(box), "--dry-run"], ["uninstall", "--dry-run"], ["backups", "prune", "--keep", "0", "--dry-run"], ["backups", "list"]]) {
      const run = install(box, args);
      assert.equal(run.status, 0, `${args.join(" ")}: ${run.stdout}${run.stderr}`);
      assert.deepEqual(snapshot(box.home, true), before, args.join(" "));
    }
    assert.match(install(box, ["backups", "prune", "--keep", "0", "--dry-run"]).stdout, /would remove/);
    assert.equal(install(box, ["backups", "prune", "--keep", "0"]).status, 0);
    assert.deepEqual(backupDirs(box), []);
  });

  test("backups: argument errors exit 1 and write nothing", () => {
    const box = fresh();
    for (const args of [["backups", "prune", "--keep", "-1"], ["backups", "prune", "--keep", "x"], ["uninstall", "--profile", "x"], ["update", "--ref", "-x"]]) {
      const run = install(box, args);
      assert.equal(run.status, 1, args.join(" "));
      assert.deepEqual(snapshot(box.home), {});
    }
  });
});

describe("uninstall (lifecycle e2e)", () => {
  test("L5 install, edit, re-run, dry-run, refuse without --yes, uninstall --yes: only your edit is left", () => {
    const box = fresh();
    mkdirSync(piPath(box, "sessions"), { recursive: true });
    mkdirSync(join(box.home, ".agents/skills/other"), { recursive: true });
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    writeFileSync(piPath(box, "AGENTS.md"), "my own agents file\n");
    chmodSync(piPath(box, "AGENTS.md"), 0o600);
    writeFileSync(piPath(box, "user.json"), '{"githubUser":"old","reposRoot":"/old","orchRepoRoot":"/keep"}');
    writeFileSync(piPath(box, "settings.json"), '{"keep":true}');
    writeFileSync(piPath(box, "auth.json"), "SENTINEL-NOT-A-SECRET");
    writeFileSync(piPath(box, "sessions/s.jsonl"), "{}\n");
    writeFileSync(join(box.home, ".agents/skills/other/SKILL.md"), "other\n");
    writeFileSync(join(box.home, ".local/bin/existing"), "#!/bin/sh\n");
    const s0 = snapshot(box.home);

    assert.equal(install(box, ARGS(box)).status, 0);
    const path = EDIT(box);
    mutate(path);
    const mine = snapshot(box.home)[rel(box, path)];
    const kept = install(box, RERUN);
    assert.ok(existsSync(`${path}.pi-setup-new`), kept.stdout);
    const quiet = install(box, RERUN);
    assert.match(quiet.stdout, /Everything up to date/);

    const before = snapshot(box.home, true);
    assert.equal(install(box, ["uninstall", "--dry-run"]).status, 0);
    assert.deepEqual(snapshot(box.home, true), before);
    const refused = install(box, ["uninstall"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--yes/);
    assert.deepEqual(snapshot(box.home, true), before);

    const run = install(box, ["uninstall", "--yes"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(run.stdout.includes(path), "output lists the modified file");
    const expected = { ...s0 };
    const dir = dirname(rel(box, path));
    for (const parts = dir.split("/"); parts.length; parts.pop()) expected[parts.join("/")] = "d";
    expected[rel(box, path)] = mine;
    // The installer's own log (outside ~/.pi/agent) is not part of what uninstall restores.
    rmSync(join(box.home, ".local/state"), { recursive: true, force: true });
    assert.deepEqual(snapshot(box.home), expected);
    assert.ok(!existsSync(piPath(box, ".pi-setup")));
    assert.equal(readFileSync(piPath(box, "auth.json"), "utf8"), "SENTINEL-NOT-A-SECRET");
  });
});

describe("data-loss regressions (review blockers)", () => {
  const PROFILE_ARGS = (box: Sandbox, profile: string) => ["--yes", "--skip-npm", "--with", "cratis", "--user", "einari", "--repos-root", join(box.root, "repos"), "--profile", profile];

  test("B1/B4 an edited agent or workflow survives a rerun, also with a different --profile; pi-profile is never called", () => {
    const box = fresh();
    assert.equal(install(box, PROFILE_ARGS(box, "balanced")).status, 0);
    const agent = piPath(box, "agents", "Explore.md");
    mutate(agent);
    const mine = readFileSync(agent);
    for (const profile of ["balanced", "openai-only"]) {
      const run = install(box, PROFILE_ARGS(box, profile));
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.ok(readFileSync(agent).equals(mine), `${profile}: edit lost`);
      assert.ok(existsSync(`${agent}.pi-setup-new`));
      assert.ok(run.stdout.includes("kept your edits; `pi-profile save` to adopt them into the profile"), run.stdout);
    }
    assert.equal(readFileSync(piPath(box, "profiles/ACTIVE"), "utf8"), "openai-only\n");
    assert.deepEqual(stubLog(box).filter((l) => l.includes("pi-profile")), []);
    const out = install(box, ["uninstall", "--yes"]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.ok(readFileSync(agent).equals(mine), "uninstall kept the edit");
  });

  test("B2 a key the user added to user.json survives uninstall; the installer's keys are gone", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    const path = piPath(box, "user.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), myKey: "mine" }));
    assert.equal(install(box, ["uninstall", "--yes"]).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { myKey: "mine" });
  });

  test("B2 a user key added before a re-run that merges again survives a later uninstall", () => {
    const box = fresh();
    mkdirSync(piPath(box), { recursive: true });
    writeFileSync(piPath(box, "user.json"), '{"githubUser":"old"}');
    assert.equal(install(box, ARGS(box)).status, 0);
    const path = piPath(box, "user.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), myKey: "mine" }));
    assert.equal(install(box, ["--yes", "--skip-npm", "--user", "other", "--repos-root", join(box.root, "repos")]).status, 0);
    assert.equal(install(box, ["uninstall", "--yes"]).status, 0);
    const left = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(left.myKey, "mine");
    assert.equal(left.githubUser, "old");
  });

  test("B2 a key added to your settings.json after install survives; the registered package is removed", () => {
    const box = fresh();
    mkdirSync(piPath(box), { recursive: true });
    writeFileSync(piPath(box, "settings.json"), '{"keep":true}');
    assert.equal(install(box, ARGS(box)).status, 0);
    const path = piPath(box, "settings.json");
    assert.ok(JSON.parse(readFileSync(path, "utf8")).packages.includes("./local-packages/pi-questions"));
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), myKey: "mine" }));
    assert.equal(install(box, ["uninstall", "--yes"]).status, 0);
    const left = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(left.myKey, "mine");
    assert.equal(left.keep, true);
    assert.ok(!(left.packages ?? []).includes("./local-packages/pi-questions"));
  });

  test("B3 a user-modified cli.js is kept by a rerun and survives uninstall", () => {
    const box = fresh();
    assert.equal(install(box, ARGS(box)).status, 0);
    const cli = piPath(box, "local-packages/pi-questions/dist/cli.js");
    mutate(cli);
    chmodSync(cli, 0o644);
    const mine = readFileSync(cli);
    const run = install(box, RERUN);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(readFileSync(cli).equals(mine));
    assert.equal(statSync(cli).mode & 0o111, 0, "a kept file is not chmodded");
    assert.equal(install(box, ["uninstall", "--yes"]).status, 0);
    assert.ok(readFileSync(cli).equals(mine), "uninstall kept the user's cli.js");
  });

  test("routing markers: a legacy AGENTS.md keeps its own marker lines and only the body is replaced", () => {
    const box = fresh();
    assert.equal(install(box, PROFILE_ARGS(box, "balanced")).status, 0);
    rmSync(piPath(box, ".pi-setup/manifest.json"));
    const path = piPath(box, "AGENTS.md");
    const text = readFileSync(path, "utf8");
    const startLine = /<!-- pi-profile:routing:start[^\n]*\n/.exec(text)![0];
    const custom = startLine.replace("-->", "(managed by someone else) -->");
    writeFileSync(path, text.replace(startLine, custom).replace("<!-- pi-profile:routing:end -->", "<!-- pi-profile:routing:end --> trailing"));
    assert.equal(install(box, PROFILE_ARGS(box, "openai-only")).status, 0);
    const after = readFileSync(path, "utf8");
    assert.ok(after.includes(custom), "start marker line unchanged");
    assert.ok(after.includes("<!-- pi-profile:routing:end --> trailing"), "end marker line unchanged");
    const routing = readFileSync(join(REPO, "agent/profiles/openai-only/routing.md"), "utf8");
    assert.ok(after.includes(custom + routing + "<!-- pi-profile:routing:end -->"), "body replaced");
  });

  test("routing markers missing: AGENTS.md is reconciled as a whole file, kept, and the summary says so", () => {
    const box = fresh();
    mkdirSync(piPath(box), { recursive: true });
    writeFileSync(piPath(box, "AGENTS.md"), "my own agents file, no markers\n");
    const run = install(box, PROFILE_ARGS(box, "balanced"));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(readFileSync(piPath(box, "AGENTS.md"), "utf8"), "my own agents file, no markers\n");
    assert.match(readFileSync(piPath(box, "AGENTS.md.pi-setup-new"), "utf8"), /pi-profile:routing:start/);
    assert.match(run.stdout, /AGENTS\.md has no pi-profile routing markers/);
    assert.deepEqual(backupDirs(box).filter(() => false), []);
  });

  test("ACTIVE holds exactly <name>\\n and switches with --profile", () => {
    const box = fresh();
    assert.equal(install(box, PROFILE_ARGS(box, "balanced")).status, 0);
    assert.equal(readFileSync(piPath(box, "profiles/ACTIVE")).toString("hex"), Buffer.from("balanced\n").toString("hex"));
    assert.equal(install(box, PROFILE_ARGS(box, "openai-only")).status, 0);
    assert.equal(readFileSync(piPath(box, "profiles/ACTIVE")).toString("hex"), Buffer.from("openai-only\n").toString("hex"));
  });
});
