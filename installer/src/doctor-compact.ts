import type { DoctorCheck } from "./doctor.ts";
import { PROVIDER_LABELS } from "./types.ts";

export const MAX_HEALTH_LINES = 6;

export interface CompactOptions {
  home: string;
  /** npm was skipped on purpose, so missing packages mean "run the installer". */
  skipNpm: boolean;
  /** The PATH edit was made in this run, so the PATH checks are not a thing left to do. */
  pathEdited: boolean;
}

export interface Compact {
  /** Everything still to finish, one line per cause. */
  lines: string[];
  /** How many causes there are, before the list is cut to MAX_HEALTH_LINES. */
  count: number;
  /** Provider names with no login, for the What's next note. */
  logins: string[];
}

const loginLabels = (checks: DoctorCheck[]): string[] => {
  const labels = new Set<string>();
  for (const c of checks) {
    if (c.id.startsWith("fallback:")) {
      const provider = c.id.slice("fallback:".length).split("/")[0];
      labels.add(PROVIDER_LABELS[provider] ?? provider);
    } else if (c.id === "profile") {
      const match = /^[^:]+: (.+) has no login$/.exec(c.detail);
      for (const label of match?.[1].split(", ") ?? []) labels.add(label);
    }
  }
  return [...labels];
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function packageLine(checks: DoctorCheck[], skipNpm: boolean): string | undefined {
  const npm = checks.find((c) => c.id === "npm" && c.status !== "ok" && c.status !== "skip");
  const named = checks.filter((c) => c.id.startsWith("package:"));
  const count = npm ? npm.items?.length || 1 : named.length;
  if (!count) return undefined;
  const why = skipNpm ? "you skipped npm; run ./install.sh" : "run ./install.sh to retry";
  return `${plural(count, "package")} not installed yet: ${why}`;
}

function toolLine(checks: DoctorCheck[]): string | undefined {
  const tools = checks.filter((c) => c.id.startsWith("tool:")).map((c) => c.id.slice(5));
  return tools.length ? `${plural(tools.length, "tool")} not found: ${tools.join(", ")}` : undefined;
}

/** Installed commands whose directory is not on PATH: the confirmed PATH edit fixes exactly these. */
const offPath = (c: DoctorCheck): boolean => c.id.startsWith("path:") && c.detail.includes("is not on PATH");

function missingCommandLine(checks: DoctorCheck[], pathEdited: boolean): string | undefined {
  const cmds = checks.filter((c) => c.id.startsWith("path:") && !(pathEdited && offPath(c))).map((c) => c.id.slice(5));
  return cmds.length ? `${plural(cmds.length, "command")} missing or not on PATH: ${cmds.join(", ")}` : undefined;
}

function pathLine(checks: DoctorCheck[]): string | undefined {
  const path = checks.find((c) => c.id === "path");
  return path ? `${path.detail}; add them to your shell profile (./install.sh --edit-shell-profile does it)` : undefined;
}

const consumed = (c: DoctorCheck): boolean =>
  c.id === "npm" || c.id.startsWith("package:") || c.id.startsWith("tool:") || c.id === "path" || c.id.startsWith("path:") ||
  c.id.startsWith("fallback:") || c.id === "profile";

/** Group the install-time checks by cause; used for the guided flow only. */
export function compactChecks(all: DoctorCheck[], options: CompactOptions): Compact {
  const checks = all.filter((c) => c.status === "warn" || c.status === "fail");
  const logins = loginLabels(checks);
  const profile = checks.find((c) => c.id === "profile" && !logins.length);
  const lines = [
    packageLine(checks, options.skipNpm),
    logins.length ? `Log in to ${logins.join(", ")} in pi (/login)` : undefined,
    profile ? `profile: ${profile.detail}` : undefined,
    options.pathEdited ? undefined : pathLine(checks),
    toolLine(checks),
    missingCommandLine(checks, options.pathEdited),
    ...checks.filter((c) => !consumed(c)).map((c) => `${c.id}: ${c.detail}`),
  ].filter((line): line is string => Boolean(line)).map((line) => line.split(options.home).join("~"));
  const shown = lines.length > MAX_HEALTH_LINES ? [...lines.slice(0, MAX_HEALTH_LINES - 1), `and ${lines.length - MAX_HEALTH_LINES + 1} more: ./install.sh doctor`] : lines;
  return { lines: shown, count: lines.length, logins };
}
