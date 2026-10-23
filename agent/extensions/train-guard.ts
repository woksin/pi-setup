import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isGuardOff } from '../lib/guards.ts';
import { trainPushDecision } from '../lib/train-guard.ts';

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash' || isGuardOff('trains')) return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== 'string' || !command.includes('push')) return;
    const result = await trainPushDecision(command, ctx.cwd);
    for (const notice of result.notices) ctx.ui.notify(notice, 'warning');
    if (result.reason) return { block: true, reason: result.reason };
  });
}
