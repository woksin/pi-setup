/** secret-mask — operator notes and tested handlers live in lib/secret-mask.ts.
 * Known limit: user shell escapes (!/!!) have no completed-output hook API; their output is not masked.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHandlers } from "../lib/secret-mask.ts";

export default function (pi: ExtensionAPI) {
	const handlers = createHandlers({ tools: () => pi.getAllTools() });
	pi.on("session_start", handlers.sessionStart);
	pi.on("tool_call", handlers.toolCall);
	pi.on("tool_result", handlers.toolResult);
	pi.on("input", handlers.input);
}
