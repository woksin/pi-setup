import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertTempHome, REPO, tempDir } from "./helpers/home.ts";
import { main } from "../src/lanes/main.ts";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { FileBackend } from "../src/lanes/backend.ts";
import { sessionDirFor } from "../src/lanes/names.ts";
import { parseStatus, suppressed } from "../src/lanes/status-line.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { appleScriptString, shellQuote } from "../src/lanes/terminal.ts";
import { liveWatch, parseWatches } from "../src/lanes/joblogs.ts";
function fixture() {
  const home = assertTempHome(tempDir("lanes-ops")); const root = join(home, "coord"); mkdirSync(root);
  const c = defaults(root, home, join(home, "repos")); c.terminal.backend = "print";
  c.lanes = [{ id: "L1", repo: "example/alpha", worktree: "l1", branch: "l1", prompt: "prompts/l1.md", group: "GROUP" }];
  const cwd = join(home, "repos/.worktrees/l1"); mkdirSync(cwd, { recursive: true }); saveConfig(root, c);
  const messages = join(root, "messages"); mkdirSync(messages);
  const now = new Date(); const out: string[] = []; const err: string[] = []; const calls: { cmd: string; args: string[] }[] = [];
  const result = (stdout = "", code = 0) => ({ stdout, code, stderr: "failed", timedOut: false });
  let running = true; let foreground = true; let busy = "";
  const ctx: LanesCtx = { home, cwd: root, env: {}, platform: "darwin", now: () => now, which: () => undefined,
    out: (s) => out.push(s), err: (s) => err.push(s), stdinTTY: true, readStdin: async () => "", sleep: async () => {},
    templatesDir: join(REPO, "installer/lanes/templates"), piAgentDir: join(home, ".pi/agent"), realpath: (p) => p, loadModule: async () => ({}),
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "pgrep") return result(running ? "101\n" : "", running ? 0 : 1);
      if (cmd === "lsof") return result(`p101\nn${cwd}\n`);
      if (cmd === "ps" && args[0] === "-o") return result("ttys003\n");
      if (cmd === "ps" && args[0] === "-t") return result(foreground ? "101 S+ pi\n" : "101 S+ bash\n");
      if (cmd === "ps" && args[0] === "-A") return result(`101 1 pi\n${busy}`);
      if (cmd === "ps") return result("", 1);
      if (cmd === "git") return result(join(home, "repos/alpha/.git"));
      return result("", 1);
    } };
  const session = (minutes: number) => { const dir = sessionDirFor(cwd, ctx.piAgentDir); mkdirSync(dir, { recursive: true }); const path = join(dir, "s.jsonl"); writeFileSync(path, "{}"); const at = new Date(now.getTime() - minutes * 60000); utimesSync(path, at, at); return path; };
  return { home, root, c, ctx, out, err, calls, cwd, messages, now, session, result, setRunning: (v: boolean) => running = v, setForeground: (v: boolean) => foreground = v, setBusy: (v: string) => busy = v,
    invoke: (...args: string[]) => main(["--dir", root, ...args], ctx) };
}
test("status parsing suppresses only future waiting/barred status", () => {
  const now = new Date("2026-01-02T12:00:00Z");
  for (const kind of ["waiting-on", "barred-by"]) {
    assert.equal(suppressed(`${kind} "why" until 2026-01-02T13:00:00Z`, now), true);
    assert.equal(suppressed(`${kind} "why" until 2026-01-02T11:00:00Z`, now), false);
    assert.equal(suppressed(`${kind} "why" until bad`, now), false);
  }
  assert.equal(parseStatus("closed reassigned-to L2 at today").kind, "closed");
  assert.equal(parseStatus("working on x").kind, "working");
  assert.equal(suppressed("working on x", now), false);
});
test("backend unread marker, groups, ALL, mtime and atomic status", async () => {
  const f = fixture(); const backend = new FileBackend(f.messages, "ALL", () => f.now);
  assert.equal(await backend.unread("L1"), undefined);
  const marker = join(f.messages, "L1-inbox.marker"); writeFileSync(marker, "");
  const at = new Date(f.now.getTime() - 10000); utimesSync(marker, at, at);
  const names = ["L0-to-GROUP-work-1200.md", "L0-to-ALL-notice-1201.md", "L0-to-L2-other-1202.md"];
  for (const n of names) writeFileSync(join(f.messages, n), "message");
  const before = statSync(marker).mtimeMs;
  assert.deepEqual((await backend.unread("L1", { groups: ["GROUP"] }))?.map((m) => m.name).sort(), names.slice(0, 2).sort());
  await backend.setStatus("L1", "working on x"); assert.equal(await backend.status("L1"), "working on x");
  await backend.setStatus("L1", "closed at now"); assert.equal(await backend.status("L1"), "closed at now");
  assert.deepEqual(readdirSync(join(f.messages, "status")), ["L1.status"]);
  assert.equal(statSync(marker).mtimeMs, before);
});
test("idle checks no pi, recent, missing session, strict threshold, config override and busy/suppressed/closed", async () => {
  const f = fixture(); assert.equal(await f.invoke("idle-check"), 1);
  f.session(60); assert.equal(await f.invoke("idle-check"), 1);
  f.session(75); assert.equal(await f.invoke("idle-check"), 1);
  f.session(76.1); assert.equal(await f.invoke("idle-check"), 0); assert.equal(f.out.pop(), "silent: L1:76m");
  assert.equal(await f.invoke("idle-check", "--minutes", "80"), 1);
  f.c.idle = { minutes: 90 }; saveConfig(f.root, f.c); assert.equal(await f.invoke("idle-check"), 1);
  f.session(100); f.setRunning(false); assert.equal(await f.invoke("idle-check"), 1); f.setRunning(true);
  f.setBusy("102 101 pi-phase run --kind build\n"); assert.equal(await f.invoke("idle-check"), 1); f.setBusy("");
  const b = new FileBackend(f.messages, "ALL", () => f.now);
  await b.setStatus("L1", `waiting-on "x" until ${new Date(f.now.getTime() + 60000).toISOString()}`); assert.equal(await f.invoke("idle-check"), 1);
  await b.setStatus("L1", `barred-by "x" until ${new Date(f.now.getTime() + 60000).toISOString()}`); assert.equal(await f.invoke("idle-check"), 1);
  await b.setStatus("L1", "waiting-on \"x\" until 2000-01-01T00:00:00Z"); assert.equal(await f.invoke("idle-check"), 0);
  await b.setStatus("L1", "closed at now"); assert.equal(await f.invoke("idle-check"), 1);
  assert.equal(await f.invoke("idle-check", "--minutes", "0"), 2);
  assert.equal(await f.invoke("idle-check", "--minutes", "bad"), 2);
});
test("nudge refuses missing/background/closed pi, bounds text and print never sends", async () => {
  const f = fixture(); f.setRunning(false); assert.equal(await f.invoke("nudge", "L1", "hi"), 3);
  f.setRunning(true); f.setForeground(false); assert.equal(await f.invoke("nudge", "L1", "hi"), 3);
  f.setForeground(true); assert.equal(await f.invoke("nudge", "L1", "hi\nthere"), 4); assert.match(f.out.pop()!, /hi there/);
  assert.equal(await f.invoke("nudge", "L1", ""), 2); assert.equal(await f.invoke("nudge", "L1", "x".repeat(2001)), 2);
  await new FileBackend(f.messages, "ALL", () => f.now).setStatus("L1", "closed at now");
  assert.equal(await f.invoke("nudge", "L1", "hi"), 3);
  assert.ok(!f.calls.some((c) => ["osascript", "tmux"].includes(c.cmd)));
});
test("resume checks missing, stale watch, unread marker and NOW; no writes", async () => {
  const f = fixture(); const coord = join(f.root, "coordinator"); mkdirSync(coord);
  assert.equal(await f.invoke("resume-check"), 1);
  writeFileSync(join(coord, "WATCHES.md"), "WATCH|test|change|120|lanes idle-check\n");
  writeFileSync(join(coord, "NOW.md"), "PR example/alpha#1"); writeFileSync(join(f.messages, "L0-inbox.marker"), "");
  const jobs = join(f.ctx.piAgentDir, "jobs"); const day = `${f.now.getFullYear()}-${String(f.now.getMonth() + 1).padStart(2, "0")}-${String(f.now.getDate()).padStart(2, "0")}`;
  mkdirSync(join(jobs, day), { recursive: true }); const log = join(jobs, day, "watch.log");
  writeFileSync(log, "command: lanes idle-check\n--- check now exit 1 ---\n");
  const before = statSync(join(f.messages, "L0-inbox.marker")).mtimeMs;
  assert.equal(await f.invoke("resume-check"), 0);
  assert.equal(statSync(join(f.messages, "L0-inbox.marker")).mtimeMs, before);
  const old = new Date(f.now.getTime() - 100 * 60000); utimesSync(join(coord, "NOW.md"), old, old);
  assert.equal(await f.invoke("resume-check"), 1); assert.ok(f.out.some((s) => s.startsWith("STALE")));
  utimesSync(log, old, old); assert.equal(liveWatch(jobs, parseWatches("WATCH|test|change|120|lanes idle-check")[0], f.now), false);
  const m = join(f.messages, "L1-to-L0-help-1200.md"); writeFileSync(m, "help");
  const earlier = new Date(f.now.getTime() - 20 * 60000); utimesSync(join(f.messages, "L0-inbox.marker"), earlier, earlier); utimesSync(m, new Date(f.now.getTime() - 10 * 60000), new Date(f.now.getTime() - 10 * 60000));
  await f.invoke("resume-check"); assert.ok(f.out.some((s) => s.startsWith("UNREAD")));
  writeFileSync(join(coord, "WATCHES.md"), "WATCH|broken\n"); assert.equal(await f.invoke("resume-check"), 2);
});
test("watch log handles today/yesterday, trailing checks and success completion", () => {
  const f = fixture(); const yesterday = new Date(f.now); yesterday.setDate(yesterday.getDate() - 1);
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  const jobs = join(f.home, "jobs"); mkdirSync(join(jobs, day), { recursive: true });
  const path = join(jobs, day, "a.log"); const w = parseWatches("WATCH|x|success|120|echo x")[0];
  writeFileSync(path, "command: echo x\n--- check now exit 0 ---\nnoise\n"); assert.equal(liveWatch(jobs, w, f.now), false);
  writeFileSync(path, "command: echo x\n--- check now exit 1 ---\nnoise\n"); assert.equal(liveWatch(jobs, w, f.now), true);
});
test("green PR filters fail closed and ack/new state changes only on ack", async () => {
  const f = fixture(); f.ctx.which = (n) => n === "gh" ? "/stub/gh" : undefined;
  const pr = (number: number, statusCheckRollup: unknown[], extra = {}) => ({ number, statusCheckRollup, labels: [], isDraft: false, ...extra });
  const prs = [pr(1, [{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }, { conclusion: "SKIPPED" }]), pr(2, []), pr(3, [{ conclusion: "FAILURE" }]), pr(4, [{ state: "PENDING" }]), pr(5, [{ conclusion: "SUCCESS" }], { isDraft: true }), pr(6, [{ conclusion: "SUCCESS" }], { labels: [{ name: "hold" }] }), pr(7, [{ state: "SUCCESS" }])];
  f.c.github!.excludeLabels = ["hold"]; saveConfig(f.root, f.c);
  f.ctx.run = async (cmd, args) => { f.calls.push({ cmd, args }); return f.result(JSON.stringify(prs)); };
  assert.equal(await f.invoke("green-prs", "--new"), 0); assert.equal(f.out.pop(), "example/alpha#1 — staleness unknown: CI/main comparison unavailable or incomplete; verify before merging\nexample/alpha#7 — staleness unknown: CI/main comparison unavailable or incomplete; verify before merging");
  assert.equal(existsSync(join(f.root, ".state/green-ack")), false);
  assert.equal(await f.invoke("green-prs", "--ack"), 0); assert.equal(f.out.pop(), "acked 2");
  assert.equal(await f.invoke("green-prs", "--new"), 1);
  assert.equal(await f.invoke("green-prs", "--new", "--ack"), 2);
  f.ctx.run = async () => f.result("", 1); assert.equal(await f.invoke("green-prs", "--ack"), 2);
  assert.equal(readFileSync(join(f.root, ".state/green-ack"), "utf8"), "example/alpha#1\nexample/alpha#7\n");
  f.ctx.which = () => undefined; assert.equal(await f.invoke("green-prs"), 2);
  f.c.lanes = []; saveConfig(f.root, f.c); assert.equal(await f.invoke("green-prs"), 1);
});
test("close reports unread names, preserves messages and worktree, and quotes removal paths", async () => {
  const f = fixture(); const marker = join(f.messages, "L1-inbox.marker"); writeFileSync(marker, "");
  const old = new Date(f.now.getTime() - 60000); utimesSync(marker, old, old);
  const original = join(f.messages, "L0-to-GROUP-help-1200.md"); writeFileSync(original, "do not edit");
  const mtime = statSync(original).mtimeMs; const config = readFileSync(join(f.root, "lanes.json"), "utf8");
  assert.equal(await f.invoke("close", "L1", "--reassign-to", "L2", "--reason", 'done "for now"'), 0);
  assert.ok(f.err.some((s) => s.includes("still running")));
  assert.equal(readFileSync(original, "utf8"), "do not edit"); assert.equal(statSync(original).mtimeMs, mtime);
  assert.equal(readFileSync(join(f.root, "lanes.json"), "utf8"), config); assert.ok(existsSync(f.cwd));
  assert.match(readFileSync(join(f.messages, "status/L1.status"), "utf8"), /^closed reassigned-to L2 at .* reason "done 'for now'"/);
  const sent = readdirSync(f.messages).find((n) => n.includes("lane-closed-l1"))!;
  assert.match(readFileSync(join(f.messages, sent), "utf8"), /L0-to-GROUP-help-1200.md/);
  assert.match(f.out.at(-1)!, /git -C '.*' worktree unlock '.*' && git -C '.*' worktree remove '.*'/);
  assert.ok(!f.calls.some((c) => c.cmd === "git" && c.args.includes("remove")));
});
test("close --quit busy/recent/timeout cannot mark or send; print does not inject", async () => {
  for (const reason of ["busy", "recent", "print", "timeout"]) {
    const f = fixture(); f.session(reason === "recent" ? 0 : 10);
    if (reason === "busy") f.setBusy("102 101 dotnet build\n");
    if (reason === "timeout") {
      const run = f.ctx.run; f.c.terminal.backend = "tmux"; saveConfig(f.root, f.c);
      f.ctx.run = async (cmd, args, opts) => cmd === "tmux" ? f.result(args[0] === "list-panes" ? "/dev/ttys003 %1" : "") : cmd === "ps" && args[0] === "-p" ? f.result("101") : run(cmd, args, opts);
    }
    assert.equal(await f.invoke("close", "L1", "--quit"), 1, reason);
    assert.equal(existsSync(join(f.messages, "status/L1.status")), false);
    assert.equal(readdirSync(f.messages).filter((n) => n.endsWith(".md")).length, 0);
  }
});
test("close --quit sends guarded quit and only closes after exit", async () => {
  const f = fixture(); f.session(10); f.c.terminal.backend = "tmux"; saveConfig(f.root, f.c);
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => {
    if (cmd === "tmux") { f.calls.push({ cmd, args }); return f.result(args[0] === "list-panes" ? "/dev/ttys003 %1" : ""); }
    return run(cmd, args, opts);
  };
  assert.equal(await f.invoke("close", "L1", "--quit"), 0);
  assert.ok(f.calls.some((c) => c.cmd === "tmux" && c.args.includes("/quit")));
  assert.ok(existsSync(join(f.messages, "status/L1.status")));
  assert.equal(await f.invoke("close", "L0"), 2); assert.equal(await f.invoke("close", "L1", "--reassign-to", "L1"), 2);
});

test("nudge hostile text is one escaped AppleScript string or one literal tmux argument", async () => {
  for (const backend of ["terminal-app", "iterm", "tmux"]) {
    const f = fixture(); const text = `" \\ $(x) ; ' \n next`;
    const folded = text.trim().replace(/[\r\n]/g, " "); const run = f.ctx.run;
    f.ctx.run = async (cmd, args, opts) => {
      if (cmd === "osascript" || cmd === "tmux") {
        f.calls.push({ cmd, args }); return f.result(cmd === "osascript" ? "sent\n" : args[0] === "list-panes" ? "/dev/ttys003 %9\n" : "");
      }
      return run(cmd, args, opts);
    };
    assert.equal(await f.invoke("nudge", "L1", text, "--terminal", backend), 0);
    if (backend === "tmux") assert.deepEqual(f.calls.find((c) => c.cmd === "tmux" && c.args.includes("-l"))?.args, ["send-keys", "-t", "%9", "-l", "--", folded]);
    else {
      const args = f.calls.find((c) => c.cmd === "osascript")!.args;
      assert.equal(args[0], "-e"); assert.ok(args[1].includes(appleScriptString(folded))); assert.ok(args[1].includes('/dev/ttys003'));
    }
  }
});
test("nudge no tty, missing pane and backend errors remain distinct", async () => {
  const f = fixture(); const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => cmd === "ps" && args[0] === "-o" ? f.result("??") : run(cmd, args, opts);
  assert.equal(await f.invoke("nudge", "L1", "hi"), 3);
  f.ctx.run = async (cmd, args, opts) => cmd === "tmux" ? f.result("") : run(cmd, args, opts);
  assert.equal(await f.invoke("nudge", "L1", "hi", "--terminal", "tmux"), 4);
  f.ctx.run = async (cmd, args, opts) => cmd === "tmux" ? f.result("", 1) : run(cmd, args, opts);
  assert.equal(await f.invoke("nudge", "L1", "hi", "--terminal", "tmux"), 2);
});
test("close removal hint quotes hostile clone and worktree paths", async () => {
  const f = fixture(); f.setRunning(false);
  f.c.worktreesDir = join(f.home, `space ' \" $(touch INJECTED) ;`); saveConfig(f.root, f.c);
  const clone = join(f.home, `clone ' \" $(touch INJECTED) ;`);
  f.ctx.run = async (cmd) => cmd === "git" ? f.result(join(clone, ".git")) : f.result("", 1);
  assert.equal(await f.invoke("close", "L1"), 0);
  const wt = join(f.c.worktreesDir, "l1");
  assert.equal(f.out.at(-1), `when merged, remove the worktree: git -C ${shellQuote(clone)} worktree unlock ${shellQuote(wt)} && git -C ${shellQuote(clone)} worktree remove ${shellQuote(wt)}`);
  assert.equal(existsSync(join(f.home, "INJECTED")), false);
});

test("close validation failure leaves status, broadcast and running session untouched", async () => {
  for (const failure of ["exit", "empty", "timeout", "throw"]) {
    const f = fixture(); const backend = new FileBackend(f.messages, "ALL", () => f.now);
    await backend.setStatus("L1", "working on security review");
    const path = join(f.messages, "status/L1.status"); const before = readFileSync(path, "utf8");
    const time = statSync(path).mtimeMs; const run = f.ctx.run;
    f.ctx.run = async (cmd, args, opts) => {
      if (cmd !== "git") return run(cmd, args, opts);
      if (failure === "throw") throw new Error("git unavailable");
      return { ...f.result(failure === "empty" ? "" : join(f.home, "repos/alpha/.git"), failure === "exit" ? 1 : 0), timedOut: failure === "timeout" };
    };
    assert.equal(await f.invoke("close", "L1", "--quit"), 2, failure);
    assert.equal(readFileSync(path, "utf8"), before); assert.equal(statSync(path).mtimeMs, time);
    assert.deepEqual(readdirSync(f.messages), ["status"]);
    assert.equal(f.out.length, 0);
    assert.ok(!f.calls.some((c) => ["pgrep", "osascript", "tmux"].includes(c.cmd)));
  }
});
test("nudge removes every C0 control and DEL before sending to any terminal", async () => {
  const controls = Array.from({ length: 32 }, (_, n) => String.fromCharCode(n)).join("") + "\x7f";
  const text = `before${controls}after`; const expected = `before${" ".repeat(33)}after`;
  for (const backend of ["terminal-app", "iterm", "tmux"]) {
    const f = fixture(); const run = f.ctx.run;
    f.ctx.run = async (cmd, args, opts) => {
      if (cmd === "osascript" || cmd === "tmux") {
        f.calls.push({ cmd, args }); return f.result(cmd === "osascript" ? "sent\n" : args[0] === "list-panes" ? "/dev/ttys003 %9\n" : "");
      }
      return run(cmd, args, opts);
    };
    assert.equal(await f.invoke("nudge", "L1", text, "--terminal", backend), 0);
    if (backend === "tmux") {
      const payload = f.calls.find((c) => c.cmd === "tmux" && c.args.includes("-l"))!.args.at(-1)!;
      assert.equal(payload, expected); assert.doesNotMatch(payload, /[\x00-\x1f\x7f]/);
    } else {
      const script = f.calls.find((c) => c.cmd === "osascript")!.args[1];
      assert.ok(script.includes(appleScriptString(expected))); assert.doesNotMatch(script, /[\x00-\x09\x0b-\x1f\x7f]/);
    }
    const sent = f.calls.length;
    assert.equal(await f.invoke("nudge", "L1", controls, "--terminal", backend), 2);
    assert.equal(f.calls.length, sent);
  }
});
test("nudge refuses a different foreground pi or an unverified lane cwd", async () => {
  for (const platform of ["darwin", "linux"]) for (const failure of ["other-pid", "unknown-pid", "other-cwd", "unknown-cwd", "cwd-error"]) {
    const f = fixture(); f.ctx.platform = platform; const run = f.ctx.run; let cwdReads = 0;
    f.ctx.run = async (cmd, args, opts) => {
      if (cmd === "ps" && args[0] === "-t") {
        assert.deepEqual(args, ["-t", "ttys003", "-o", "pid=,stat=,comm="]);
        return f.result(failure === "other-pid" ? "101 S pi\n202 S+ pi\n" : failure === "unknown-pid" ? "S+ pi\n" : "101 S+ pi\n");
      }
      if (cmd === "lsof" || cmd === "readlink") {
        cwdReads++;
        if (cwdReads > 1 && failure === "cwd-error") throw new Error("cwd unavailable");
        if (cwdReads > 1 && failure === "unknown-cwd") return f.result("", 1);
        const cwd = cwdReads > 1 && failure === "other-cwd" ? join(f.home, "another-session") : f.cwd;
        return f.result(platform === "darwin" ? `p101\nn${cwd}\n` : `${cwd}\n`);
      }
      return run(cmd, args, opts);
    };
    assert.equal(await f.invoke("nudge", "L1", "hello", "--terminal", "tmux"), 3, `${platform} ${failure}`);
    assert.ok(!f.calls.some((c) => ["tmux", "osascript"].includes(c.cmd)));
  }
});
