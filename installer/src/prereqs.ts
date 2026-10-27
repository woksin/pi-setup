import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Ctx } from "./types.ts";

export type Manager = "brew" | "apt" | "dnf";

interface ToolDef {
  tool: string;
  required: boolean;
  /** Package name per manager; absent means the manager cannot install it. */
  brew?: string;
  apt?: string;
  dnf?: string;
  link: string;
}

/** Table order is install order. */
export const TOOLS: ToolDef[] = [
  { tool: "gh", required: true, brew: "gh", apt: "gh", dnf: "gh", link: "https://cli.github.com" },
  { tool: "jq", required: true, brew: "jq", apt: "jq", dnf: "jq", link: "https://jqlang.org/download/" },
  { tool: "rg", required: true, brew: "ripgrep", apt: "ripgrep", dnf: "ripgrep", link: "https://github.com/BurntSushi/ripgrep#installation" },
  { tool: "fd", required: true, brew: "fd", apt: "fd-find", dnf: "fd-find", link: "https://github.com/sharkdp/fd#installation" },
  { tool: "python3", required: true, brew: "python", apt: "python3", dnf: "python3", link: "https://www.python.org/downloads/" },
  { tool: "git", required: true, brew: "git", apt: "git", dnf: "git", link: "https://git-scm.com/downloads" },
  // gitleaks is not in Ubuntu 24.04's default apt sources, so only Homebrew installs it; elsewhere it is a link.
  { tool: "gitleaks", required: false, brew: "gitleaks", link: "https://github.com/gitleaks/gitleaks#installing" },
  { tool: "tmux", required: false, brew: "tmux", apt: "tmux", dnf: "tmux", link: "https://github.com/tmux/tmux/wiki/Installing" },
  { tool: "npm", required: true, brew: "node", link: "https://nodejs.org" },
  { tool: "node", required: true, brew: "node", link: "https://nodejs.org" },
  { tool: "docker", required: false, link: "https://docs.docker.com/get-docker/" },
  { tool: "cs-mcp", required: false, link: "https://github.com/empear-analytics/codescene-mcp#installation" },
  { tool: "rtk", required: false, link: "https://github.com/rtk-ai/rtk#installation" },
];

/** Extras that need a tool the package manager can install. */
export const EXTRA_TOOLS: Record<string, string> = { "secret-sweep": "gitleaks", lanes: "tmux" };
/** Extras whose tool is only ever linked to, never installed. */
export const EXTRA_LINKS: Record<string, string> = { "docker-guardian": "docker", codescene: "cs-mcp" };

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export interface Step {
  id: string;
  label: string;
  argv: string[];
  sudo: boolean;
  /** Changes the system outside the user's home. */
  system: boolean;
}

export const isRequired = (tool: string): boolean => TOOLS.find((t) => t.tool === tool)?.required ?? false;

export function packageManager(ctx: Pick<Ctx, "platform" | "which">): Manager | undefined {
  if (ctx.platform === "darwin") return ctx.which("brew") ? "brew" : undefined;
  if (ctx.platform !== "linux") return undefined;
  if (ctx.which("apt-get")) return "apt";
  return ctx.which("dnf") ? "dnf" : undefined;
}

/** A command as the person would type it: the unattended `sudo -n` is an implementation detail. */
export const shownCommand = (argv: string[]): string => formatCommand(argv[0] === "sudo" && argv[1] === "-n" ? ["sudo", ...argv.slice(2)] : argv);

export function formatCommand(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./^~-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");
}

const pm = (manager: Manager, packages: string[], sudo: string[]): string[][] => {
  if (manager === "brew") return [["brew", "install", ...packages]];
  if (manager === "dnf") return [[...sudo, "dnf", "install", "-y", ...packages]];
  return [[...sudo, "apt-get", "update"], [...sudo, "apt-get", "install", "-y", ...packages]];
};

export interface PlanInput {
  tools: string[];
  interactive: boolean;
  isRoot: boolean;
}

export interface Plan {
  steps: Step[];
  /** Missing tools that no step installs: tool, with the link to do it by hand. */
  manual: { tool: string; link: string }[];
}

/** Links fdfind as fd; never replaces a file or another link of the user's: that is reported and left alone. */
export const FD_LINK = 'mkdir -p "$HOME/.local/bin" && t="$HOME/.local/bin/fd" && { if [ -L "$t" ] && [ "$(readlink "$t")" = /usr/bin/fdfind ]; then :; elif [ -e "$t" ] || [ -L "$t" ]; then echo "fd: $t already exists; not replacing it" >&2; else ln -s /usr/bin/fdfind "$t"; fi; }';

/** The system-level steps for the missing tools; pure, nothing runs. */
export function planPrereqs(ctx: Ctx, input: PlanInput): Plan {
  const manager = packageManager(ctx);
  const sudo = input.isRoot ? [] : input.interactive ? ["sudo"] : ["sudo", "-n"];
  const missing = TOOLS.filter((t) => input.tools.includes(t.tool) && !ctx.which(t.tool));
  const installable = missing.filter((t) => manager && t[manager]);
  const manual = missing.filter((t) => !installable.includes(t)).map((t) => ({ tool: t.tool, link: t.link }));
  if (!manager || !installable.length) return { steps: [], manual };
  const packages = [...new Set(installable.map((t) => t[manager]!))];
  const steps: Step[] = pm(manager, packages, sudo).map((argv, i) => ({
    id: `${manager}-${i}`, label: argv.includes("update") ? "Refresh the package list" : `Install ${installable.map((t) => t.tool).join(", ")}`, argv,
    sudo: argv[0] === "sudo", system: true,
  }));
  if (manager === "apt" && installable.some((t) => t.tool === "fd")) {
    steps.push({ id: "fd-link", label: "Make fd available as `fd`", argv: ["sh", "-c", FD_LINK], sudo: false, system: false });
  }
  return { steps, manual };
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

export const parseVersion = (text: string): number[] | undefined => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/** The pi range the package store pins, e.g. `^0.85.1`, and its minimum version. */
export function piMinimum(repoDir: string): { range: string; min: number[] } | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(repoDir, "agent/npm-package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const range = pkg.dependencies?.[PI_PACKAGE];
    const min = range ? parseVersion(range) : undefined;
    return range && min ? { range, min } : undefined;
  } catch {
    return undefined;
  }
}

const writable = (dir: string): boolean => {
  try { accessSync(dir, constants.W_OK); return true; } catch { return false; }
};

/** The npm command that installs pi: user-level (`--prefix ~/.local`) unless the global prefix is writable and on PATH. Never sudo. */
export function piArgv(ctx: Ctx, range: string, prefix: string | undefined): string[] {
  const onPath = prefix !== undefined && (ctx.env.PATH ?? "").split(delimiter).includes(join(prefix, "bin"));
  const user = prefix === undefined || !writable(prefix) || !onPath;
  return ["npm", "install", "-g", ...(user ? ["--prefix", join(ctx.home, ".local")] : []), `${PI_PACKAGE}@${range}`];
}

export interface PiPlan {
  step?: Step;
  /** pi is there but its version cannot be read. */
  warning?: string;
}

/** `probeVersion: false` (dry-run, plan) never runs pi: an installed pi is then taken as current. */
export async function piStep(ctx: Ctx, probeVersion = true): Promise<PiPlan> {
  const pin = piMinimum(ctx.repoDir);
  const range = pin?.range ?? "latest";
  if (ctx.which("pi")) {
    if (!pin || !probeVersion) return {};
    const out = await ctx.run("pi", ["--version"], { timeoutMs: 8000 });
    const have = parseVersion(`${out.stdout}\n${out.stderr}`);
    if (!have) return { warning: "pi is installed but its version could not be read; leaving it as is" };
    if (compareVersions(have, pin.min) >= 0) return {};
  }
  const prefix = await ctx.run("npm", ["prefix", "-g"], { timeoutMs: 8000 });
  const argv = piArgv(ctx, range, prefix.code === 0 ? prefix.stdout.trim() || undefined : undefined);
  return { step: { id: "pi", label: "Install pi", argv, sudo: false, system: false } };
}

/** One copy-pasteable command (or a link) that installs `tool` here. Used by doctor and error messages. */
export function installCommand(ctx: Ctx, tool: string): string {
  const range = piMinimum(ctx.repoDir)?.range ?? "latest";
  if (tool === "pi") return formatCommand(["npm", "install", "-g", `${PI_PACKAGE}@${range}`]);
  const def = TOOLS.find((t) => t.tool === tool);
  const manager = packageManager(ctx);
  if (def && manager && def[manager]) {
    const cmd = pm(manager, [def[manager]!], ["sudo"]).map(formatCommand);
    const last = cmd[cmd.length - 1];
    const link = manager === "apt" && tool === "fd" ? " && mkdir -p ~/.local/bin && ln -s /usr/bin/fdfind ~/.local/bin/fd" : "";
    return `${last}${link}`;
  }
  return def ? `install it from ${def.link}` : `install ${tool}`;
}
