import { readFileSync, readdirSync } from "node:fs";
import { arch, release } from "node:os";
import { join } from "node:path";
import type { Options } from "./args.ts";
import type { Ctx } from "./types.ts";
import { SetupError } from "./types.ts";

// Owners from README's Related repositories and npm repository.url metadata.
export const REPORT_REPOS: Record<string, string> = {
  "pi-setup": "woksin/pi-setup",
  installer: "woksin/pi-setup", agent: "woksin/pi-setup", extensions: "woksin/pi-setup",
  lib: "woksin/pi-setup", bin: "woksin/pi-setup", skills: "woksin/pi-setup",
  agents: "woksin/pi-setup", profiles: "woksin/pi-setup", "pi-questions": "woksin/pi-setup",
  "pi-jobs": "woksin/pi-jobs", "pi-recover": "woksin/pi-recover",
  "pi-context-budget": "woksin/pi-context-budget", "pi-orch": "woksin/pi-orch",
  "pi-anthropic-auth": "gotgenes/pi-anthropic-auth", "pi-subagents": "tintinweb/pi-subagents",
  piolium: "vigolium/piolium", donsetch: "dondai44423/donsetch",
  "pi-browser-use": "0xPlayerOne/pi-browser-use", "pi-mcp-adapter": "nicobailon/pi-mcp-adapter",
  "pi-web-access": "nicobailon/pi-web-access", pi: "earendil-works/pi",
  "pi-coding-agent": "earendil-works/pi", codescene: "codescene-oss/codescene-mcp-server",
};

export function reportRepo(component: string): string | undefined {
  if (Object.values(REPORT_REPOS).includes(component)) return component;
  const name = component.replace(/^@[^/]+\//, "");
  const repo = Object.hasOwn(REPORT_REPOS, name) ? REPORT_REPOS[name] : undefined;
  if (component.startsWith("@") && !repo?.startsWith(component.slice(1).split("/")[0] + "/")) return undefined;
  return repo;
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

// Only version-shaped values enter the report; never copy diagnostics, paths or session data.
function version(value: unknown): string | undefined {
  return typeof value === "string" && /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : undefined;
}

async function setupVersion(ctx: Ctx): Promise<string> {
  const source = readJson(join(ctx.home, ".pi/agent/.pi-setup/manifest.json"))?.source;
  if (version(source?.release)) return source.release;
  if (typeof source?.commit === "string" && /^[a-f0-9]{7,40}$/.test(source.commit)) return source.commit;
  const tag = await ctx.run("git", ["describe", "--tags", "--exact-match", "HEAD"], { cwd: ctx.repoDir, timeoutMs: 2000 });
  if (tag.code === 0 && version(tag.stdout.trim())) return tag.stdout.trim();
  const commit = await ctx.run("git", ["rev-parse", "HEAD"], { cwd: ctx.repoDir, timeoutMs: 2000 });
  return commit.code === 0 && /^[a-f0-9]{40}$/.test(commit.stdout.trim()) ? commit.stdout.trim() : "unknown";
}

function packageVersions(ctx: Ctx): string[] {
  const dir = join(ctx.home, ".pi/agent/npm/node_modules/@woksin");
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return ["woksin packages: none found"]; }
  return names.filter(name => /^[a-z0-9][a-z0-9-]*$/.test(name)).map(name =>
    `@woksin/${name}: ${version(readJson(join(dir, name, "package.json"))?.version) ?? "unknown"}`);
}

export async function runReport(ctx: Ctx, options: Options): Promise<number> {
  const target = reportRepo(options.component);
  if (!target) throw new SetupError(`unknown report component '${options.component}'; valid names: ${Object.keys(REPORT_REPOS).join(", ")}`);
  const pi = await ctx.run("pi", ["--version"], { timeoutMs: 3000, env: { PI_OFFLINE: "1" } });
  const versions = [
    `pi-setup: ${await setupVersion(ctx)}`,
    `pi: ${pi.code === 0 ? version(pi.stdout.trim()) ?? "unknown" : "unavailable"}`,
    ...packageVersions(ctx), `node: ${ctx.nodeVersion}`, `OS: ${ctx.platform} ${release()} (${arch()})`,
  ];
  const block = `## Versions\n\n\`\`\`text\n${versions.join("\n")}\n\`\`\``;
  ctx.out(`Target repository: ${target}\n\n${block}`);
  ctx.out("Search for duplicates first. Redact secrets, tokens, personal paths, private repo names and session content before sharing.");
  if (!options.open) return 0;
  const body = `## What happened\n\n## Expected\n\n## Exact command and output excerpt (redacted)\n\n${block}`;
  const result = await ctx.run("gh", ["issue", "create", "--repo", target, "--web", "--body", body], { inherit: true, timeoutMs: 15000 });
  if (result.code !== 0 || result.timedOut) throw new SetupError("could not open the issue; check that gh is installed and logged in, or open https://github.com/" + target + "/issues");
  return 0;
}
