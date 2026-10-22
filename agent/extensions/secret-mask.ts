/** secret-mask — operator notes and tested handlers live in lib/secret-mask.ts. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHandlers } from "../lib/secret-mask.ts";

export default function (pi: ExtensionAPI) {
	const handlers = createHandlers();
	pi.on("session_start", handlers.sessionStart);
	pi.on("tool_call", handlers.toolCall);
	pi.on("tool_result", handlers.toolResult);
	pi.on("input", handlers.input);
}
