import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installHint, listModels, parseAuthStatus, probeProvider } from "./detect.ts";
import { readJson, setupCmd } from "./doctor-checks.ts";
import type { DoctorFacts } from "./doctor-checks.ts";
import type { DoctorCheck } from "./doctor.ts";
import type { Manifest } from "./manifest.ts";
import { compareTags, latestTag, remoteTags } from "./update.ts";
import { PROVIDER_IDS } from "./types.ts";
import type { Ctx, RunResult } from "./types.ts";

const result = (id: string, status: DoctorCheck["status"], detail: string, fix?: string): DoctorCheck => ({ id, title: id, status, detail, ...(fix ? { fix } : {}) });
const skippedRun: RunResult = { code: null, stdout: "", stderr: "", timedOut: false };

interface Plist { file: string; label: string }
function plists(ctx: Ctx): Plist[] {
  const dir = join(ctx.home, "Library/LaunchAgents");
  if (ctx.platform !== "darwin" || !existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".plist")).flatMap(file => {
    const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(dir, file), "utf8"))?.[1];
    return label && /\.(docker-guardian|pi-cleanup)$/.test(label) ? [{ file, label }] : [];
  });
}

async function disk(ctx: Ctx): Promise<DoctorCheck[]> {
  const unknown = () => [result("disk", "warn", "disk not checked", "df -h ~")];
  const script = join(ctx.home, ".pi/agent/bin/dev-doctor");
  if (!existsSync(script)) return unknown();
  const r = await ctx.run("python3", [script, "--only", "disk", "--json"], { timeoutMs: 6000, env: { PYTHONDONTWRITEBYTECODE: "1" } });
  if (r.timedOut || r.code !== 0) return unknown();
  try {
    const findings = JSON.parse(r.stdout);
    if (!Array.isArray(findings)) return unknown();
    const checks = findings.filter(f => f?.id === "disk").map(f => {
      if (typeof f.evidence !== "string" || f.evidence.startsWith("Skipped:") || !["info", "warn", "high"].includes(f.severity)) return unknown()[0];
      return result("disk", f.severity === "high" ? "fail" : f.severity === "warn" ? "warn" : "ok", f.evidence, typeof f.suggest === "string" ? f.suggest : "df -h ~");
    });
    return checks.length ? checks : unknown();
  } catch { return unknown(); }
}

async function update(ctx: Ctx, manifest?: Manifest): Promise<DoctorCheck> {
  const skip = (reason: string) => result("update", "ok", `update check skipped (${reason})`);
  if (!existsSync(join(ctx.repoDir, ".git"))) return skip("not a git checkout");
  const path = join(ctx.home, ".pi/agent/.pi-setup/update-check.json");
  const cache = readJson(path);
  const age = ctx.now().getTime() - Date.parse(String(cache?.checkedAt));
  let latest: string | undefined;
  if (age >= 0 && age < 86400000 && typeof cache?.latest === "string") latest = latestTag([cache.latest]);
  if (!latest) {
    if (ctx.env.PI_OFFLINE) return skip("offline");
    try {
      latest = latestTag(await remoteTags(ctx, 5000));
      if (!latest) return skip("no release tags");
      if (existsSync(join(ctx.home, ".pi/agent/.pi-setup"))) writeFileSync(path, `${JSON.stringify({ checkedAt: ctx.now().toISOString(), latest })}\n`);
    } catch { return skip("remote unavailable"); }
  }
  let current = manifest?.source.release;
  if (!current) {
    const r = await ctx.run("git", ["-C", ctx.repoDir, "describe", "--tags", "--abbrev=0"], { timeoutMs: 3000 });
    if (r.code !== 0 || r.timedOut) return skip("installed release unknown");
    current = r.stdout.trim();
  }
  if (!latestTag([current])) return skip("installed release unknown");
  return result("update", compareTags(latest, current) > 0 ? "warn" : "ok", compareTags(latest, current) > 0 ? `${latest} available (installed ${current})` : `up to date (${current})`, `${setupCmd(ctx)} update`);
}

/** All external work begins together; every command has an independent deadline. */
export async function gatherFacts(ctx: Ctx, manifest?: Manifest): Promise<{ facts: DoctorFacts; checks: DoctorCheck[] }> {
  const hasPi = Boolean(ctx.which("pi"));
  const agents = plists(ctx);
  const guardian = agents.some(p => p.label.endsWith(".docker-guardian"));
  const [providers, models, version, gh, head, disks, launchd, docker, updates] = await Promise.all([
    Promise.all(PROVIDER_IDS.map(id => hasPi ? probeProvider(ctx, id) : Promise.resolve({ status: "unknown" as const }))),
    hasPi ? listModels(ctx) : Promise.resolve({ catalog: null, code: null, stderr: "", timedOut: false }),
    hasPi ? ctx.run("pi", ["--version"], { timeoutMs: 8000 }) : Promise.resolve(skippedRun),
    ctx.which("gh") ? ctx.run("gh", ["auth", "status"], { timeoutMs: 3000 }) : Promise.resolve(skippedRun),
    ctx.run("git", ["-C", ctx.repoDir, "rev-parse", "HEAD"], { timeoutMs: 3000 }),
    disk(ctx),
    Promise.all(agents.map(async p => {
      const r = await ctx.run("launchctl", ["list", p.label], { timeoutMs: 3000 });
      return result(`launchd:${p.label}`, r.code === 0 && !r.timedOut ? "ok" : "warn", `${p.label}: ${r.code === 0 && !r.timedOut ? "loaded" : "not loaded"}`, `launchctl load -w ~/Library/LaunchAgents/${p.file}`);
    })),
    guardian ? ctx.run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 5000 }) : Promise.resolve(undefined),
    update(ctx, manifest),
  ]);
  let pi: DoctorCheck;
  if (!hasPi) pi = result("pi", "fail", "not on PATH", installHint(ctx.platform, "pi"));
  else if (models.timedOut || version.timedOut) pi = result("pi", "warn", "timed out", `${setupCmd(ctx)} doctor`);
  else if (models.code !== 0 || version.code !== 0) pi = result("pi", "fail", models.stderr.split("\n")[0] || version.stderr.split("\n")[0] || "pi did not load", "run `pi` and read the startup errors");
  else pi = result("pi", "ok", `pi ${version.stdout.trim().split("\n")[0]}`);
  const github = parseAuthStatus(`${gh.stdout}\n${gh.stderr}`);
  const ghCheck = !ctx.which("gh") ? result("gh", "warn", "not on PATH", installHint(ctx.platform, "gh")) : !github.host ? result("gh", "warn", "not logged in", "gh auth login") : result("gh", "ok", `${github.login}@${github.host}`);
  return {
    facts: { providers: Object.fromEntries(PROVIDER_IDS.map((id, i) => [id, providers[i]])), catalog: models.catalog, head: head.code === 0 && !head.timedOut ? head.stdout.trim() : undefined, github: { ...github, orgs: [] }, summary: false },
    checks: [pi, ghCheck, ...disks, ...(launchd.length ? launchd : [result("launchd", "skip", "no managed launch agents")]), docker ? result("docker", docker.code === 0 && !docker.timedOut ? "ok" : "warn", docker.code === 0 && !docker.timedOut ? docker.stdout.trim() : "not reachable", ctx.platform === "darwin" ? "open -a Docker" : "systemctl --user start docker") : result("docker", "skip", "no docker guardian"), updates],
  };
}
