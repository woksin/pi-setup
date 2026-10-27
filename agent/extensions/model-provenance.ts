/**
 * #64: stamp StructuredOutput after argument validation with runtime branch evidence.
 * capture.json serializes these mutated args, so the provenance reaches workflow agent().
 * Always overwrite self-reported metadata, including in headless children. This is local
 * runtime evidence, not attestation: live agent files must load this extension too.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildProvenance, PROVENANCE_KEY, PROVENANCE_SOURCE } from "../lib/model-provenance.ts";

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
			input[PROVENANCE_KEY] = buildProvenance(ctx.sessionManager.getBranch(), { session: ctx.sessionManager.getSessionId() });
		} catch {
			input[PROVENANCE_KEY] = { source: PROVENANCE_SOURCE, models: [], unavailable: "runtime session records unavailable" };
		}
	});
}
