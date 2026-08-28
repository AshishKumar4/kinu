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

/** One untrusted field, flattened so it cannot end the drain entry it sits in.
 *  Every CR/LF becomes a visible `\n` escape rather than a real break: the
 *  content is still readable, and a reader of the list can tell that the
 *  sender wrote a newline instead of seeing the effect of one. */
function oneLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Would this pending event wake a turn?
 *
 * The agent's own `self_emit` / `internal` rows never do — that is the
 * anti-self-wake-loop rule, and it is stated ONCE here because two readers now
 * need it: the batch below, and the wake fold that decides whether a workspace
 * still owes itself an alarm (`EventLog.nextPendingDrainAt`). Spelled twice,
 * they drift the moment a third ingress is added, and the failure is silent in
 * the direction that matters: a workspace that arms no wake for work it will
 * later agree to drain.
 */
export function wakesADrain(event: KinuEvent): boolean {
  return event.ingress !== 'self_emit' && event.variant !== 'internal';
}

/** Externally-triggered pending events → one drain batch, or null if there are
 *  none (the agent's own self-emitted/internal events never wake a new turn). */
export function buildDrainBatch(events: KinuEvent[]): DrainBatch | null {
  const pending = events.filter(wakesADrain);
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
      ? ` [the sender awaits your answer — reply with agents({action:'reply', event_id:'${e.id}', message:...})]`
      : '';
    // ONE LINE PER EVENT, and the boundary is ours rather than the sender's.
    // These entries are joined with '\n' below, and several briefs embed
    // plain-text sender-controlled bodies: an email body, a subordinate's
    // report, a process's stderr. A body containing a newline followed by
    // "- [timer] from owner: ..." used to render as an additional, visually
    // identical drain entry, so external content could add events the agent
    // believes arrived. Folding the line breaks out of the untrusted fields is
    // what makes the count above and the list below agree.
    return `- [${r.variant}] from ${oneLine(r.triggered_by)}: ${oneLine(r.brief)}${replyHint}`;
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
