/** Text for the persistent provider-fallback widget, and the cheap "extension changed on disk" fingerprint. Pure; no pi imports. */
import { statSync } from "node:fs";

export interface StatusInput {
	originalRef: string;
	current?: string;
	reason?: string;
	until?: number;
	provider: string;
	commandRegistered: boolean;
	restoreNote?: string;
	stale: boolean;
}

const clock = (until: number): string => new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function fallbackStatusLines(input: StatusInput): string[] {
	const { originalRef, current, reason, until, provider, commandRegistered, restoreNote, stale } = input;
	const lines = [
		`provider-fallback: on ${current ?? "a fallback model"} instead of ${originalRef}${reason ? ` — ${reason}` : ""}` +
			(until ? ` (until ${clock(until)})` : "") +
			(restoreNote ? ` — cannot switch back: ${restoreNote}` : ""),
		`undo: ${commandRegistered ? `/provider-restore ${provider} · ` : ""}shell: provider-restore ${provider}`,
	];
	if (stale) lines.push("provider-fallback changed on disk since this session loaded it: /reload when idle; until then use the shell command.");
	return lines;
}

/** `mtimeMs:size` per file, `-` when missing; never throws. */
export function codeFingerprint(paths: string[]): string {
	return paths
		.map((path) => {
			try {
				const stat = statSync(path);
				return `${stat.mtimeMs}:${stat.size}`;
			} catch {
				return "-";
			}
		})
		.join("|");
}
