import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, realpathSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { REPO, install, piPath, sandbox } from "./helpers/home.ts";
import type { Sandbox } from "./helpers/home.ts";

const boxes: Sandbox[] = [];
after(() => {
  for (const box of boxes) rmSync(box.root, { recursive: true, force: true });
});

/** A clone of this repo at <root>/x/org/pi-setup running the freshly built bundle. */
function orgCheckout(box: Sandbox): { x: string; repo: string } {
  const x = join(realpathSync(box.root), "x");
  const repo = join(x, "org", "pi-setup");
  mkdirSync(join(x, "org"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", REPO, repo], { stdio: "ignore" });
  // Outweigh whatever /Volumes/*/repos the machine running the tests happens to have.
  for (let i = 0; i < 400; i++) mkdirSync(join(x, "org", `r${i}`, ".git"), { recursive: true });
  copyFileSync(join(REPO, "installer/dist/pi-setup.mjs"), join(repo, "installer/dist/pi-setup.mjs"));
  return { x, repo };
}

test("an unattended first install keeps ~/repos and only hints at the detected root", () => {
  const box = sandbox();
  boxes.push(box);
  const { x, repo } = orgCheckout(box);
  const run = install(box, ["--yes", "--user", "einari"], { entry: "node", repo });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const saved = JSON.parse(readFileSync(piPath(box, "user.json"), "utf8"));
  assert.equal(saved.reposRoot, join(box.home, "repos"));
  assert.ok(run.stdout.includes(`pi-setup: repos root defaulted to ~/repos; detected ${x}; pass --repos-root ${x} to use it`), run.stdout);
});

test("a symlinked user.json stays a link and the target is updated", () => {
  const box = sandbox();
  boxes.push(box);
  mkdirSync(piPath(box), { recursive: true });
  const target = join(box.root, "dotfiles-user.json");
  writeFileSync(target, '{"githubUser":"old","extra":1}');
  symlinkSync(target, piPath(box, "user.json"));
  const run = install(box, ["--yes", "--user", "einari", "--repos-root", join(box.root, "repos")]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(lstatSync(piPath(box, "user.json")).isSymbolicLink());
  assert.equal(readlinkSync(piPath(box, "user.json")), target);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { githubUser: "einari", extra: 1, reposRoot: join(box.root, "repos") });
});

test("dry-run without an active profile labels the profile as provisional", () => {
  const box = sandbox();
  boxes.push(box);
  const run = install(box, ["--yes", "--dry-run", "--user", "einari", "--repos-root", join(box.root, "repos")]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Profile: balanced \(provisional: the real install picks by logged-in providers\)/);
});
