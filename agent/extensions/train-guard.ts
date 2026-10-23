import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isGuardOff } from '../lib/guards.ts';
import { trainPushDecision } from '../lib/train-guard.ts';
import { prCreateDecision, gateRunNotice } from '../lib/candidate-guard.ts';
import { isOrchestrated, orchLog } from '../lib/orchestration.ts';

async function pushDecision(command: string, ctx: ExtensionContext) {
  const result = await trainPushDecision(command, ctx.cwd);
  if (ctx.hasUI) for (const notice of result.notices) ctx.ui.notify(notice, 'warning');
  if (result.reason) return { block: true as const, reason: result.reason };
}

function logDecision(result: { log?: string }, orchestrated: boolean, notice?: string) {
  if (result.log) orchLog('trains', 'exception', result.log);
  else if (orchestrated && notice) orchLog('trains', 'warn', notice);
}

function remember(warnings: Map<string, string>, id: string, notice: string, ctx: ExtensionContext) {
  warnings.set(id, notice);
  if (warnings.size > 50) warnings.delete(warnings.keys().next().value!);
  if (ctx.hasUI) ctx.ui.notify(notice, 'warning');
}

async function candidateDecision(command: string, ctx: ExtensionContext, id: string, warnings: Map<string, string>) {
  const orchestrated = isOrchestrated(process.env, ctx.cwd);
  const result = await prCreateDecision(command, ctx.cwd, process.env, undefined, orchestrated);
  const notice = result.warn ?? await gateRunNotice(command, ctx.cwd);
  logDecision(result, orchestrated, notice);
  if (result.block) return { block: true as const, reason: result.block };
  if (notice) remember(warnings, id, notice, ctx);
}

function callHandler(warnings: Map<string, string>) {
  return async (event: { toolName: string; input: unknown; toolCallId: string }, ctx: ExtensionContext) => {
    if (event.toolName !== 'bash' || isGuardOff('trains')) return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== 'string') return;
    if (command.includes('push')) {
      const blocked = await pushDecision(command, ctx);
      if (blocked) return blocked;
    }
    if (/\bgh\b[\s\S]*\bpr\b[\s\S]*\bcreate\b|pi-phase/.test(command)) {
      return candidateDecision(command, ctx, event.toolCallId, warnings);
    }
  };
}

export default function (pi: ExtensionAPI) {
  const warnings = new Map<string, string>();
  pi.on('tool_call', callHandler(warnings));
  pi.on('tool_result', async event => {
    const warning = warnings.get(event.toolCallId);
    warnings.delete(event.toolCallId);
    if (!warning || isGuardOff('trains')) return;
    return { content: [...event.content, { type: 'text' as const, text: '\n[candidate] ' + warning }] };
  });
}
