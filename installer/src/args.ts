import { COMPONENT_IDS, isComponentId } from "./components.ts";

export type Command = "install" | "uninstall" | "update" | "backups" | "doctor" | "lanes";

export interface Options {
  command: Command;
  /** `backups` subcommand. */
  sub: "list" | "prune";
  /** `backups prune --keep`. */
  keep: number;
  /** `update --ref`. */
  ref: string;
  help: boolean;
  dryRun: boolean;
  user: string;
  reposRoot: string;
  dir: string;
  profile: string;
  yes: boolean;
  skipNpm: boolean;
  reinstallNpm: boolean;
  noLaunchd: boolean;
  editShellProfile: boolean;
  preapproveMcp: boolean;
  plan: boolean;
  json: boolean;
  fix: boolean;
  /** `--install-prereqs` (true) / `--no-install-prereqs` (false); undefined: ask, or the `--yes` default. */
  installPrereqs: boolean | undefined;
  /** `--with <id>` (install only). */
  with: string[];
  /** `--without <id>` (install only). */
  without: string[];
}

export type Parsed = { ok: true; options: Options } | { ok: false; error: string };

export const USAGE = `Usage: ./install.sh [install] [options]
       ./install.sh uninstall [--dry-run] [--yes]
       ./install.sh update [--dry-run] [--ref <tag>] [--yes] [--skip-npm]
       ./install.sh backups [list | prune --keep <n> [--dry-run]]
       ./install.sh doctor [--fix] [--json]
       ./install.sh lanes [--dir <folder>]

  --dry-run             show what would change, write nothing
  --plan                print the full plan (detection, profile, actions), write nothing
  --json                print one JSON object on stdout (combine with --plan or --dry-run)
  --user <login>        GitHub login (default: saved, then gh, then ask)
  --repos-root <dir>    repositories root (default: saved, then ~/repos; interactive runs suggest a detected root)
  --profile <name|auto> profile to apply (default: the active one, else chosen from your logins)
  --with <id> / --without <id>  turn an extra on or off: ${COMPONENT_IDS.join(", ")}
  --preapprove-mcp      trust project MCP server definitions for new lanes folders (default: off)
  --yes                 never prompt; on a fresh machine this also installs missing prerequisites and pi
  --install-prereqs     install missing prerequisites and pi without asking (apt shows its sudo command)
  --no-install-prereqs  only check and report prerequisites, never install them
  --skip-npm            do not run npm install in ~/.pi/agent/npm
  --reinstall-npm       run npm install even when package.json and the lock file are unchanged
  --no-launchd          do not load or unload launchd jobs
  --edit-shell-profile  append the suggested PATH snippet to your shell profile
  --help                this text`;

const VALUE_FLAGS = new Set(["--dir", "--user", "--repos-root", "--profile", "--ref", "--keep", "--with", "--without"]);
const COMMON = ["--help", "--dry-run"];
const ALLOWED: Record<Command, string[] | undefined> = {
  install: undefined,
  lanes: ["--help", "--dir"],
  doctor: ["--help", "--json", "--fix", "--install-prereqs", "--no-install-prereqs"],
  uninstall: [...COMMON, "--yes", "--no-launchd"],
  update: [...COMMON, "--yes", "--skip-npm", "--ref"],
  backups: [...COMMON, "--keep"],
};
const BOOLEAN_FLAGS: Record<string, keyof Options> = {
  "--dry-run": "dryRun",
  "--yes": "yes",
  "--skip-npm": "skipNpm",
  "--reinstall-npm": "reinstallNpm",
  "--no-launchd": "noLaunchd",
  "--edit-shell-profile": "editShellProfile",
  "--preapprove-mcp": "preapproveMcp",
  "--plan": "plan",
  "--json": "json",
  "--fix": "fix",
  "--help": "help",
};

function isAbsoluteOrHome(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~");
}

export function parseArgs(argv: string[], cwd: string): Parsed {
  const options: Options = {
    command: "install", sub: "list", keep: 10, ref: "", help: false, dryRun: false, user: "", reposRoot: "", dir: "", profile: "",
    yes: false, skipNpm: false, reinstallNpm: false, noLaunchd: false, editShellProfile: false, preapproveMcp: false, plan: false, json: false, fix: false, installPrereqs: undefined, with: [], without: [],
  };
  let args = argv[0] === "install" ? argv.slice(1) : argv;
  if (args[0] === "uninstall" || args[0] === "update" || args[0] === "backups" || args[0] === "doctor" || args[0] === "lanes") {
    options.command = args[0];
    args = args.slice(1);
    if (options.command === "backups" && (args[0] === "list" || args[0] === "prune")) {
      options.sub = args[0];
      args = args.slice(1);
    }
  }
  const allowed = ALLOWED[options.command];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir" && options.command !== "lanes") return { ok: false, error: `--dir is not valid for ${options.command}` };
    if (arg === "--fix" && options.command !== "doctor") return { ok: false, error: `--fix is not valid for ${options.command}` };
    if (allowed && (arg in BOOLEAN_FLAGS || VALUE_FLAGS.has(arg)) && !allowed.includes(arg)) {
      return { ok: false, error: `${arg} is not valid for ${options.command}` };
    }
    if (arg === "--install-prereqs" || arg === "--no-install-prereqs") {
      if (allowed && !allowed.includes(arg)) return { ok: false, error: `${arg} is not valid for ${options.command}` };
      const value = arg === "--install-prereqs";
      if (options.installPrereqs !== undefined && options.installPrereqs !== value) return { ok: false, error: "--install-prereqs and --no-install-prereqs cannot be used together" };
      options.installPrereqs = value;
    } else if (arg in BOOLEAN_FLAGS) {
      (options as unknown as Record<string, unknown>)[BOOLEAN_FLAGS[arg]] = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { ok: false, error: `Missing value for ${arg}` };
      }
      i++;
      if (arg === "--keep") {
        if (!/^\d+$/.test(value)) return { ok: false, error: "--keep needs a non-negative integer" };
        options.keep = Number(value);
        continue;
      }
      if (arg === "--ref") {
        if (value.startsWith("-")) return { ok: false, error: "--ref must be a tag or commit, not an option" };
        options.ref = value;
        continue;
      }
      if (arg === "--with" || arg === "--without") {
        if (!isComponentId(value)) return { ok: false, error: `unknown component '${value}' for ${arg}; valid ids: ${COMPONENT_IDS.join(", ")}` };
        (arg === "--with" ? options.with : options.without).push(value);
        continue;
      }
      if (arg === "--user") options.user = value;
      else if (arg === "--profile") options.profile = value;
      else if (arg === "--dir") options.dir = isAbsoluteOrHome(value) ? value : `${cwd}/${value}`;
      else options.reposRoot = isAbsoluteOrHome(value) ? value : `${cwd}/${value}`;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }
  if (options.command === "doctor" && options.installPrereqs !== undefined && !options.fix) return { ok: false, error: `--${options.installPrereqs ? "" : "no-"}install-prereqs needs --fix for doctor` };
  const both = options.with.filter((id) => options.without.includes(id));
  if (both.length) return { ok: false, error: `${both.join(", ")} is in both --with and --without; valid ids: ${COMPONENT_IDS.join(", ")}` };
  return { ok: true, options };
}

export function isInteractive(
  options: Options,
  env: Record<string, string | undefined>,
  stdinTTY: boolean,
  stdoutTTY: boolean,
): boolean {
  return stdinTTY && stdoutTTY && !env.CI && !options.yes && !options.json && !options.plan && !options.dryRun;
}
