import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];
let registered = false;

/** mkdtemp under the OS temp dir that is removed when the test process exits (each node:test file is its own process). */
export function tempDir(prefix: string): string {
	if (!registered) {
		registered = true;
		process.on("exit", () => {
			for (const dir of created) rmSync(dir, { recursive: true, force: true });
		});
	}
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}
