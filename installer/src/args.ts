export interface Options {
  command: "install";
  help: boolean;
  dryRun: boolean;
  user: string;
  reposRoot: string;
  profile: string;
  yes: boolean;
  skipNpm: boolean;
  plan: boolean;
  json: boolean;
}

export type Parsed = { ok: true; options: Options } | { ok: false; error: string };

export const USAGE = `Usage: ./install.sh [install] [options]

  --dry-run             show what would change, write nothing
  --plan                print the full plan (detection, profile, actions), write nothing
  --json                print one JSON object on stdout (combine with --plan or --dry-run)
  --user <login>        GitHub login (default: saved, then gh, then ask)
  --repos-root <dir>    repositories root (default: saved, then best scan match, then ~/repos)
  --profile <name|auto> profile to apply (default: the active one, else chosen from your logins)
  --yes                 never prompt
  --skip-npm            do not run npm install in ~/.pi/agent/npm
  --help                this text`;

const VALUE_FLAGS = new Set(["--user", "--repos-root", "--profile"]);
const BOOLEAN_FLAGS: Record<string, keyof Options> = {
  "--dry-run": "dryRun",
  "--yes": "yes",
  "--skip-npm": "skipNpm",
  "--plan": "plan",
  "--json": "json",
  "--help": "help",
};

function isAbsoluteOrHome(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~");
}

export function parseArgs(argv: string[], cwd: string): Parsed {
  const options: Options = {
    command: "install", help: false, dryRun: false, user: "", reposRoot: "", profile: "",
    yes: false, skipNpm: false, plan: false, json: false,
  };
  const args = argv[0] === "install" ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg in BOOLEAN_FLAGS) {
      (options as unknown as Record<string, unknown>)[BOOLEAN_FLAGS[arg]] = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { ok: false, error: `Missing value for ${arg}` };
      }
      i++;
      if (arg === "--user") options.user = value;
      else if (arg === "--profile") options.profile = value;
      else options.reposRoot = isAbsoluteOrHome(value) ? value : `${cwd}/${value}`;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }
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
