import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN = [22, 19, 0];

export function nodeTooOld(version: string): boolean {
  const have = version.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < MIN.length; i++) {
    if ((have[i] ?? 0) !== MIN[i]) return (have[i] ?? 0) < MIN[i];
  }
  return false;
}

if (nodeTooOld(process.version)) {
  process.stderr.write(`pi-setup needs Node.js >= 22.19 (found ${process.version}); install it from https://nodejs.org, with brew install node, or with nvm.\n`);
  process.exit(1);
}

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { realContext } = await import("./context.ts");
const { main } = await import("./run.ts");
process.exitCode = await main(process.argv.slice(2), realContext(repoDir));
