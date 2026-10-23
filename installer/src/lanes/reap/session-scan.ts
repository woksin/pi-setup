import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

const INCOMPLETE = "session scan incomplete";
/** Fold the entire JSONL history without retaining its text; never accept a partial scan. */
export async function scanSession(path: string, consume: (line: string) => void,
  limits = { bytes: 256 * 1024 * 1024, milliseconds: 5000 }): Promise<void> {
  if (statSync(path).size > limits.bytes) throw new Error(INCOMPLETE);
  const input = createReadStream(path, { end: limits.bytes - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const deadline = performance.now() + limits.milliseconds;
  const timer = setTimeout(() => input.destroy(new Error(INCOMPLETE)), limits.milliseconds);
  try {
    for await (const line of lines) {
      if (performance.now() >= deadline) throw new Error(INCOMPLETE);
      if (line.trim()) consume(line);
    }
    if (performance.now() >= deadline) throw new Error(INCOMPLETE);
    if (statSync(path).size > input.bytesRead) throw new Error(INCOMPLETE);
  } finally {
    clearTimeout(timer); lines.close(); input.destroy();
  }
}
