/**
 * stale-cwd — says so (one warning plus a persistent status) when this pi process's working directory went stale:
 * process.cwd() throws ENOENT although the session's directory may still exist. `/reload` does not fix it; the
 * recovery is to exit pi and `cd <path> && pi -c`. Silent when the cwd is fine. Never changes the cwd. Logic in lib/stale-cwd.ts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { probeCwd, recoveryText } from "../lib/stale-cwd.ts";

const STATUS = "stale-cwd";

export default function (pi: ExtensionAPI) {
	let warned = false;

	function check(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			let sessionCwd: string | undefined;
			try { sessionCwd = ctx.sessionManager.getCwd(); } catch { /* unknown */ }
			const probe = probeCwd({ sessionCwd });
			if (probe.state === "ok") {
				ctx.ui.setStatus(STATUS, undefined);
				warned = false;
				return;
			}
			ctx.ui.setStatus(STATUS, "⚠ stale cwd: exit pi, cd to the project, pi -c");
			if (!warned) {
				warned = true;
				ctx.ui.notify(recoveryText(probe.sessionCwd, probe.sessionCwdExists), "warning");
			}
		} catch {
			// never break a session over a notice
		}
	}

	pi.on("session_start", (_event, ctx) => { warned = false; check(ctx); });
	pi.on("before_agent_start", (_event, ctx) => { check(ctx); });
}
