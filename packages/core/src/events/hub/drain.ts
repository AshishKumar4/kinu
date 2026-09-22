/** Renders wake-eligible pending events into one synthetic user turn; the orchestrator binds the ids
 *  (markConsumed) before injecting so a concurrent drain cannot double-process them. */
import * as v from 'valibot';
import type { KinuEvent } from './types';
import type { WorkMode } from '../../types/turn';
import { renderForLLM } from './visibility';
import { JsonObjectSchema } from '../../utils/json';

export interface DrainBatch {
  readonly ids: string[];
  readonly text: string;
  /** For splicing into a live turn: must not tell the model to stop what it is doing. */
  readonly midTurnText: string;
  /** The woken turn is debited against every one. */
  readonly missions: string[];
  /** Null keeps the event's cron/background/chat classification. */
  readonly mode: WorkMode | null;
}

function delegatedEventMode(event: KinuEvent): WorkMode | null {
  if (event.variant !== 'peer_agent' && event.variant !== 'subordinate_report') return null;

  if (event.payload_visibility === 'full' || event.payload_visibility === 'redact') {
    return event.payload.kinu_mode;
  }

  const payload = v.safeParse(JsonObjectSchema, event.payload);

  if (!payload.success) return null;
  const mode = v.safeParse(v.picklist(['plan', 'build']), payload.output.kinu_mode);

  return mode.success ? mode.output : null;
}

/** Escapes CR/LF so an untrusted field cannot forge an extra drain entry. */
function oneLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Self-emitted/internal rows never wake a turn (anti-self-wake loop); `subordinate_task` rows belong
 * to `drainAssignments`. Shared with `EventLog.nextPendingDrainAt` so the wake fold cannot drift.
 */
export function wakesADrain(event: KinuEvent): boolean {
  return event.ingress !== 'self_emit'
    && event.variant !== 'internal'
    && event.variant !== 'subordinate_task';
}

export function buildDrainBatch(events: KinuEvent[]): DrainBatch | null {
  const pending = events.filter(wakesADrain);

  if (pending.length === 0) return null;
  // Plan and Build never share a turn: take the oldest event's mode group; the rest drain next.
  const mode = delegatedEventMode(pending[0]);
  const drainable = pending.filter((event) => delegatedEventMode(event) === mode);

  const lines = drainable.map((e) => {
    const r = renderForLLM(e);

    const replyHint = (
      (e.payload_visibility === 'full' || e.payload_visibility === 'redact')
      && e.variant === 'peer_agent'
      && e.payload.reply_expected
    )
      ? ` [the sender awaits your answer — answer it with agents({action:'msg', event_id:'${e.id}', message:...})]`
      : '';

    // One line per event: sender-controlled bodies are folded so they cannot fake extra entries.
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
