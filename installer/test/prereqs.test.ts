import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseArgs } from "../src/args.ts";
import type { Options } from "../src/args.ts";
import { formatCommand, shownCommand, installCommand, packageManager, piMinimum, piStep, planPrereqs } from "../src/prereqs.ts";
import { consentFor, ensurePrereqs, linkNotes, logPath } from "../src/prereqs-run.ts";
import type { Scope } from "../src/prereqs-run.ts";
import { SetupError } from "../src/types.ts";
import type { Ctx } from "../src/types.ts";
import { REPO, sandbox, testCtx } from "./helpers/home.ts";
import type { Sandbox } from "./helpers/home.ts";
import { scripted } from "./helpers/prompter.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => rmSync(b.root, { recursive: true, force: true })));
const box = () => { const b = sandbox(); boxes.push(b); return b; };

const opts = (...argv: string[]): Options => {
  const parsed = parseArgs(argv, "/tmp");
  assert.ok(parsed.ok);
  return parsed.options;
};

interface Fake { ctx: Ctx; ran: { argv: string[]; inherit?: boolean }[]; out: string[]; err: string[]; have: Set<string> }

/** A Ctx whose package managers "install" by adding the tool to `have`; nothing real runs. */
function fake(b: Sandbox, platform: string, have: string[], extra: { root?: boolean; prefix?: string; piVersion?: string; fail?: string } = {}): Fake {
  const state: Fake = { ran: [], out: [], err: [], have: new Set(have), ctx: undefined as unknown as Ctx };
  state.ctx = testCtx(b.home, {
    platform, env: { PATH: "/usr/bin" }, which: (n) => (state.have.has(n) ? `/stub/${n}` : undefined),
    run: async (cmd, args, o) => {
      const ok = { code: 0, stdout: "", stderr: "", timedOut: false };
      if (cmd === "id") return { ...ok, stdout: extra.root ? "0\n" : "1000\n" };
      if (cmd === "pi") return { ...ok, stdout: extra.piVersion ?? "0.85.1\n" };
      if (cmd === "npm" && args[0] === "prefix") return { ...ok, stdout: `${extra.prefix ?? "/nonexistent/prefix"}\n` };
      state.ran.push({ argv: [cmd, ...args], inherit: o?.inherit });
      if (extra.fail && [cmd, ...args].join(" ").includes(extra.fail)) return { ...ok, code: 100, stderr: "boom" };
      for (const t of ["gh", "jq", "rg", "fd", "python3", "git", "gitleaks", "tmux", "pi", "npm"]) state.have.add(t);
      return ok;
    },
  }, state.out, state.err);
  return state;
}

const REQUIRED = ["gh", "jq", "rg", "fd", "python3", "git"];

test("brew: one install command in table order", () => {
  const f = fake(box(), "darwin", ["brew"]);
  const plan = planPrereqs(f.ctx, { tools: REQUIRED, interactive: true, isRoot: false });
  assert.deepEqual(plan.steps.map((s) => s.argv), [["brew", "install", "gh", "jq", "ripgrep", "fd", "python", "git"]]);
  assert.equal(plan.steps[0].sudo, false);
});

test("apt: update then install behind sudo, plus a user-level fd link; root drops sudo; unattended uses sudo -n", () => {
  const b = box();
  const f = fake(b, "linux", ["apt-get"]);
  const argvs = (interactive: boolean, isRoot: boolean) => planPrereqs(f.ctx, { tools: REQUIRED, interactive, isRoot }).steps.map((s) => s.argv);
  assert.deepEqual(argvs(true, false), [
    ["sudo", "apt-get", "update"], ["sudo", "apt-get", "install", "-y", "gh", "jq", "ripgrep", "fd-find", "python3", "git"],
    ["sh", "-c", 'mkdir -p "$HOME/.local/bin" && ln -sf /usr/bin/fdfind "$HOME/.local/bin/fd"'],
  ]);
  assert.deepEqual(argvs(false, false)[0], ["sudo", "-n", "apt-get", "update"]);
  assert.equal(shownCommand(argvs(false, false)[0]), "sudo apt-get update");
  assert.deepEqual(argvs(true, true)[0], ["apt-get", "update"]);
  const noFd = planPrereqs(fake(b, "linux", ["apt-get", "fd"]).ctx, { tools: REQUIRED, interactive: true, isRoot: false });
  assert.ok(noFd.steps.every((s) => s.id !== "fd-link"));
});

test("dnf, and no package manager (links only)", () => {
  const f = fake(box(), "linux", ["dnf"]);
  assert.deepEqual(planPrereqs(f.ctx, { tools: ["jq"], interactive: true, isRoot: false }).steps.map((s) => s.argv), [["sudo", "dnf", "install", "-y", "jq"]]);
  const none = planPrereqs(fake(box(), "linux", []).ctx, { tools: ["jq", "gh"], interactive: true, isRoot: false });
  assert.deepEqual(none.steps, []);
  assert.deepEqual(none.manual.map((m) => m.tool), ["gh", "jq"]);
  assert.match(none.manual[0].link, /^https:/);
});

test("pi: missing or older than the pin installs the pinned range, never with sudo; user prefix when needed", async () => {
  const b = box();
  const pin = piMinimum(REPO)!;
  assert.match(pin.range, /^\^\d+\.\d+\.\d+$/);
  const missing = await piStep(fake(b, "linux", ["npm"]).ctx);
  assert.deepEqual(missing.step?.argv, ["npm", "install", "-g", "--prefix", join(b.home, ".local"), `@earendil-works/pi-coding-agent@${pin.range}`]);
  const old = await piStep(fake(b, "linux", ["npm", "pi"], { piVersion: "0.1.0" }).ctx);
  assert.ok(old.step);
  assert.ok(!old.step.argv.includes("sudo"));
  const newer = await piStep(fake(b, "linux", ["npm", "pi"], { piVersion: "9.0.0" }).ctx);
  assert.equal(newer.step, undefined);
  const odd = await piStep(fake(b, "linux", ["npm", "pi"], { piVersion: "dev" }).ctx);
  assert.equal(odd.step, undefined);
  assert.match(odd.warning ?? "", /version could not be read/);
  mkdirSync(join(b.root, "prefix"));
  const f = fake(b, "linux", ["npm"], { prefix: join(b.root, "prefix") });
  f.ctx.env = { PATH: `/usr/bin:${join(b.root, "prefix/bin")}` };
  assert.deepEqual((await piStep(f.ctx)).step?.argv, ["npm", "install", "-g", `@earendil-works/pi-coding-agent@${pin.range}`]);
});

test("extras: gitleaks and tmux are installed, docker and cs-mcp only linked", () => {
  const f = fake(box(), "darwin", ["brew"]);
  assert.deepEqual(planPrereqs(f.ctx, { tools: ["gitleaks", "tmux", "docker", "cs-mcp"], interactive: true, isRoot: false }).steps.map((s) => s.argv), [["brew", "install", "gitleaks", "tmux"]]);
  const notes = linkNotes(f.ctx, ["docker-guardian", "codescene", "lanes"]);
  assert.equal(notes.length, 2);
  assert.ok(notes.every((n) => /https:\/\//.test(n) && !/install -y|brew install/.test(n)));
});

test("formatCommand quotes what a shell would need quoted; installCommand names one command per manager", () => {
  assert.equal(formatCommand(["echo", "a b", "it's"]), "echo 'a b' 'it'\\''s'");
  const b = box();
  assert.equal(installCommand(fake(b, "darwin", ["brew"]).ctx, "rg"), "brew install ripgrep");
  assert.equal(installCommand(fake(b, "linux", ["apt-get"]).ctx, "rg"), "sudo apt-get install -y ripgrep");
  assert.match(installCommand(fake(b, "linux", ["apt-get"]).ctx, "fd"), /fd-find && mkdir -p ~\/\.local\/bin && ln -sf \/usr\/bin\/fdfind/);
  assert.match(installCommand(fake(b, "linux", ["dnf"]).ctx, "git"), /^sudo dnf install -y git$/);
  assert.match(installCommand(fake(b, "linux", []).ctx, "jq"), /^install it from https:/);
  assert.match(installCommand(fake(b, "linux", []).ctx, "pi"), /^npm install -g @earendil-works\/pi-coding-agent@\^\d/);
  assert.equal(packageManager(fake(b, "darwin", []).ctx), undefined);
});

test("consent: --yes installs only on a fresh machine and never with --skip-npm", () => {
  assert.equal(consentFor(opts("--install-prereqs"), false, false), "yes");
  assert.equal(consentFor(opts("--no-install-prereqs", "--yes"), false, true), "no");
  assert.equal(consentFor(opts(), true, false), "ask");
  assert.equal(consentFor(opts(), false, true), "no");
  assert.equal(consentFor(opts("--yes"), false, true), "yes");
  assert.equal(consentFor(opts("--yes"), false, false), "no");
  assert.equal(consentFor(opts("--yes", "--skip-npm"), false, true), "no");
});

test("args: the two flags conflict, and doctor takes them only with --fix", () => {
  assert.equal(parseArgs(["--install-prereqs", "--no-install-prereqs"], "/").ok, false);
  const bad = parseArgs(["doctor", "--install-prereqs"], "/");
  assert.ok(!bad.ok && /needs --fix/.test(bad.error));
  assert.ok(parseArgs(["doctor", "--fix", "--install-prereqs"], "/").ok);
  assert.ok(!parseArgs(["update", "--install-prereqs"], "/").ok);
});

const scope = (over: Partial<Scope> = {}): Scope => ({ tools: REQUIRED, pi: false, fresh: true, ...over });

test("ensurePrereqs: nothing missing prints and runs nothing", async () => {
  const f = fake(box(), "darwin", ["brew", ...REQUIRED]);
  const r = await ensurePrereqs(f.ctx, opts("--install-prereqs"), undefined, scope());
  assert.deepEqual([f.ran, f.out, f.err, r.ran], [[], [], [], 0]);
});

test("ensurePrereqs: interactive yes runs the shown command; no runs nothing and says how to resume", async () => {
  const b = box();
  const yes = scripted({ "Continue?": [true] });
  const f = fake(b, "darwin", ["brew"]);
  const r = await ensurePrereqs(f.ctx, opts(), yes.p, scope());
  assert.deepEqual(f.ran.map((x) => x.argv.join(" ")), ["brew install gh jq ripgrep fd python git"]);
  assert.match(yes.notes[0], /Commands I will run:\n {2}brew install gh jq ripgrep fd python git/);
  assert.match(f.out.join("\n"), /→ Install .*brew install/);
  assert.match(f.out.join("\n"), /✓ Install/);
  assert.deepEqual(r.stillMissing, []);
  assert.ok(existsSync(logPath(f.ctx)));

  const no = scripted({ "Continue?": [false] });
  const g = fake(b, "darwin", ["brew"]);
  const declined = await ensurePrereqs(g.ctx, opts(), no.p, scope());
  assert.deepEqual(g.ran, []);
  assert.equal(declined.declined, true);
  assert.match(g.err.join("\n"), /Nothing was installed\. To do it later: \.\/install\.sh --install-prereqs/);
  assert.match(g.err.join("\n"), /brew install gh/);
});

test("ensurePrereqs: apt shows its sudo command before asking", async () => {
  const s = scripted({ "Continue?": [true] });
  const f = fake(box(), "linux", ["apt-get", "sudo"]);
  await ensurePrereqs(f.ctx, opts(), s.p, scope());
  assert.match(s.notes[0], /sudo apt-get install -y/);
  assert.match(s.notes[0], /sudo; you may be asked for your password/);
  assert.equal(f.ran.find((r) => r.argv[1] === "apt-get" && r.argv[2] === "install")?.inherit, true);
});

test("ensurePrereqs: flags decide without a prompt; --dry-run and --plan only print", async () => {
  const b = box();
  const f = fake(b, "darwin", ["brew"]);
  await ensurePrereqs(f.ctx, opts("--install-prereqs"), undefined, scope());
  assert.equal(f.ran.length, 1);

  for (const flags of [["--no-install-prereqs", "--yes"], ["--yes", "--skip-npm"], []]) {
    const g = fake(b, "darwin", ["brew"]);
    await ensurePrereqs(g.ctx, opts(...flags), undefined, scope(flags.includes("--skip-npm") ? {} : { fresh: flags.length > 0 }));
    assert.deepEqual(g.ran, [], flags.join(" "));
    assert.match(g.err.join("\n"), /gh is not installed; install it with: brew install gh/);
  }
  const clean = box();
  for (const flag of ["--dry-run", "--plan"]) {
    const h = fake(clean, "darwin", ["brew"]);
    await ensurePrereqs(h.ctx, opts(flag, "--install-prereqs"), undefined, scope());
    assert.deepEqual(h.ran, []);
    assert.match(h.out.join("\n"), /Would run: brew install gh jq ripgrep fd python git/);
  }
  assert.ok(!existsSync(join(clean.home, ".local")));
});

test("ensurePrereqs: a failed command names itself, the log and the resume hint, and the next run knows where it stopped", async () => {
  const b = box();
  const f = fake(b, "darwin", ["brew"], { fail: "brew install" });
  await assert.rejects(ensurePrereqs(f.ctx, opts("--install-prereqs"), undefined, scope()), (e: Error) =>
    e instanceof SetupError && /failed \(exit code 100\): brew install gh/.test(e.message) && e.message.includes(logPath(f.ctx)) && /re-run \.\/install\.sh/.test(e.message));
  assert.match(readFileSync(logPath(f.ctx), "utf8"), /\$ brew install[\s\S]*\[exit 100\]/);
  const s = scripted({ "Continue?": [true] });
  const again = fake(b, "darwin", ["brew"]);
  await ensurePrereqs(again.ctx, opts(), s.p, scope());
  assert.match(s.notes[0], /Last time this stopped at: Install/);
  assert.ok(!existsSync(join(b.home, ".local/state/pi-setup/bootstrap.json")));
});

test("ensurePrereqs: sudo is never used for pi, and a missing sudo says what to run as root", async () => {
  const b = box();
  const f = fake(b, "linux", ["apt-get", "npm"]);
  await ensurePrereqs(f.ctx, opts("--install-prereqs"), undefined, { tools: [], pi: true, fresh: true });
  assert.equal(f.ran.length, 1);
  assert.equal(f.ran[0].argv[0], "npm");
  const g = fake(b, "linux", ["apt-get"]);
  await assert.rejects(ensurePrereqs(g.ctx, opts("--install-prereqs"), undefined, scope()), /sudo is not available[\s\S]*apt-get update/);
});

test("PATH offer follows the user's own PATH, and a bootstrapped brew gets its shellenv line", async () => {
  const { missingBinDirs } = await import("../src/shell-path.ts");
  const { whatsNextLines } = await import("../src/report.ts");
  const b = box();
  const ctx = testCtx(b.home, { env: { PATH: `${b.home}/.local/bin:/usr/bin`, PI_SETUP_USER_PATH: "/usr/bin" } });
  assert.deepEqual(missingBinDirs(ctx), [".local/bin", ".pi/agent/bin"]);
  assert.deepEqual(missingBinDirs(testCtx(b.home, { env: { PATH: "/usr/bin" } })), [".local/bin", ".pi/agent/bin"]);
  const lines = whatsNextLines({ pathMissing: false, pathEdited: false, logins: [], lanesOffered: false, brewShellenv: "/opt/homebrew/bin/brew" });
  assert.ok(lines.includes('Add to your shell profile: eval "$(/opt/homebrew/bin/brew shellenv)"'));
  assert.ok(!whatsNextLines({ pathMissing: false, pathEdited: false, logins: [], lanesOffered: false }).some((l) => l.includes("shellenv")));
});

test("main: --yes on a fresh HOME installs missing prerequisites then continues; on an existing install only warns; --dry-run writes nothing", async () => {
  const { main } = await import("../src/run.ts");
  const flags = ["--user", "ci-bot", "--repos-root", "/tmp/none", "--skip-npm", "--no-launchd"];
  const fresh = box();
  const f = fake(fresh, "darwin", ["brew", "git", "python3", "gh", "jq", "npm"]);
  assert.equal(await main(["--yes", ...flags.filter((x) => x !== "--skip-npm")], f.ctx), 0, f.err.join("\n"));
  assert.ok(f.ran.some((r) => r.argv[0] === "brew" && r.argv.includes("ripgrep")));
  assert.ok(!f.ran.some((r) => r.argv.includes("sudo")));

  const again = fake(fresh, "darwin", ["brew", "git", "python3", "gh", "jq", "npm"]);
  again.have.delete("rg");
  assert.equal(await main(["--yes", ...flags], again.ctx), 0, again.err.join("\n"));
  assert.ok(!again.ran.some((r) => r.argv[0] === "brew"));
  assert.match(again.err.join("\n"), /rg is not installed; install it with: brew install ripgrep/);

  const dry = box();
  const d = fake(dry, "darwin", ["brew"]);
  assert.equal(await main(["--dry-run", "--yes", ...flags], d.ctx), 0, d.err.join("\n"));
  assert.ok(!d.ran.some((r) => r.argv[0] === "brew"));
  assert.match(d.out.join("\n"), /Would run: brew install gh jq ripgrep fd python git/);
  assert.ok(!existsSync(join(dry.home, ".pi")));
});
