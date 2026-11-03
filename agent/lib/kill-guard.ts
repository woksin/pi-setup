/** Heuristic over the literal bash command only; never inspect scripts or running processes. */
function executableText(source: string): string {
	// Quoted heredocs do not expand commands. Keep the header and everything after the delimiter.
	const withoutHeredocs = source.replace(
		/(<<-?\s*(['"])(\w+)\2[^\n]*\n)[\s\S]*?^\t*\3\s*$/gm,
		"$1",
	);
	return withoutHeredocs.replace(/'[^']*'|"(?:\\.|[^"\\])*"|#[^\n]*/g, literal => {
		// Double-quoted command substitutions still execute. Leave them visible to the heuristic.
		if (literal.startsWith('"') && /\$\(|`/.test(literal)) return literal;
		return " ";
	});
}

function hasProgram(command: string, name: string): boolean {
	return new RegExp(`(?:^|[\\s;|&(){}<>\x60])(?:[^\\s;|&(){}<>\x60]+/)?${name}(?=$|[\\s;|&(){}<>\x60])`).test(command);
}

const REASON = "kill guard: pattern kills hit other sessions' processes on this shared machine. " +
	"Find the exact PIDs you started with ps -o pid,ppid,pgid,command filtered to your own process group or cwd, " +
	"and lsof -p PID; kill only those numeric PIDs, or let pi-phase clean up its owned process group. " +
	"/guards off kill is the user's switch.";

function hasProcessSearch(command: string): boolean {
	if (hasProgram(command, "pgrep")) return true;
	return hasProgram(command, "ps") && hasProgram(command, "grep");
}

function isSearchKill(command: string): boolean {
	if (!hasProgram(command, "kill")) return false;
	if (!/[|`]|\$\(/.test(command)) return false;
	return hasProcessSearch(command);
}

/** Reject name kills and common process-search pipelines/substitutions, not numeric or job kills. */
export function killBlockReason(source: string): string | undefined {
	const command = executableText(source);
	if (hasProgram(command, "pkill") || hasProgram(command, "killall")) return REASON;
	if (command.split(/;|&&|\|\||\n/).some(isSearchKill)) return REASON;
	return undefined;
}
