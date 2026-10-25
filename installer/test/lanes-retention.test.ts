import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tempDir, REPO } from "./helpers/home.ts";
import { defaults, archiveDir, saveConfig, UsageError, validate } from "../src/lanes/config.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { FileBackend } from "../src/lanes/backend.ts";
import { backendOwnedName } from "../src/lanes/backend-files.ts";
import { main } from "../src/lanes/main.ts";
import { prune } from "../src/lanes/retention.ts";

const DAY = 86400000;
const NOW = new Date("2026-02-01T12:00:00Z");
function fixture() {
  const root = tempDir("lanes-retention"); const out: string[] = []; const err: string[] = [];
  const c = defaults(root, root); c.terminal.backend = "print";
  c.lanes.push({ id: "L1", repo: "example/repo", group: null, worktree: "l1", branch: "l1", prompt: "prompts/L1.md" });
  const ctx: LanesCtx = { home: root, cwd: root, env: {}, platform: "linux", now: () => NOW,
    run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }), which: () => "/stub/pi-session",
    out: (s) => out.push(s), err: (s) => err.push(s), stdinTTY: true, readStdin: async () => "",
    templatesDir: join(REPO, "installer/lanes/templates"), piAgentDir: join(root, "agent"), loadModule: async () => ({}), realpath: (p) => p };
  const dir = join(root, "messages"); mkdirSync(dir);
  const put = (name = "L0-to-L1-old-1200.md", age = 15, folder = dir) => {
    mkdirSync(folder, { recursive: true }); const path = join(folder, name); writeFileSync(path, "original");
    const at = new Date(NOW.getTime() - age * DAY); utimesSync(path, at, at); return path;
  };
  return { root, dir, c, ctx, out, err, put, r: c.messages.retention! };
}
const empty = { archived: 0, deleted: 0, skippedUnread: 0, skippedCollision: 0, kept: 0, archiveExpired: 0 };

for (const mode of ["keep", "archive", "delete"] as const) test(`retention mode ${mode} and exact age boundary`, () => {
  const f = fixture(); f.r.mode = mode;
  const old = f.put(); const boundary = f.put("L0-to-L1-boundary-1200.md", 14);
  const young = f.put("L0-to-L1-young-1200.md", 1);
  assert.deepEqual(prune(f.c, f.root, f.ctx), { ...empty, kept: mode === "keep" ? 3 : 2, archived: mode === "archive" ? 1 : 0, deleted: mode === "delete" ? 1 : 0 });
  assert.equal(existsSync(old), mode === "keep"); assert.ok(existsSync(boundary)); assert.ok(existsSync(young));
  assert.equal(existsSync(join(f.dir, "archive", "L0-to-L1-old-1200.md")), mode === "archive");
});

test("new retention defaults and absent retention keeps files", () => {
  const f = fixture();
  assert.deepEqual(f.r, { mode: "archive", maxAgeDays: 14, archiveDir: "archive", archiveMaxAgeDays: null, keepUnread: true, auto: true });
  delete f.c.messages.retention; assert.doesNotThrow(() => validate(f.c)); const path = f.put();
  assert.deepEqual(prune(f.c, f.root, f.ctx), { ...empty, kept: 1 }); assert.ok(existsSync(path));
});

test("retention validation names each malformed key and defaults archiveDir", () => {
  const f = fixture();
  for (const value of [null, [], "archive"]) assert.throws(() => validate({ ...f.c, messages: { ...f.c.messages, retention: value } }), (e) => e instanceof UsageError && /messages.retention/.test(e.message));
  const bad = { mode: ["bad", null], maxAgeDays: [0, -1, 1.5, "14", undefined], archiveDir: ["", null, 1, ".", "archive/..", "${unknown}"], archiveMaxAgeDays: [0, -1, 1.5, "14", undefined], keepUnread: [null, 1, undefined], auto: ["true", null, undefined] };
  for (const [key, values] of Object.entries(bad)) for (const value of values) {
    assert.throws(() => validate({ ...f.c, messages: { ...f.c.messages, retention: { ...f.r, [key]: value } } }, f.root, f.root), (e) => e instanceof UsageError && e.message.includes(`messages.retention.${key}`));
  }
  delete f.r.archiveDir; assert.doesNotThrow(() => validate(f.c)); assert.equal(archiveDir(f.c, f.root, f.root), join(f.dir, "archive"));
  for (const path of [f.dir, "${root}/messages"]) { f.r.archiveDir = path; assert.throws(() => validate(f.c, f.root, f.root), /messages.retention.archiveDir/); }
  f.r.archiveDir = "~/messages/saved"; assert.equal(archiveDir(f.c, f.root, f.root), join(f.dir, "saved"));
  f.r.archiveDir = "${root}/messages/saved"; assert.equal(archiveDir(f.c, f.root, f.root), join(f.dir, "saved"));
});

for (const mode of ["archive", "delete"] as const) test(`${mode} protects unread addressed lanes, not read or missing markers`, () => {
  const f = fixture(); f.r.mode = mode;
  f.put("L1-inbox.marker", 20); f.put("L0-inbox.marker", 1);
  f.put(); f.put("L1-to-L0-read-1200.md"); f.put("L0-to-L2-missing-1200.md"); f.put("L0-to-L0-L1-multi-1200.md");
  f.put("L0-to-ALL-broadcast-1200.md"); f.c.messages.broadcast = "TEAM"; f.put("L0-to-TEAM-custom-1200.md");
  const counts = prune(f.c, f.root, f.ctx); assert.equal(counts.skippedUnread, 4); assert.equal(counts[mode === "archive" ? "archived" : "deleted"], 2);
  f.r.keepUnread = false; assert.equal(prune(f.c, f.root, f.ctx).skippedUnread, 0);
});

for (const mode of ["archive", "delete"] as const) {
  for (const [state, age] of [["unread", 20], ["read", 1]] as const) test(`${mode} protects ${state} group messages using the lane marker`, () => {
    const f = fixture(); f.r.mode = mode; f.c.lanes[0].group = "G1";
    const path = f.put("L0-to-G1-group-1200.md"); f.put("L1-inbox.marker", age);
    const counts = prune(f.c, f.root, f.ctx);
    assert.equal(counts.skippedUnread, state === "unread" ? 1 : 0);
    assert.equal(counts[mode === "archive" ? "archived" : "deleted"], state === "read" ? 1 : 0);
    assert.equal(existsSync(path), state === "unread");
  });
}

test("missing markers do not protect configured recipients; equal marker is read", () => {
  const f = fixture(); f.put(); f.put("L1-to-L0-other-1200.md");
  f.put("L1-inbox.marker", 15);
  assert.equal(prune(f.c, f.root, f.ctx).archived, 2);
});

test("archive collision never overwrites a file or dangling symlink", () => {
  const f = fixture(); const source = f.put(); const name = "L0-to-L1-old-1200.md";
  f.put(name, 3, join(f.dir, "archive")); writeFileSync(join(f.dir, "archive", name), "existing");
  const second = f.put("L0-to-L1-link-1200.md"); symlinkSync(join(f.root, "missing"), join(f.dir, "archive", "L0-to-L1-link-1200.md"));
  assert.equal(prune(f.c, f.root, f.ctx).skippedCollision, 2);
  assert.ok(existsSync(source)); assert.ok(existsSync(second)); assert.equal(readFileSync(join(f.dir, "archive", name), "utf8"), "existing");
});

test("dry-run and JSON report counts without changing files, directories or mtimes", async () => {
  const f = fixture(); f.put(); saveConfig(f.root, f.c);
  const before = statSync(f.dir).mtimeMs;
  assert.equal(await main(["messages", "prune", "--dry-run", "--json"], f.ctx), 0);
  assert.deepEqual(JSON.parse(f.out.pop()!), { ...empty, archived: 1 });
  assert.equal(statSync(f.dir).mtimeMs, before); assert.deepEqual(readdirSync(f.dir), ["L0-to-L1-old-1200.md"]);
  assert.equal(await main(["messages", "prune"], f.ctx), 0); assert.match(f.out.pop()!, /archived: 1.*skipped \(unread\): 0.*archive-expired: 0/);
  for (const args of [["messages"], ["messages", "other"], ["messages", "prune", "--json=false"], ["status", "--json"]]) assert.equal(await main(args, f.ctx), 2);
});

test("legacy prune defaults to dry-run and apply archives only old non-bus regular markdown", async () => {
  const f = fixture(); f.r.mode = "delete";
  const old = f.put("old-note.md", 2); const bus = f.put(); const recent = f.put("recent.md", 0.5);
  const boundary = f.put("boundary.md", 1); const dotfile = f.put(".secret.md", 2);
  mkdirSync(join(f.dir, "directory")); symlinkSync(old, join(f.dir, "link.md")); saveConfig(f.root, f.c);
  const before = statSync(f.dir).mtimeMs;
  assert.equal(await main(["messages", "prune", "--legacy"], f.ctx), 0);
  assert.ok(f.out.includes("would archive: old-note.md")); assert.equal(statSync(f.dir).mtimeMs, before);
  assert.ok(existsSync(old)); assert.ok(!existsSync(join(f.dir, "archive")));
  assert.equal(await main(["messages", "prune", "--legacy", "--apply", "--json"], f.ctx), 0);
  assert.deepEqual(JSON.parse(f.out.at(-1)!), { dryRun: false, archived: ["old-note.md"], skippedCollision: [] });
  assert.ok(!existsSync(old)); assert.equal(readFileSync(join(f.dir, "archive/old-note.md"), "utf8"), "original");
  for (const path of [bus, recent, boundary, dotfile, join(f.dir, "directory")]) assert.ok(existsSync(path));
  assert.equal(await main(["messages", "prune", "--legacy", "--apply", "--json"], f.ctx), 0);
  assert.deepEqual(JSON.parse(f.out.at(-1)!).archived, []);
});
test("legacy prune never moves backend state or non-markdown files", async () => {
  const f = fixture(); const old = f.put("hand-written.md", 2);
  const stateNames = ["L1-inbox.marker", "status/L1.status", "status/.L1-test.tmp", "archive/already-archived.md"];
  const protectedFiles = stateNames.map(name => f.put(name.split("/").at(-1)!, 15, join(f.dir, ...name.split("/").slice(0, -1))));
  protectedFiles.push(f.put("unrelated.txt", 15));
  for (const name of stateNames) assert.equal(backendOwnedName(name), true, name);
  assert.equal(backendOwnedName("L0-to-L1-old-1200.md"), true);
  assert.equal(backendOwnedName("hand-written.md"), false);
  const before = protectedFiles.map(path => ({ text: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs }));
  saveConfig(f.root, f.c);
  assert.equal(await main(["messages", "prune", "--legacy", "--apply", "--json"], f.ctx), 0);
  assert.deepEqual(JSON.parse(f.out.at(-1)!).archived, ["hand-written.md"]);
  assert.ok(!existsSync(old)); assert.ok(existsSync(join(f.dir, "archive/hand-written.md")));
  assert.deepEqual(protectedFiles.map(path => ({ text: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs })), before);
});
test("legacy age, collision handling and no-retention fallback preserve originals", async () => {
  const f = fixture(); const source = f.put("old.md", 3); f.put("younger.md", 1.5);
  const archived = f.put("old.md", 5, join(f.dir, "archive")); saveConfig(f.root, f.c);
  assert.equal(await main(["messages", "prune", "--legacy", "--legacy-age", "48", "--apply", "--json"], f.ctx), 0);
  assert.deepEqual(JSON.parse(f.out.at(-1)!), { dryRun: false, archived: [], skippedCollision: ["old.md"] });
  assert.ok(existsSync(source)); assert.equal(readFileSync(archived, "utf8"), "original");
  for (const age of ["0", "23", "NaN"]) assert.equal(await main(["messages", "prune", "--legacy", "--legacy-age", age], f.ctx), 2);
  delete f.c.messages.retention; saveConfig(f.root, f.c);
  assert.equal(await main(["messages", "prune", "--legacy", "--apply"], f.ctx), 0);
  assert.ok(existsSync(join(f.dir, "archive/legacy/old.md")));
});
test("archive expiry runs in keep mode, respects boundary and dry-run, and ignores non-messages", () => {
  const f = fixture(); f.r.mode = "keep"; f.r.archiveMaxAgeDays = 30;
  const archive = join(f.dir, "archive"); const old = f.put("L0-to-L1-expired-1200.md", 31, archive);
  const boundary = f.put("L0-to-L1-boundary-1200.md", 30, archive); f.put("notes.md", 100, archive); f.put();
  assert.equal(prune(f.c, f.root, f.ctx, true).archiveExpired, 1); assert.ok(existsSync(old));
  assert.deepEqual(prune(f.c, f.root, f.ctx), { ...empty, kept: 1, archiveExpired: 1 });
  assert.ok(!existsSync(old)); assert.ok(existsSync(boundary)); assert.ok(existsSync(join(archive, "notes.md")));
  f.r.archiveMaxAgeDays = null; assert.equal(prune(f.c, f.root, f.ctx).archiveExpired, 0);
});

test("only top-level regular messages are touched; archive is absent from list, inbox and unread", async () => {
  const f = fixture(); f.put(); f.put("L1-inbox.marker", 1); f.put("notes.md"); f.put("L0-to-L1-old-1200.md.tmp"); f.put(".L0-to-L1-hidden-1200.md");
  const sub = join(f.dir, "L0-to-L1-directory-1200.md"); mkdirSync(sub); f.put("L0-to-L1-nested-1200.md", 40, sub);
  f.put("L0.status", 40, join(f.dir, "status"));
  const external = f.put("external.md", 40, f.root); symlinkSync(external, join(f.dir, "L0-to-L1-link-1200.md"));
  assert.equal(prune(f.c, f.root, f.ctx).archived, 1);
  for (const name of ["notes.md", "L1-inbox.marker", "L0-to-L1-old-1200.md.tmp", ".L0-to-L1-hidden-1200.md", "L0-to-L1-link-1200.md"]) assert.ok(existsSync(join(f.dir, name)));
  assert.equal(readFileSync(external, "utf8"), "original"); assert.ok(existsSync(join(sub, "L0-to-L1-nested-1200.md"))); assert.ok(existsSync(join(f.dir, "status/L0.status")));
  const clean = fixture(); clean.put(); clean.put("L1-inbox.marker", 1); prune(clean.c, clean.root, clean.ctx);
  const backend = new FileBackend(clean.dir, clean.ctx.now);
  assert.deepEqual(await backend.list(), []); assert.deepEqual(await backend.inbox("L1"), []); assert.deepEqual(await backend.unread("L1"), []);
});

test("absolute archive paths work and symlink archives are refused", () => {
  const f = fixture(); f.r.archiveDir = join(f.dir, "saved"); f.put(); assert.equal(prune(f.c, f.root, f.ctx).archived, 1);
  const g = fixture(); g.put(); symlinkSync(g.dir, join(g.dir, "archive")); assert.throws(() => prune(g.c, g.root, g.ctx), /archiveDir/);
});

test("archiveDir rejects traversal, outside paths, messages itself and status descendants", () => {
  const f = fixture(); const source = f.put();
  for (const path of ["..", "../saved", "archive/../saved", f.root, join(f.root, "messages-other"), f.dir, ".", "status", "status/archive", join(f.dir, "status/archive")]) {
    f.r.archiveDir = path;
    const invalid = (e: unknown) => e instanceof UsageError && e.message.includes("messages.retention.archiveDir");
    assert.throws(() => validate(f.c, f.root, f.root), invalid);
    assert.throws(() => prune(f.c, f.root, f.ctx), invalid);
    assert.ok(existsSync(source));
  }
  for (const path of ["saved/nested", "status-archive", join(f.dir, "saved")]) {
    f.r.archiveDir = path; assert.doesNotThrow(() => validate(f.c, f.root, f.root));
  }
});

test("archiveDir resolves symlink ancestors before accepting a descendant", () => {
  const f = fixture(); mkdirSync(join(f.dir, "status"));
  symlinkSync(f.root, join(f.dir, "outside")); symlinkSync(join(f.dir, "status"), join(f.dir, "alias"));
  for (const path of ["outside/saved", "alias/saved"]) {
    f.r.archiveDir = path;
    assert.throws(() => validate(f.c, f.root, f.root), /messages.retention.archiveDir/);
    assert.throws(() => prune(f.c, f.root, f.ctx), /messages.retention.archiveDir/);
  }
});

test("failed rename removes the reserved placeholder and preserves the source", (t) => {
  const f = fixture(); const source = f.put();
  const mocked = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("rename denied"), { code: "EACCES" }); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => prune(f.c, f.root, f.ctx), /rename denied/);
    assert.deepEqual(readdirSync(join(f.dir, "archive")), []);
    assert.equal(readFileSync(source, "utf8"), "original");
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(prune(f.c, f.root, f.ctx).archived, 1);
});

test("EXDEV copies then unlinks, preserving message mtime", (t) => {
  const f = fixture(); const source = f.put(); const original = statSync(source).mtimeMs;
  const mocked = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("cross device"), { code: "EXDEV" }); });
  syncBuiltinESMExports();
  try {
    assert.equal(prune(f.c, f.root, f.ctx).archived, 1); assert.ok(!existsSync(source));
    const target = join(f.dir, "archive", "L0-to-L1-old-1200.md"); assert.equal(readFileSync(target, "utf8"), "original"); assert.equal(statSync(target).mtimeMs, original);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("start automatically prunes, can opt out, and warns once without blocking on prune failure", async () => {
  const f = fixture(); mkdirSync(join(f.root, "prompts")); writeFileSync(join(f.root, "prompts/coordinator.md"), "prompt");
  f.put(); saveConfig(f.root, f.c); assert.equal(await main(["start", "coordinator"], f.ctx), 0); assert.ok(existsSync(join(f.dir, "archive", "L0-to-L1-old-1200.md")));
  f.r.auto = false; const path = f.put("L0-to-L1-disabled-1200.md"); saveConfig(f.root, f.c);
  assert.equal(await main(["start", "coordinator"], f.ctx), 0); assert.ok(existsSync(path));
  f.r.auto = true; f.r.archiveDir = "blocked"; writeFileSync(join(f.dir, "blocked"), "not a directory"); saveConfig(f.root, f.c);
  assert.equal(await main(["start", "coordinator"], f.ctx), 0);
  assert.equal(f.err.length, 1); assert.match(f.err[0], /^warning: message prune failed: /); assert.ok(!f.err[0].includes("\n")); assert.ok(existsSync(path)); assert.match(f.out.at(-1)!, /^cd /);
});
