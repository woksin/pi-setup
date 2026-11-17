import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { shellGuard } from '../lib/shell-invocations.ts';
import { isGuardOff } from '../lib/guards.ts';
import { trainPushDecision } from '../lib/train-guard.ts';
import { prCreateDecision, publicationDecision } from '../lib/candidate-guard.ts';
import { isOrchestrated, orchLog } from '../lib/orchestration.ts';

async function pushDecision(command: string, executionCwd: string) {
  const result = await trainPushDecision(command, executionCwd);
  if (result.reason) return { block: true as const, reason: result.reason };
}

function logDecision(result: { log?: string }) {
  if (result.log) orchLog('trains', 'exception', result.log);
}

async function candidateDecision(command: string, ctx: ExtensionContext, executionCwd: string) {
  const orchestrated = isOrchestrated(process.env, ctx.cwd);
  const result = await prCreateDecision(command, executionCwd, process.env, undefined, orchestrated);
  logDecision(result);
  if (result.block) return { block: true as const, reason: result.block };
}

async function typedCandidate(input: unknown, ctx: ExtensionContext) {
  const orchestrated = isOrchestrated(process.env, ctx.cwd);
  const result = await publicationDecision(input, { cwd: ctx.cwd, env: process.env, orchestrated });
  logDecision(result);
  if (result.block) return { block: true as const, reason: result.block };
}

async function callHandler(event: { toolName: string; input: unknown }, ctx: ExtensionContext, executionCwd: string) {
  if (isGuardOff('trains')) return;
  if (event.toolName === 'publish') return typedCandidate(event.input, ctx);
  if (event.toolName !== 'bash') return;
  const command = (event.input as { command?: unknown }).command;
  if (typeof command !== 'string') return;
  if (command.includes('push')) {
    const blocked = await pushDecision(command, executionCwd);
    if (blocked) return blocked;
  }
  if (/\bgh\b[\s\S]*\bpr\b[\s\S]*\bcreate\b|pi-phase|pi-publish/.test(command)) {
    return candidateDecision(command, ctx, executionCwd);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', shellGuard(callHandler, () => !isGuardOff('trains')));
}
