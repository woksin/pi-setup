import { main } from './pi-train.mjs';
process.exitCode = await main(process.argv.slice(2));
