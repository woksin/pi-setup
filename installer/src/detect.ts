import { existsSync } from "node:fs";
import { join } from "node:path";
import { candidateRoots, scanRoots } from "./repos-scan.ts";
import { PROVIDER_IDS } from "./types.ts";
import type { Ctx, Detection, GithubState, ProviderState, ToolState } from "./types.ts";

const TOOLS = ["pi", "python3", "jq", "git", "gh", "docker", "dotnet", "rsync", "npm"];
const SHORT_MS = 3000;
const PI_MS = 8000;

export interface DetectRequest {
  /** Probe gh for the login (not given by flag or saved). */
  needLogin: boolean;
  /** Probe gh status and orgs for display (interactive) or scoring. */
  wantGithubDetails: boolean;
  /** Scan for a repositories root (not given by flag or saved). */
  needScan: boolean;
  /** Probe pi auth and the catalog (false when probing would create ~/.pi/agent). */
  probePi: boolean; // false in --dry-run/--plan: pi probes can write state
  login?: string;
}

export function parseAuthStatus(text: string): { host?: string; login?: string } {
  const match = /Logged in to (\S+) account (\S+)/.exec(text);
  return match ? { host: match[1], login: match[2] } : {};
}

export function parseProviderCheck(stdout: string): ProviderState {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>;
    if (data.status === "ready" || data.status === "not_ready") {
      return {
        status: data.status,
        authType: typeof data.authType === "string" ? data.authType : undefined,
        reason: typeof data.reason === "string" ? data.reason : undefined,
      };
    }
  } catch {
    // fall through: unknown
  }
  return { status: "unknown" };
}

export function parseModelTable(stdout: string): Set<string> | null {
  const lines = stdout.split("\n");
  const header = lines.findIndex((l) => /^\s*provider\s+model\b/i.test(l));
  if (header < 0) return null;
  const ids = new Set<string>();
  for (const line of lines.slice(header + 1)) {
    const [provider, model] = line.trim().split(/\s+/);
    if (provider && model) ids.add(`${provider}/${model}`);
  }
  return ids.size ? ids : null;
}

async function probeTool(ctx: Ctx, name: string): Promise<ToolState> {
  const path = ctx.which(name);
  if (!path) return { name };
  const result = await ctx.run(name, ["--version"], { timeoutMs: name === "pi" ? PI_MS : SHORT_MS });
  const first = result.stdout.trim().split("\n")[0] || result.stderr.trim().split("\n")[0];
  return { name, path, version: result.timedOut || !first ? undefined : first };
}

async function lines(ctx: Ctx, args: string[]): Promise<string[] | undefined> {
  const result = await ctx.run("gh", args, { timeoutMs: SHORT_MS });
  if (result.code !== 0) return undefined;
  return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function probeGithub(ctx: Ctx, request: DetectRequest): Promise<GithubState> {
  const state: GithubState = { orgs: [] };
  if (!ctx.which("gh") || !(request.needLogin || request.wantGithubDetails || request.needScan)) return state;
  const status = request.wantGithubDetails
    ? ctx.run("gh", ["auth", "status"], { timeoutMs: SHORT_MS })
    : Promise.resolve(undefined);
  const user = request.needLogin || request.wantGithubDetails ? lines(ctx, ["api", "user", "--jq", ".login"]) : undefined;
  const orgs = (request.needScan && request.needLogin) || request.wantGithubDetails ? lines(ctx, ["api", "user/orgs", "--jq", ".[].login"]) : undefined;
  const parsed = parseAuthStatus(`${(await status)?.stdout ?? ""}\n${(await status)?.stderr ?? ""}`);
  state.host = parsed.host;
  state.login = (await user)?.[0] ?? parsed.login;
  state.orgs = (await orgs) ?? [];
  return state;
}

export async function probeProvider(ctx: Ctx, id: string): Promise<ProviderState> {
  const result = await ctx.run("pi", ["auth", "check", "--provider", id, "--no-refresh", "--json"], { timeoutMs: PI_MS });
  return result.timedOut ? { status: "unknown" } : parseProviderCheck(result.stdout);
}

export async function listModels(ctx: Ctx): Promise<{ catalog: Set<string> | null; code: number | null; timedOut: boolean; stderr: string }> {
  const result = await ctx.run("pi", ["--offline", "--list-models"], { timeoutMs: PI_MS });
  const text = `${result.stdout}\n${result.stderr}`;
  const catalog = result.timedOut ? null : /No models available/i.test(text) ? new Set<string>() : parseModelTable(result.stdout);
  return { catalog, code: result.code, timedOut: result.timedOut, stderr: result.stderr.split("\n").slice(0, 3).join("\n") };
}

async function probeCatalog(ctx: Ctx): Promise<Set<string> | null> {
  return (await listModels(ctx)).catalog;
}

export async function detect(ctx: Ctx, request: DetectRequest): Promise<Detection> {
  const piPresent = Boolean(ctx.which("pi"));
  const providers: Record<string, ProviderState> = {};
  const probePi = request.probePi && piPresent;
  const [tools, github, states, catalog] = await Promise.all([
    Promise.all(TOOLS.map((t) => (t === "pi" && !request.probePi ? Promise.resolve<ToolState>({ name: t, path: ctx.which(t) }) : probeTool(ctx, t)))),
    probeGithub(ctx, request),
    Promise.all(PROVIDER_IDS.map((id) => (probePi ? probeProvider(ctx, id) : Promise.resolve<ProviderState>({ status: "unknown" })))),
    probePi ? probeCatalog(ctx) : Promise.resolve(null),
  ]);
  PROVIDER_IDS.forEach((id, i) => {
    providers[id] = states[i];
  });
  const warnings: string[] = [];
  if (probePi && catalog?.size === 0) warnings.push("pi reports no models yet; pinned models were not checked.");
  const candidates = request.needScan
    ? scanRoots(await candidateRoots(ctx), [request.login ?? github.login ?? "", ...github.orgs], {
        now: () => ctx.now().getTime(),
      })
    : [];
  return {
    os: ctx.platform,
    tools: [...tools, { name: "node", path: process.execPath, version: ctx.nodeVersion }],
    github,
    providers,
    hints: {
      codexAuthFile: existsSync(join(ctx.home, ".codex", "auth.json")),
      claudeDir: existsSync(join(ctx.home, ".claude")),
    },
    catalog,
    candidates,
    warnings,
  };
}

export function readyProviders(detection: Detection): Set<string> {
  return new Set(Object.entries(detection.providers).filter(([, s]) => s.status === "ready").map(([id]) => id));
}

export function toolPath(detection: Detection, name: string): string | undefined {
  return detection.tools.find((t) => t.name === name)?.path;
}

