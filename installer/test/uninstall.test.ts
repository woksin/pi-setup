import { strict as assert } from "node:assert";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { emptyManifest, manifestPath, sha256 } from "../src/manifest.ts";
import type { FileEntry, JsonEntry, Manifest } from "../src/manifest.ts";
import { runUninstall } from "../src/uninstall.ts";
import { SetupError } from "../src/types.ts";
import { snapshot, testCtx, tempDir } from "./helpers/home.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const SRC = { release: null, commit: null };

function setup() {
  const home = tempDir("pisetup-uninstall");
  dirs.push(home);
  const pi = join(home, ".pi/agent");
  mkdirSync(join(pi, ".pi-setup/backups/20260101-000000"), { recursive: true });
  const m = emptyManifest(new Date());
  const put = (rel: string, text: string) => {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), text);
  };
  const file = (rel: string, text: string, extra: Partial<FileEntry> = {}) => {
    m.files[rel] = { sha256: sha256(text), mode: 420, source: SRC, origin: "new", ...extra };
  };
  const save = () => writeFileSync(manifestPath(pi), JSON.stringify(m));
  const run = async (...flags: string[]) => {
    const lines: string[] = [];
    const errs: string[] = [];
    const parsed = parseArgs(["uninstall", ...flags], home);
    assert.ok(parsed.ok);
    save();
    const code = await runUninstall(testCtx(home, {}, lines, errs), parsed.options, undefined).catch((e) => {
      if (e instanceof SetupError) return 1;
      throw e;
    });
    return { code, out: lines.join("\n"), errs: errs.join("\n") };
  };
  return { home, pi, m, put, file, run };
}
const A = ".pi/agent/a.md";

test("untouched files are removed; a file already gone is dropped; unlisted neighbours stay", async () => {
  const s = setup();
  s.put(A, "A");
  s.put(".pi/agent/neighbour.md", "N");
  s.file(A, "A");
  s.file(".pi/agent/gone.md", "G");
  const r = await s.run("--yes");
  assert.equal(r.code, 0, r.errs);
  assert.ok(!existsSync(join(s.home, A)));
  assert.equal(readFileSync(join(s.home, ".pi/agent/neighbour.md"), "utf8"), "N");
  assert.ok(!existsSync(manifestPath(s.pi)));
});

test("a replaced file gets its pre-install version back; with the backup missing it is left", async () => {
  const s = setup();
  s.put(A, "A");
  s.put(".pi/agent/b.md", "B");
  writeFileSync(join(s.pi, ".pi-setup/backups/20260101-000000/a.md"), "ORIGINAL");
  s.file(A, "A", { origin: "replaced", backup: "20260101-000000/a.md" });
  s.file(".pi/agent/b.md", "B", { origin: "replaced", backup: "20260101-000000/nope.md" });
  const r = await s.run("--yes");
  assert.equal(r.code, 0, r.errs);
  assert.equal(readFileSync(join(s.home, A), "utf8"), "ORIGINAL");
  assert.equal(readFileSync(join(s.home, ".pi/agent/b.md"), "utf8"), "B");
  assert.match(r.out, /left \(pre-install backup is missing\)/);
});

test("a changed file is left and listed with its pre-install version; the entry stays only with a backup", async () => {
  const s = setup();
  s.put(A, "edited");
  s.put(".pi/agent/b.md", "edited");
  writeFileSync(join(s.pi, ".pi-setup/backups/20260101-000000/a.md"), "ORIGINAL");
  s.file(A, "A", { origin: "replaced", backup: "20260101-000000/a.md" });
  s.file(".pi/agent/b.md", "B");
  const r = await s.run("--yes");
  assert.equal(r.code, 0, r.errs);
  assert.match(r.out, new RegExp(`left \\(changed by you\\): ${join(s.home, A)}; your pre-install version: `));
  assert.match(r.out, new RegExp(`left \\(changed by you\\): ${join(s.home, ".pi/agent/b.md")}$`, "m"));
  const left = JSON.parse(readFileSync(manifestPath(s.pi), "utf8")) as Manifest;
  assert.deepEqual(Object.keys(left.files), [A]);
  assert.ok(existsSync(join(s.pi, ".pi-setup/backups/20260101-000000/a.md")));
});

test(".pi-setup-new is removed only when it still holds what pi-setup wrote", async () => {
  const s = setup();
  s.put(A, "A");
  s.put(`${A}.pi-setup-new`, "N");
  s.put(".pi/agent/b.md", "B");
  s.put(".pi/agent/b.md.pi-setup-new", "user edited this");
  s.file(A, "A", { pending: { path: `${A}.pi-setup-new`, sha256: sha256("N") } });
  s.file(".pi/agent/b.md", "B", { pending: { path: ".pi/agent/b.md.pi-setup-new", sha256: sha256("N") } });
  assert.equal((await s.run("--yes")).code, 0);
  assert.ok(!existsSync(join(s.home, `${A}.pi-setup-new`)));
  assert.ok(existsSync(join(s.home, ".pi/agent/b.md.pi-setup-new")));
});

test("symlinks are removed only while they still point where pi-setup put them", async () => {
  const s = setup();
  mkdirSync(join(s.home, ".agents/skills/x"), { recursive: true });
  mkdirSync(join(s.pi, "skills"), { recursive: true });
  symlinkSync(join(s.home, ".agents/skills/x"), join(s.pi, "skills/ok"));
  symlinkSync("/tmp", join(s.pi, "skills/moved"));
  s.m.symlinks[".pi/agent/skills/ok"] = { target: ".agents/skills/x" };
  s.m.symlinks[".pi/agent/skills/moved"] = { target: ".agents/skills/x" };
  assert.equal((await s.run("--yes")).code, 0);
  assert.throws(() => lstatSync(join(s.pi, "skills/ok")));
  assert.ok(lstatSync(join(s.pi, "skills/moved")).isSymbolicLink());
  assert.ok(existsSync(join(s.home, ".agents/skills/x")));
});

const json = (extra: Partial<JsonEntry>): JsonEntry => ({ created: false, sha256After: "", ops: [], ...extra });

test("JSON: a file still as written is restored byte-exact from its backup; a created one is deleted", async () => {
  const s = setup();
  s.put(".pi/agent/user.json", '{"githubUser":"b"}\n');
  s.put(".pi/agent/new.json", "{}\n");
  writeFileSync(join(s.pi, ".pi-setup/backups/20260101-000000/user.json"), '{"githubUser":"a"}');
  s.m.json[".pi/agent/user.json"] = json({ backup: "20260101-000000/user.json", sha256After: sha256('{"githubUser":"b"}\n') });
  s.m.json[".pi/agent/new.json"] = json({ created: true, sha256After: sha256("{}\n") });
  assert.equal((await s.run("--yes")).code, 0);
  assert.equal(readFileSync(join(s.pi, "user.json"), "utf8"), '{"githubUser":"a"}');
  assert.ok(!existsSync(join(s.pi, "new.json")));
});

test("JSON: an edited file is reverted key by key, leaving the user's other changes", async () => {
  const s = setup();
  const edited = { githubUser: "mine-now", reposRoot: "/new", extra: 1, packages: ["a", "./local-packages/pi-questions"], other: true };
  s.put(".pi/agent/settings.json", JSON.stringify(edited));
  s.m.json[".pi/agent/settings.json"] = json({
    sha256After: "stale",
    ops: [
      { op: "set", key: "githubUser", before: { present: true, value: "old" }, after: "einari" },
      { op: "set", key: "reposRoot", before: { present: false }, after: "/new" },
      { op: "array-add", key: "packages", value: "./local-packages/pi-questions", keyCreated: false },
    ],
  });
  const r = await s.run("--yes");
  assert.equal(r.code, 0, r.errs);
  assert.deepEqual(JSON.parse(readFileSync(join(s.pi, "settings.json"), "utf8")),
    { githubUser: "mine-now", extra: 1, packages: ["a"], other: true });
  const left = JSON.parse(readFileSync(manifestPath(s.pi), "utf8")) as Manifest;
  assert.equal(left.json[".pi/agent/settings.json"].ops.length, 1, "the changed githubUser stays recorded");
  assert.match(r.errs, /left \(changed by you\): githubUser/);
});

test("JSON: a created file that reverts to {} is deleted; a created packages key goes with its last entry", async () => {
  const s = setup();
  s.put(".pi/agent/settings.json", '{"packages":["p"],"x":1}');
  s.put(".pi/agent/u.json", '{"githubUser":"b"}');
  s.m.json[".pi/agent/settings.json"] = json({ sha256After: "stale", ops: [{ op: "array-add", key: "packages", value: "p", keyCreated: true }] });
  s.m.json[".pi/agent/u.json"] = json({
    created: true, sha256After: "stale", ops: [{ op: "set", key: "githubUser", before: { present: false }, after: "b" }],
  });
  assert.equal((await s.run("--yes")).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(s.pi, "settings.json"), "utf8")), { x: 1 });
  assert.ok(!existsSync(join(s.pi, "u.json")));
});

test("only empty directories from the manifest are removed, deepest first", async () => {
  const s = setup();
  mkdirSync(join(s.home, ".pi/agent/d1/d2"), { recursive: true });
  mkdirSync(join(s.home, ".pi/agent/full"), { recursive: true });
  writeFileSync(join(s.home, ".pi/agent/full/mine.txt"), "mine");
  mkdirSync(join(s.home, ".pi/agent/unlisted"), { recursive: true });
  s.m.dirs.push(".pi/agent/d1", ".pi/agent/d1/d2", ".pi/agent/full");
  assert.equal((await s.run("--yes")).code, 0);
  assert.ok(!existsSync(join(s.home, ".pi/agent/d1")));
  assert.ok(existsSync(join(s.home, ".pi/agent/full/mine.txt")));
  assert.ok(existsSync(join(s.home, ".pi/agent/unlisted")));
});

test("dry-run and a missing --yes change nothing; an invalid path refuses the whole run before any write", async () => {
  const s = setup();
  s.put(A, "A");
  s.file(A, "A");
  const dry = await s.run("--dry-run");
  const before = snapshot(s.home);
  assert.equal(dry.code, 0);
  assert.match(dry.out, new RegExp(`remove ${join(s.home, A)}`));
  assert.ok(existsSync(join(s.home, A)));
  const refused = await s.run();
  assert.equal(refused.code, 1);
  assert.deepEqual(snapshot(s.home), before);
  s.file("../outside", "x");
  const bad = await s.run("--yes");
  assert.equal(bad.code, 1);
  assert.ok(existsSync(join(s.home, A)), "nothing was removed before the refusal");
});

test("a backup run folder that is not pinned stays and its path is printed", async () => {
  const s = setup();
  s.put(A, "A");
  s.file(A, "A");
  writeFileSync(join(s.pi, ".pi-setup/backups/20260101-000000/leftover.md"), "mine once");
  const r = await s.run("--yes");
  assert.equal(r.code, 0);
  assert.match(r.out, /Left in place .*backups prune --keep 0/);
  assert.ok(existsSync(join(s.pi, ".pi-setup/backups/20260101-000000/leftover.md")));
});


test("full uninstall removes the doctor update cache before tidying", async () => {
  const s = setup();
  s.put(".pi/agent/.pi-setup/update-check.json", '{"latest":"v1"}');
  assert.equal((await s.run("--yes")).code, 0);
  assert.equal(existsSync(join(s.pi, ".pi-setup")), false);
});
