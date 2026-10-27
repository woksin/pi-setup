import { publish } from './publisher.ts';
import { scanPublication } from './publish-scan.ts';
import { TrainError } from './train-gh.mjs';

function scope(manifest, ctx) {
  return { home: ctx.env.HOME, repoRoot: manifest.worktree, cwd: manifest.worktree };
}

// Value-free: only codes, source labels, kinds, line numbers and counts are ever rendered.
function refusal(code, source, findings, count) {
  const lines = findings.map(finding => `${source}: line ${finding.line} ${finding.kind}`);
  return new TrainError([`publish: ${code}`, ...lines, `findings: ${count}`].join('\n'), 1);
}

/** Fails before any push when generated text would be refused later by the publisher. */
export function preflight(ctx, manifest, texts) {
  const context = scope(manifest, ctx);
  for (const [source, text] of Object.entries(texts)) {
    const scan = scanPublication(text, context);
    if (scan.count > 0) throw refusal('scan-refused', source, scan.findings, scan.count);
  }
}

/** Sends in-memory generated text through the shared capture/scan/send core. */
export async function publishText(ctx, options, request, manifest) {
  if (options.dryRun) { ctx.out(`would publish ${request.kind}`); return; }
  const result = await (ctx.publish ?? publish)(request, scope(manifest, ctx), {});
  if (!result.isError) return;
  if (result.code === 'scan-refused' && result.diagnostics) {
    const { source, findings, count } = result.diagnostics;
    throw refusal(result.code, source, findings, count);
  }
  throw new TrainError(`publish: ${result.code}`, 2);
}
