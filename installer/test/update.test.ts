import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseArgs } from "../src/args.ts";
import type { Runner } from "../src/types.ts";
import { SetupError } from "../src/types.ts";
import { compareTags, latestTag, runUpdate } from "../src/update.ts";
import { snapshot, tempDir, testCtx } from "./helpers/home.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Rig {
  calls: { cmd: string; args: string[]; inherit?: boolean }[];
  lines: string[];
  home: string;
  repo: string;
  run: (flags?: string[], over?: { status?: string; tags?: string; gh?: "none" | "fail" | "ok"; lsRemote?: string }) => Promise<number | Error>;
}

function rig(git = true): Rig {
  const home = tempDir("pisetup-update-home");
  const repo = tempDir("pisetup-update-repo");
  dirs.push(home, repo);
  if (git) mkdirSync(join(repo, ".git"));
  const calls: Rig["calls"] = [];
  const lines: string[] = [];
  return {
    calls, lines, home, repo,
    async run(flags = [], over = {}) {
      const runner: Runner = async (cmd, args, o) => {
        calls.push({ cmd, args, inherit: o?.inherit });
        const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
        if (cmd === "gh") return over.gh === "fail" ? { code: 1, stdout: "", stderr: "x", timedOut: false } : ok("Release notes");
        const sub = args.slice(2).filter((a) => a !== "-c" && a !== "advice.detachedHead=false");
        if (sub[0] === "status") return ok(over.status ?? "");
        if (sub[0] === "tag") return ok(over.tags ?? "v2026.10.23.9\nv2026.10.23.10\nv2026.9.1\nnightly");
        if (sub[0] === "ls-remote") return ok(over.lsRemote ?? "aaa\trefs/tags/v1.0\nbbb\trefs/tags/v1.10\nccc\trefs/tags/v1.9");
        if (sub[0] === "describe") return ok("v1.0-3-gabc");
        return ok();
      };
      const parsed = parseArgs(["update", ...flags], home);
      assert.ok(parsed.ok, JSON.stringify(parsed));
      const ctx = testCtx(home, {
        repoDir: repo, run: runner, nodePath: "/node", which: (n) => (n === "gh" && over.gh !== "none" ? "/gh" : undefined),
      }, lines);
      try {
        return await runUpdate(ctx, parsed.options, undefined);
      } catch (e) {
        if (e instanceof SetupError) return e;
        throw e;
      }
    },
  };
}
const gitCalls = (r: Rig) => r.calls.filter((c) => c.cmd === "git").map((c) => c.args.slice(2).filter((a) => a !== "-c" && a !== "advice.detachedHead=false").join(" "));

test("tags compare by numeric segments", () => {
  assert.ok(compareTags("v2026.10.23.10", "v2026.10.23.9") > 0);
  assert.equal(latestTag(["v1.9", "v1.10", "nightly", "v1.2"]), "v1.10");
  assert.equal(latestTag(["nightly"]), undefined);
});

test("not a git checkout, or a dirty one: exit 1 and nothing fetched or checked out", async () => {
  const plain = rig(false);
  const e = await plain.run();
  assert.ok(e instanceof SetupError && /git checkout/.test(e.message));
  assert.deepEqual(plain.calls, []);
  const dirty = rig();
  const d = await dirty.run([], { status: " M installer/src/run.ts" });
  assert.ok(d instanceof SetupError && /local changes/.test(d.message));
  assert.deepEqual(gitCalls(dirty), ["status --porcelain"]);
});

test("the latest v* tag is checked out, then the new installer is re-run with --yes (non-interactive) and --skip-npm", async () => {
  const r = rig();
  assert.equal(await r.run(["--skip-npm"]), 0);
  const git = gitCalls(r);
  assert.ok(git.includes("fetch --tags --quiet origin"));
  assert.ok(git.includes("checkout --quiet --detach v2026.10.23.10"), git.join("\n"));
  const last = r.calls.at(-1)!;
  assert.deepEqual([last.cmd, last.args, last.inherit], ["/node", [join(r.repo, "installer/dist/pi-setup.mjs"), "install", "--yes", "--skip-npm"], true]);
  assert.ok(r.lines.some((l) => /detached at v2026\.10\.23\.10; `git switch main`/.test(l)));
  assert.ok(r.lines.includes("Release notes"));
});

test("--ref wins over the latest tag", async () => {
  const r = rig();
  assert.equal(await r.run(["--ref", "v2026.9.1"]), 0);
  assert.ok(gitCalls(r).includes("checkout --quiet --detach v2026.9.1"));
  const bad = parseArgs(["update", "--ref", "-x"], "/w");
  assert.ok(!bad.ok);
});

test("release notes are optional: gh missing or failing does not fail the update", async () => {
  for (const gh of ["none", "fail"] as const) {
    const r = rig();
    assert.equal(await r.run([], { gh }), 0, gh);
    assert.ok(!r.lines.includes("Release notes"));
  }
});

test("--dry-run asks only git ls-remote (plus read-only status and describe) and writes nothing", async () => {
  const r = rig();
  const before = snapshot(r.home, true);
  assert.equal(await r.run(["--dry-run"]), 0);
  const git = gitCalls(r);
  assert.deepEqual(git, ["status --porcelain", "ls-remote --tags --refs origin v*", "describe --tags --always"]);
  assert.ok(!r.calls.some((c) => c.cmd !== "git" && c.cmd !== "gh"), "no installer re-run");
  assert.ok(r.lines.some((l) => /would check out v1\.10 and run install/.test(l)));
  assert.deepEqual(snapshot(r.home, true), before);
});
