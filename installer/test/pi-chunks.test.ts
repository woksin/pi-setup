import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { logPath } from "../src/install-log.ts";
import { PI_PACKAGE } from "../src/prereqs.ts";
import { ensurePrereqs } from "../src/prereqs-run.ts";
import { SetupError } from "../src/types.ts";
import type { RunResult } from "../src/types.ts";
import { sandbox, testCtx } from "./helpers/home.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15);
const OK = { code: 0, stdout: "", stderr: "", timedOut: false };
const chunkPath = (pkg: string) => join(pkg, "dist/bundle/chunks");
const modules = (prefix: string) => join(prefix, "lib/node_modules");

function setup(userPrefix = false) {
  const { home } = sandbox();
  const defaultPrefix = join(home, "npm-global");
  const prefix = userPrefix ? join(home, ".local") : defaultPrefix;
  const pkg = join(modules(prefix), PI_PACKAGE);
  const chunks = chunkPath(pkg);
  const err: string[] = [];
  const parsed = parseArgs(["--install-prereqs"], home);
  assert.ok(parsed.ok);
  let install: () => RunResult | void;
  let now = NOW;
  const ctx = testCtx(home, {
    env: { PATH: join(prefix, "bin") },
    now: () => new Date(now),
    which: (tool) => tool === "pi" || tool === "npm" ? join(prefix, "bin", tool) : undefined,
    run: async (cmd, args) => {
      if (cmd === "pi" && args[0] === "--version") return { ...OK, stdout: "0.1.0\n" };
      if (cmd === "npm" && args[0] === "prefix") return { ...OK, stdout: `${defaultPrefix}\n` };
      if (cmd === "npm" && args[0] === "root") {
        const explicit = args.indexOf("--prefix");
        return { ...OK, stdout: `${modules(explicit < 0 ? defaultPrefix : args[explicit + 1])}\n` };
      }
      if (cmd === "npm" && args[0] === "install") return install() ?? OK;
      assert.fail(`unexpected command: ${cmd} ${args.join(" ")}`);
    },
  }, [], err);
  return {
    chunks, ctx, err, pkg, prefix,
    replace: () => { rmSync(pkg, { recursive: true, force: true }); mkdirSync(chunks, { recursive: true }); },
    upgrade: (doInstall: typeof install, at = NOW) => {
      install = doInstall;
      now = at;
      return ensurePrereqs(ctx, parsed.options, undefined, { tools: [], pi: true, fresh: false });
    },
  };
}

function writeChunk(dir: string, name: string, body: string, age = 0): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, body);
  const time = new Date(NOW - age * DAY);
  utimesSync(file, time, time);
}

for (const userPrefix of [false, true]) {
  test(`pi upgrade preserves missing, recent chunks in the ${userPrefix ? "user" : "default"} npm prefix`, async () => {
    const f = setup(userPrefix);
    const old = "openai-codex-responses-old.js";
    writeChunk(f.chunks, old, "old provider", 29);
    writeChunk(f.chunks, "shared.js", "old shared");
    writeChunk(f.chunks, "expired.js", "expired chunk", 31);
    writeChunk(f.chunks, "shared-expired.js", "old even if shared", 31);
    writeChunk(f.chunks, "metadata.json", "not a chunk");
    symlinkSync(join(f.chunks, old), join(f.chunks, "linked.js"));

    const result = await f.upgrade(() => {
      f.replace();
      writeChunk(f.chunks, "openai-codex-responses-new.js", "new provider");
      writeChunk(f.chunks, "shared.js", "new shared");
      writeChunk(f.chunks, "shared-expired.js", "new even if old mtime", 31);
    });
    assert.equal(result.ran, 1);
    assert.deepEqual(f.err, []);
    const read = (name: string) => readFileSync(join(f.chunks, name), "utf8");
    assert.equal(read(old), "old provider");
    assert.equal(statSync(join(f.chunks, old)).mtimeMs, NOW - 29 * DAY);
    assert.equal(read("openai-codex-responses-new.js"), "new provider");
    assert.equal(read("shared.js"), "new shared");
    assert.equal(read("shared-expired.js"), "new even if old mtime");
    for (const missing of ["expired.js", "metadata.json", "linked.js"]) {
      assert.ok(!existsSync(join(f.chunks, missing)));
    }
    assert.match(readFileSync(logPath(f.ctx), "utf8"), /\[pi-chunks preserved=1\]/);

    await f.upgrade(f.replace, NOW + 2 * DAY);
    assert.ok(!existsSync(join(f.chunks, old)));
    assert.equal(read("openai-codex-responses-new.js"), "new provider");
  });
}

test("pi upgrade does not snapshot a package linked outside the npm prefix, and still installs", async () => {
  const f = setup();
  const external = `${f.prefix}-sibling/pi-package`;
  writeChunk(chunkPath(external), "foreign.js", "foreign package");
  mkdirSync(dirname(f.pkg), { recursive: true });
  symlinkSync(external, f.pkg, "dir");

  assert.equal((await f.upgrade(f.replace)).ran, 1);
  assert.equal(f.err.length, 1);
  assert.ok(!existsSync(join(f.chunks, "foreign.js")));
  assert.equal(readFileSync(join(chunkPath(external), "foreign.js"), "utf8"), "foreign package");
});

test("pi upgrade warns and does not restore through a replacement chunks link outside the package", async () => {
  const f = setup();
  writeChunk(f.chunks, "old.js", "old chunk");
  const foreign = join(f.prefix, "elsewhere");
  mkdirSync(foreign);

  const result = await f.upgrade(() => {
    f.replace();
    rmSync(f.chunks, { recursive: true });
    symlinkSync(foreign, f.chunks, "dir");
  });
  assert.equal(result.ran, 1);
  assert.equal(f.err.length, 1);
  assert.ok(!existsSync(join(foreign, "old.js")));
});

for (const failure of [{ code: 1, timedOut: false }, { code: 0, timedOut: true }]) {
  test(`pi upgrade does not restore old chunks on ${failure.timedOut ? "timeout" : "npm failure"}`, async () => {
    const f = setup();
    writeChunk(f.chunks, "old.js", "old chunk");
    await assert.rejects(f.upgrade(() => { f.replace(); return { ...OK, ...failure }; }), SetupError);
    assert.ok(!existsSync(join(f.chunks, "old.js")));
  });
}
