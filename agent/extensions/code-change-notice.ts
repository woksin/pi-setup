/**
 * code-change-notice — tells the user (footer status only; no message, no turn) when extension, lib or
 * local-package code on disk changed after this session loaded it. Never reloads anything itself.
 * Async stat-only fingerprint every 5 minutes on an unref'd timer; scans never overlap.
 * Logic lives in lib/code-change-notice.ts.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CODE_CHANGE_INTERVAL_MS, CODE_CHANGE_STATUS, CODE_SCAN_CAPPED_STATUS, changedPaths, fingerprint, type Fingerprint } from "../lib/code-change-notice.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let baseline: Fingerprint | undefined;
	let scanning = false;
	let generation = 0;
	const stop = () => { if (timer) clearInterval(timer); timer = undefined; generation++; };

	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (!ctx.hasUI) return;
		const mine = generation;
		try {
			const first = await fingerprint(AGENT_DIR);
			if (mine !== generation) return;
			baseline = first.files;
			if (first.capped) { ctx.ui.setStatus("code-change", CODE_SCAN_CAPPED_STATUS); return; }
		} catch { return; }
		timer = setInterval(async () => {
			if (scanning || !baseline) return;
			scanning = true;
			try {
				const now = await fingerprint(AGENT_DIR);
				if (mine !== generation) return;
				if (now.capped) { ctx.ui.setStatus("code-change", CODE_SCAN_CAPPED_STATUS); stop(); }
				else if (changedPaths(baseline, now.files).length) { ctx.ui.setStatus("code-change", CODE_CHANGE_STATUS); stop(); }
			} catch { stop(); /* stale context after reload: stop quietly */ }
			finally { scanning = false; }
		}, CODE_CHANGE_INTERVAL_MS);
		timer.unref?.();
	});
	pi.on("session_shutdown", () => { stop(); });
}
