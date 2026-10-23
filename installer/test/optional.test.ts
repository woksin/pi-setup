import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { main } from "../src/run.ts";
import { readManifest } from "../src/manifest.ts";
import type { Ctx } from "../src/types.ts";
import { assertTempHome, REPO } from "./helpers/home.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

interface Box { home: string; pi: string; calls: string[]; out: string[]; err: string[]; ctx: Ctx }

/** In-process run with an injected runner: no real launchctl or systemctl is ever reached. */
function box(platform = "darwin", tools = ["python3", "npm", "cs-mcp", "systemctl"]): Box {
  const home = assertTempHome(mkdtempSync(join(tmpdir(), "pisetup-opt.")));
  roots.push(home);
  const b: Box = { home, pi: join(home, ".pi/agent"), calls: [], out: [], err: [], ctx: undefined as never };
  b.ctx = {
    env: { USER: "tester" }, platform, home, cwd: REPO, repoDir: REPO, now: () => new Date(2026, 0, 2, 3, 4, 5),
    run: async (cmd, args) => {
      if (cmd === "launchctl" || cmd === "systemctl") {
        b.calls.push(`${cmd} ${args.join(" ")}`);
        return { code: args[0] === "print" ? 1 : 0, stdout: "", stderr: "", timedOut: false };
      }
      return { code: 1, stdout: "", stderr: "", timedOut: false };
    },
    which: (n) => (tools.includes(n) ? `/stub/${n}` : undefined), stdinTTY: false, stdoutTTY: false, nodeVersion: "v22.19.0",
    out: (l) => b.out.push(l), err: (l) => b.err.push(l),
  };
  return b;
}
const ARGS = ["--yes", "--skip-npm", "--user", "einari", "--repos-root", "/tmp/none"];
const run = (b: Box, ...extra: string[]) => main([...ARGS, ...extra], b.ctx);
const read = (b: Box, rel: string) => readFileSync(join(b.pi, rel), "utf8");
const unit = (b: Box, name: string) => join(b.home, "Library/LaunchAgents", name);

describe("non-service components", () => {
  test("off: no Cratis files, sections or agent guard; codescene and web entries are not added", async () => {
    const b = box();
    assert.equal(await run(b, "--without", "cratis", "--without", "codescene", "--without", "web"), 0, b.err.join("\n"));
    assert.ok(!existsSync(join(b.pi, "extensions/cratis-cli-guard.ts")));
    assert.ok(!existsSync(join(b.pi, "agents/cratis-cli.md")));
    assert.ok(!existsSync(join(b.pi, "profiles/balanced/agents/cratis-cli.md")));
    assert.ok(!read(b, "AGENTS.md").includes("## Cratis repositories"));
    assert.ok(!read(b, "AGENTS.md").includes("## CodeScene Code Health"));
    assert.ok(!read(b, "agents/Explore.md").includes("cratis-cli-guard"));
    assert.ok(!read(b, "mcp-adapter.json").includes("codescene"));
    assert.ok(!read(b, "settings.json").includes("pi-web-access"));
    assert.ok(read(b, "settings.json").includes("pi-questions"));
    const m = readManifest(b.pi);
    assert.equal(m?.components?.cratis.on, false);
  });

  test("on: files and entries exist, cs-mcp comes from PATH, the token is never written", async () => {
    const b = box();
    assert.equal(await run(b, "--with", "cratis", "--with", "codescene", "--with", "web"), 0, b.err.join("\n"));
    assert.ok(existsSync(join(b.pi, "extensions/cratis-cli-guard.ts")));
    assert.ok(read(b, "AGENTS.md").includes("## Cratis repositories"));
    assert.equal(JSON.parse(read(b, "mcp-adapter.json")).mcpServers.codescene.command, "/stub/cs-mcp");
    assert.ok(read(b, "settings.json").includes("npm:pi-web-access"));
    assert.ok(b.out.some((l) => l.startsWith("CodeScene: set CS_ACCESS_TOKEN")));
    assert.ok(!existsSync(join(b.pi, "auth.json")));
  });

  test("a package you removed yourself is not added back on a rerun", async () => {
    const b = box();
    assert.equal(await run(b, "--with", "web"), 0, b.err.join("\n"));
    writeFileSync(join(b.pi, "settings.json"), '{"packages":["./local-packages/pi-questions"]}\n');
    assert.equal(await run(b), 0, b.err.join("\n"));
    assert.ok(!read(b, "settings.json").includes("pi-web-access"));
  });

  test("turning an extra off later retires what pi-setup added and leaves what you changed", async () => {
    const b = box();
    assert.equal(await run(b, "--with", "cratis", "--with", "codescene", "--with", "web"), 0, b.err.join("\n"));
    writeFileSync(join(b.pi, "agents/cratis-cli.md"), `${read(b, "agents/cratis-cli.md")}\nmine\n`);
    assert.equal(await run(b, "--without", "cratis", "--without", "codescene", "--without", "web"), 0, b.err.join("\n"));
    assert.ok(!existsSync(join(b.pi, "extensions/cratis-cli-guard.ts")));
    assert.ok(read(b, "agents/cratis-cli.md").endsWith("mine\n"), "edited file must stay");
    assert.ok(b.err.concat(b.out).some((l) => l.includes("cratis-cli.md")));
    assert.ok(!read(b, "mcp-adapter.json").includes("codescene"));
    assert.ok(!read(b, "settings.json").includes("pi-web-access"));
    assert.ok(read(b, "settings.json").includes("pi-questions"));
    assert.equal(await run(b), 0, b.err.join("\n"));
    assert.ok(!existsSync(join(b.pi, "extensions/cratis-cli-guard.ts")), "the saved choice sticks");
  });
});

describe("services", () => {
  test("no flag and no saved choice: nothing is installed or loaded", async () => {
    const b = box();
    assert.equal(await run(b), 0, b.err.join("\n"));
    assert.ok(!existsSync(join(b.home, "Library")));
    assert.deepEqual(b.calls, []);
  });

  test("launchd: a unit is written with HOME filled in, bootstrapped, then booted out on turn-off", async () => {
    const b = box();
    assert.equal(await run(b, "--with", "docker-guardian"), 0, b.err.join("\n"));
    const plist = unit(b, "com.tester.docker-guardian.plist");
    const text = readFileSync(plist, "utf8");
    assert.ok(text.includes(`${b.home}/.pi/agent/bin/docker-guardian`) && !text.includes("__HOME__") && !text.includes("com.example"));
    const uid = process.getuid?.() ?? 0;
    assert.deepEqual(b.calls, [`launchctl print gui/${uid}/com.tester.docker-guardian`, `launchctl bootstrap gui/${uid} ${plist}`]);
    assert.ok(existsSync(join(b.pi, "logs")));
    b.calls.length = 0;
    assert.equal(await run(b, "--without", "docker-guardian"), 0, b.err.join("\n"));
    assert.deepEqual(b.calls, [`launchctl bootout gui/${uid}/com.tester.docker-guardian`]);
    assert.ok(!existsSync(plist));
  });

  test("a rerun with nothing changed does not reload a loaded unit", async () => {
    const b = box();
    await run(b, "--with", "secret-sweep");
    const loaded = b.ctx.run;
    b.ctx.run = async (cmd, args, o) => (cmd === "launchctl" && args[0] === "print" ? { code: 0, stdout: "", stderr: "", timedOut: false } : loaded(cmd, args, o));
    b.calls.length = 0;
    assert.equal(await run(b), 0, b.err.join("\n"));
    assert.ok(!b.calls.some((c) => c.includes("bootstrap") || c.includes("bootout")), b.calls.join("\n"));
  });

  test("a foreign unit is left alone: not overwritten, not loaded, not removed", async () => {
    const b = box();
    const plist = unit(b, "com.tester.secret-sweep.plist");
    mkdirSync(join(b.home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(plist, "<plist>mine</plist>\n");
    assert.equal(await run(b, "--with", "secret-sweep"), 0, b.err.join("\n"));
    assert.equal(readFileSync(plist, "utf8"), "<plist>mine</plist>\n");
    assert.deepEqual(b.calls, []);
    assert.equal(readManifest(b.pi)?.components?.["secret-sweep"].service?.managed, false);
    assert.equal(await run(b, "--without", "secret-sweep"), 0, b.err.join("\n"));
    assert.equal(readFileSync(plist, "utf8"), "<plist>mine</plist>\n");
    assert.deepEqual(b.calls, []);
  });

  test("a failing launchctl is a warning with the manual command, not a failed install", async () => {
    const b = box();
    b.ctx.run = async (cmd, args) => {
      b.calls.push(`${cmd} ${args.join(" ")}`);
      return { code: 5, stdout: "", stderr: "denied", timedOut: false };
    };
    assert.equal(await run(b, "--with", "docker-guardian"), 0);
    assert.ok(b.err.some((l) => l.startsWith("warning: could not load docker-guardian: launchctl bootstrap gui/")));
  });

  test("systemd: cleanup writes a user service and timer and enables the timer; docker-guardian is unavailable", async () => {
    const b = box("linux");
    assert.equal(await run(b, "--with", "cleanup", "--with", "docker-guardian"), 0, b.err.join("\n"));
    const dir = join(b.home, ".config/systemd/user");
    assert.ok(existsSync(join(dir, "pi-cleanup.service")) && existsSync(join(dir, "pi-cleanup.timer")));
    assert.deepEqual(b.calls, ["systemctl --user daemon-reload", "systemctl --user enable --now pi-cleanup.timer"]);
    assert.ok(b.err.some((l) => l.includes("docker-guardian is not available here (needs Docker Desktop on macOS)")));
    b.calls.length = 0;
    assert.equal(await run(b, "--without", "cleanup"), 0, b.err.join("\n"));
    assert.deepEqual(b.calls, ["systemctl --user disable --now pi-cleanup.timer", "systemctl --user daemon-reload"]);
    assert.ok(!existsSync(join(dir, "pi-cleanup.timer")));
  });

  test("--dry-run calls nothing and writes nothing; uninstall boots the service out", async () => {
    const b = box();
    assert.equal(await run(b, "--with", "docker-guardian", "--dry-run"), 0, b.err.join("\n"));
    assert.deepEqual(b.calls.filter((c) => !c.includes(" print ")), []);
    assert.ok(!existsSync(b.pi));
    assert.equal(await run(b, "--with", "docker-guardian"), 0);
    b.calls.length = 0;
    assert.equal(await main(["uninstall", "--yes"], b.ctx), 0, b.err.join("\n"));
    assert.ok(b.calls.some((c) => c.startsWith("launchctl bootout gui/") && c.endsWith("com.tester.docker-guardian")), b.calls.join("\n"));
    assert.ok(!existsSync(unit(b, "com.tester.docker-guardian.plist")));
  });
});
