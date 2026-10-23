import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { realLanesCtx } from "./ctx.ts";
import { main } from "./main.ts";
export { main } from "./main.ts";
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), realLanesCtx());
}
