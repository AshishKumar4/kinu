/**
 * Drain pending hub events into one synthetic user turn.
 *
 * The reactor's job is to wake the agent when external events arrive (webhooks,
 * timers, peer messages, …) and let it act on them in a normal Think turn. This
 * pure helper picks the externally-triggered pending events — EXCLUDING the
 * agent's own `self_emit` / `internal` events, which is the anti-self-wake-loop
 * mechanism — and renders them into a single user message. The orchestrator
 * binds the returned ids (markConsumed) before injecting the message, so a
 * concurrent drain can't double-process them.
 */
import type { ProteusEvent } from './types.js';
import { renderForLLM } from './visibility.js';

export interface DrainBatch {
  /** Event ids to bind (markConsumed) before injecting the turn. */
  readonly ids: string[];
  /** The synthetic user-message text that drives the autonomous turn. */
  readonly text: string;
}

/** Externally-triggered pending events → one drain batch, or null if there are
 *  none (the agent's own self-emitted/internal events never wake a new turn). */
export function buildDrainBatch(events: ProteusEvent[]): DrainBatch | null {
  const drainable = events.filter((e) => e.ingress !== 'self_emit' && e.variant !== 'internal');
  if (drainable.length === 0) return null;
  const lines = drainable.map((e) => {
    const r = renderForLLM(e);
    return `- [${r.variant}] from ${r.triggered_by}: ${r.brief}`;
  });
  const text =
    `${drainable.length} event${drainable.length === 1 ? '' : 's'} arrived while you were idle. ` +
    `Act on each as appropriate, then stop:\n${lines.join('\n')}`;
  return { ids: drainable.map((e) => e.id), text };
}
