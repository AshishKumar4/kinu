import type { RunEvent } from '@kinu.run/core';

/** Invocation observations are emitted during this turn; quality/use counters are reviewed later. */
export function invokedInTurn(events: readonly RunEvent[], name: string, startedAt: number): boolean {
  return events.some((event) => event.type === 'craft_cycle' && Date.parse(event.timestamp) >= startedAt && event.invoked.includes(name));
}
