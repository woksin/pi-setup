import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/run.ts";
import { compactChecks } from "../src/doctor-compact.ts";
import type { DoctorCheck } from "../src/doctor.ts";
import { PATH_EDIT_DEFAULT } from "../src/shell-path.ts";
import { sandbox } from "./helpers/home.ts";
import type { Sandbox } from "./helpers/home.ts";
import { railsCtxFor as ctxFor, scripted } from "./helpers/prompter.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => rmSync(b.root, { recursive: true, force: true })));
function box() { const b = sandbox(); boxes.push(b); return b; }
const flags = (b: Sandbox) => ["--skip-npm", "--no-launchd", "--repos-root", join(b.root, "repos")];
const rc = (b: Sandbox) => join(b.home, ".zshrc");
const SNIPPET = 'export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"';

function zsh(b: Sandbox, onPath = false) {
  const ctx = ctxFor(b);
  ctx.env.SHELL = "/bin/zsh";
  if (onPath) ctx.env.PATH = [join(b.home, ".local/bin"), join(b.home, ".pi/agent/bin")].join(":");
  return ctx;
}

function recording(s: ReturnType<typeof scripted>) {
  const phases: string[] = [];
  s.p.spinner = () => ({ start: (m) => { if (m !== "Looking around…") phases.push(m); }, stop: () => {}, message: (m) => phases.push(m) });
  return phases;
}

const check = (id: string, status: DoctorCheck["status"], detail: string, items?: string[]): DoctorCheck => ({ id, title: id, status, detail, items });

test("apply reports its phases in order: back up, write files, npm, PATH", async () => {
  const b = box(); const s = scripted(); const phases = recording(s);
  const ctx = zsh(b); const run = ctx.run;
  ctx.run = async (cmd, args, o) => cmd === "npm" ? { code: 0, stdout: "", stderr: "", timedOut: false } : run(cmd, args, o);
  const argv = ["--no-launchd", "--repos-root", join(b.root, "repos")];
  assert.equal(await main(argv, ctx, s.p), 0);
  assert.deepEqual(phases, ["Backing up your current files", "Writing files", "Installing npm packages", "Adding PATH entries"]);
});

test("with npm skipped there is no npm phase", async () => {
  const b = box(); const s = scripted(); const phases = recording(s);
  assert.equal(await main(flags(b), zsh(b), s.p), 0);
  assert.ok(!phases.includes("Installing npm packages"), phases.join("\n"));
  assert.deepEqual(phases.slice(0, 2), ["Backing up your current files", "Writing files"]);
});

test("Review shows the PATH line pre-ticked and Install appends the snippet once", async () => {
  const b = box(); const s = scripted();
  assert.equal(PATH_EDIT_DEFAULT, true);
  assert.equal(await main(flags(b), zsh(b), s.p), 0);
  const review = s.notes.find((n) => n.includes("Nothing") === false && n.includes("to PATH in")) ?? "";
  assert.match(review, /\[x\] Add ~\/\.local\/bin and ~\/\.pi\/agent\/bin to PATH in ~\/\.zshrc/);
  assert.equal(readFileSync(rc(b), "utf8"), `\n# pi-setup tools\n${SNIPPET}\n`);
});

test("an existing snippet is not appended again", async () => {
  const b = box(); writeFileSync(rc(b), `${SNIPPET}\n`);
  assert.equal(await main(flags(b), zsh(b), scripted().p), 0);
  assert.equal(readFileSync(rc(b), "utf8"), `${SNIPPET}\n`);
});

test("unticking the PATH line leaves the shell profile alone", async () => {
  const b = box(); const s = scripted({ Review: ["path", "install"] });
  assert.equal(await main(flags(b), zsh(b), s.p), 0);
  assert.ok(!existsSync(rc(b)));
  assert.match(s.notes.filter((n) => n.includes("to PATH in")).at(-1) ?? "", /\[ \] Add/);
  assert.match(s.notes.at(-1) ?? "", /Add ~\/\.local\/bin and ~\/\.pi\/agent\/bin to PATH, then open a new terminal/);
});

test("no PATH line and no new-terminal advice when both directories are on PATH", async () => {
  const b = box(); const s = scripted();
  assert.equal(await main(flags(b), zsh(b, true), s.p), 0);
  assert.ok(!s.notes.some((n) => n.includes("to PATH in")));
  assert.ok(!s.selects.some((x) => x.labels.some((l) => l.includes("PATH"))));
  assert.doesNotMatch(s.notes.at(-1) ?? "", /new terminal/);
  assert.ok(!existsSync(rc(b)));
});

test("non-interactive runs still need --edit-shell-profile", async () => {
  for (const edit of [false, true]) {
    const b = box(); const ctx = zsh(b); ctx.stdinTTY = false; ctx.stdoutTTY = false;
    assert.equal(await main([...flags(b), "--yes", "--user", "alice", ...(edit ? ["--edit-shell-profile"] : [])], ctx), 0);
    assert.equal(existsSync(rc(b)), edit);
  }
});

test("the finish says what is left, never up to date or done, and What's next lists the actions", async () => {
  const b = box(); const s = scripted({ "Log in to your": ["continue"] }); const ctx = zsh(b); ctx.env.STUB_READY = "";
  assert.equal(await main(flags(b), ctx, s.p), 0);
  const outro = s.outros.at(-1) ?? "";
  assert.match(outro, /^Installed, with \d+ things? to finish:/);
  assert.doesNotMatch(outro, /up to date|Done/i);
  const next = s.notes.at(-1) ?? "";
  assert.match(next, /Open a new terminal/);
  assert.match(next, /Start pi: pi/);
  assert.match(next, /\/login for /);
  assert.match(next, /pi-profile list.*\.\/install\.sh --profile <name>/);
  assert.match(next, /\.\/install\.sh doctor/);
  const left = s.notes.find((n) => n.includes("packages not installed yet")) ?? "";
  assert.match(left, /you skipped npm; run \.\/install\.sh/);
  assert.ok(left.split("\n").length <= 6, left);
  assert.ok(!left.includes(b.home), left);
});

test("compact summary groups packages and logins and caps at six lines with ~ paths", () => {
  const home = "/home/x";
  const missing = Array.from({ length: 8 }, (_, i) => `pkg${i}`);
  const fallbacks = ["anthropic", "openai-codex", "anthropic", "openai-codex", "anthropic", "openai-codex"]
    .map((p, i) => check(`fallback:${p}/m${i}`, "fail", "pins a model without a login"));
  const checks = [check("npm", "fail", "8 missing dependencies", missing), ...fallbacks, check("files", "ok", "fine")];
  const out = compactChecks(checks, { home, skipNpm: true, pathEdited: false });
  assert.deepEqual(out.lines, ["8 packages not installed yet: you skipped npm; run ./install.sh", "Log in to Claude, ChatGPT in pi (/login)"]);
  const many = [...checks, ...Array.from({ length: 8 }, (_, i) => check(`x${i}`, "warn", `see ${home}/file${i}`))];
  const capped = compactChecks(many, { home, skipNpm: false, pathEdited: false });
  assert.equal(capped.lines.length, 6);
  assert.equal(capped.count, 10);
  assert.match(capped.lines[1], /^Log in to/);
  assert.ok(capped.lines.every((l) => !l.includes(home)));
  assert.match(capped.lines[5], /^and 5 more/);
});

test("a PATH edit made in this run is not listed as left to do", () => {
  const checks = [check("path", "warn", "~/.local/bin not on PATH"), check("path:pi-profile", "warn", "pi-profile is installed at ~/.local/bin/pi-profile, but ~/.local/bin is not on PATH")];
  assert.equal(compactChecks(checks, { home: "/h", skipNpm: false, pathEdited: true }).count, 0);
  assert.equal(compactChecks(checks, { home: "/h", skipNpm: false, pathEdited: false }).count, 2);
});

const reviews = (s: ReturnType<typeof scripted>) => s.events.filter((e) => e === "select:Review").length;

test("an unchanged rerun with PATH missing still shows Review and writes the rc only after Install", async () => {
  const b = box();
  assert.equal(await main(flags(b), zsh(b, true), scripted().p), 0);
  const s = scripted({ Review: ["install"] });
  assert.equal(await main(flags(b), zsh(b), s.p), 0);
  assert.equal(reviews(s), 1, s.events.join("\n"));
  assert.equal(readFileSync(rc(b), "utf8"), `\n# pi-setup tools\n${SNIPPET}\n`);
});

test("Cancel at Review writes no rc, also after changing a step", async () => {
  for (const answers of [["cancel"], ["change", "cancel"]]) {
    const b = box();
    assert.equal(await main(flags(b), zsh(b, true), scripted().p), 0);
    const s = scripted({ Review: answers });
    assert.equal(await main(flags(b), zsh(b), s.p), 1);
    assert.ok(!existsSync(rc(b)));
  }
});

test("changing a step and landing back on the original choices still needs Install for the rc", async () => {
  const b = box();
  assert.equal(await main(flags(b), zsh(b, true), scripted().p), 0);
  const s = scripted({ Review: ["change", "cancel"] });
  assert.equal(await main(flags(b), zsh(b), s.p), 1);
  assert.equal(reviews(s), 2, s.events.join("\n"));
  assert.ok(!existsSync(rc(b)));
});

test("a truly missing command is kept and counted; only installed-off-PATH ones go away with the PATH edit", () => {
  const checks = [
    check("path", "warn", "~/.local/bin not on PATH"),
    check("path:rtk", "warn", "rtk is missing"),
    check("path:pi-profile", "warn", "pi-profile is installed at ~/.local/bin/pi-profile, but ~/.local/bin is not on PATH"),
  ];
  const edited = compactChecks(checks, { home: "/h", skipNpm: false, pathEdited: true });
  assert.deepEqual(edited.lines, ["1 command missing or not on PATH: rtk"]);
  assert.equal(edited.count, 1);
  const kept = compactChecks(checks, { home: "/h", skipNpm: false, pathEdited: false });
  assert.equal(kept.count, 2);
  assert.match(kept.lines[1], /2 commands missing or not on PATH: rtk, pi-profile/);
});
