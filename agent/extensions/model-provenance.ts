/**
 * #64: stamp StructuredOutput after argument validation with runtime branch evidence.
 * capture.json serializes these mutated args, so the provenance reaches workflow agent().
 * Always overwrite self-reported metadata, including in headless children. The stamp is
 * deliberately absent from reviewer schemas/prompts and execute only returns "Recorded.".
 * Installed pi-subagents 0.22.0 exposes no trusted child metadata to the workflow: its
 * onResolved model info is UI-only; agent() returns capture JSON. This is best-effort
 * evidence for accidental fallback/cooperating agents, NOT authentication. An adversarial
 * reviewer reading this source can imitate the whole shape if this extension is absent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildProvenance, PROVENANCE_KEY, PROVENANCE_SOURCE } from "../lib/model-provenance.ts";

const RUNTIME_STAMP = "model-provenance/tool-call/v1";

function isPlainObject(input: unknown): input is Record<string, unknown> {
	if (!input) return false;
	if (typeof input !== "object") return false;
	if (Array.isArray(input)) return false;
	const prototype = Object.getPrototypeOf(input);
	return prototype === Object.prototype || prototype === null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "StructuredOutput") return;
		const input = event.input;
		if (!isPlainObject(input)) return;
		try {
			input[PROVENANCE_KEY] = {
				...buildProvenance(ctx.sessionManager.getBranch(), { session: ctx.sessionManager.getSessionId() }), runtimeStamp: RUNTIME_STAMP,
			};
		} catch {
			input[PROVENANCE_KEY] = { source: PROVENANCE_SOURCE, runtimeStamp: RUNTIME_STAMP, models: [], unavailable: "runtime session records unavailable" };
		}
	});
}
