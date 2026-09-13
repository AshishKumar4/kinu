import type { RunEvent } from '../../packages/core/src/index';

export type TurnSettlement = 'pending' | 'replied' | { readonly ended: string };

/** Terminal evidence belongs to the run that accepted the marker, not the
 * next run_end in a workspace that can also be running genesis or a wake. */
export function firstRunTurnSettlement(events: readonly RunEvent[], marker: string): TurnSettlement {
  const start = events.find((event) => event.type === 'run_start' && event.userMessage?.includes(marker));

  if (start === undefined) return 'pending';
  const own = events.filter((event) => event.runId === start.runId);
  const end = own.find((event) => event.type === 'run_end');

  if (end === undefined || end.type !== 'run_end') return 'pending';

  const replied = own.some((event) => event.type === 'step_finish' && event.messages?.some((message) =>
    message.role === 'assistant' && (Array.isArray(message.content)
      ? message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
      : message.content.trim().length > 0)));

  return replied ? 'replied' : { ended: `${end.reason ?? 'ended'}${end.error === undefined ? '' : `: ${end.error}`}` };
}
