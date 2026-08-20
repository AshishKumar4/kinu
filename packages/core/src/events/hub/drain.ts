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
import * as v from 'valibot';
import type { KinuEvent } from './types';
import type { WorkMode } from '../../prompting/surface';
import { renderForLLM } from './visibility';
import { JsonObjectSchema } from '../../utils/json';

export interface DrainBatch {
  /** Event ids to bind (markConsumed) before injecting the turn. */
  readonly ids: string[];
  /** The synthetic user-message text that drives the autonomous turn. */
  readonly text: string;
  /** The same events rendered for splicing into a LIVE turn's next step —
   *  the mid-turn delivery must not tell the model to stop what it is doing. */
  readonly midTurnText: string;
  /** Mission budget labels the drained schedules declared. The woken turn runs
   *  under all of them, so its model calls and everything it spawns debit each
   *  one. Empty for every ordinary drain. */
  readonly missions: string[];
  /** Explicit mode inherited from delegated work. Null keeps the event's
   * established cron/background/chat classification. */
  readonly mode: WorkMode | null;
}

function delegatedEventMode(event: KinuEvent): WorkMode | null {
  if (
    event.variant !== 'peer_agent'
    && event.variant !== 'subordinate_task'
    && event.variant !== 'subordinate_report'
  ) return null;
  if (event.payload_visibility === 'full' || event.payload_visibility === 'redact') {
    return event.payload.kinu_mode;
  }
  const payload = v.safeParse(JsonObjectSchema, event.payload);
  if (!payload.success) return null;
  const mode = v.safeParse(v.picklist(['plan', 'build']), payload.output.kinu_mode);
  return mode.success ? mode.output : null;
}

/** Externally-triggered pending events → one drain batch, or null if there are
 *  none (the agent's own self-emitted/internal events never wake a new turn). */
export function buildDrainBatch(events: KinuEvent[]): DrainBatch | null {
  const pending = events.filter((e) => e.ingress !== 'self_emit' && e.variant !== 'internal');
  if (pending.length === 0) return null;
  // A delegated Plan event can never share a turn with Build or neutral work.
  // Select the oldest event's homogeneous mode group; the post-turn drain
  // immediately picks up the remaining groups in arrival order.
  const mode = delegatedEventMode(pending[0]!);
  const drainable = pending.filter((event) => delegatedEventMode(event) === mode);
  const lines = drainable.map((e) => {
    const r = renderForLLM(e);
    // Peer asks carry a mechanical reply route: the sender opened a peer-back
    // channel keyed on this event id and is awaiting the answer.
    const replyHint = (
      (e.payload_visibility === 'full' || e.payload_visibility === 'redact')
      && e.variant === 'peer_agent'
      && e.payload.reply_expected
    )
      ? ` [the sender awaits your answer — reply with peers({action:'reply', event_id:'${e.id}', message:...})]`
      : '';
    return `- [${r.variant}] from ${r.triggered_by}: ${r.brief}${replyHint}`;
  });
  const count = `${drainable.length} event${drainable.length === 1 ? '' : 's'}`;
  const listing = lines.join('\n');
  const missions = [...new Set(
    drainable.flatMap((event) => {
      if (
        (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact')
        || event.variant !== 'timer'
        || !event.payload.mission_label
      ) return [];
      return [event.payload.mission_label];
    }),
  )];
  return {
    ids: drainable.map((e) => e.id),
    missions,
    mode,
    text: `${count} arrived while you were idle. Act on each as appropriate, then stop:\n${listing}`,
    midTurnText:
      `${count} arrived while you were working. Before finishing this response, ` +
      `also act on each as appropriate:\n${listing}`,
  };
}
