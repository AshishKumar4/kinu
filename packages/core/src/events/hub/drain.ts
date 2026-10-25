/** Renders wake-eligible pending events into one synthetic user turn; the orchestrator binds the ids
 *  (markConsumed) before injecting so a concurrent drain cannot double-process them. */
import * as v from 'valibot';
import type { KinuEvent } from './types';
import { WorkModeSchema, type WorkMode } from '../../types/turn';
import type { ScheduleTier } from '../../types/profile';
import { renderForLLM } from './visibility';
import { JsonObjectSchema } from '../../utils/json';
import { MID_TURN_DELIVERY_OPENING } from '../../utils/prompt-sections';

export interface DrainBatch {
  readonly ids: string[];
  readonly text: string;
  /** For splicing into a live turn: must not tell the model to stop what it is doing. */
  readonly midTurnText: string;
  /** The woken turn is debited against every one. */
  readonly missions: string[];
  /** Null keeps the event's cron/background/chat classification. */
  readonly mode: WorkMode | null;
  /** The tier the woken turn runs at, where every event it answers is a schedule's that names it; else null. */
  readonly tier: ScheduleTier | null;
}

export type InternalEventTest = (event: KinuEvent) => boolean;

function delegatedEventMode(event: KinuEvent): WorkMode | null {
  // A turn mail wakes plans: it reads and drafts, and any effect waits for the owner's approval in the app, even the
  // owner's own mail's, since mail is a weaker channel than the signed-in app (docs/MAIL.md §3).
  if (event.variant === 'email') return 'plan';

  // A watcher's fire carries what its check read from outside (watch.ts), which plans as mail does.
  if (event.variant === 'timer' && (event.payload_visibility === 'full' || event.payload_visibility === 'redact')
    && event.payload.watch_brief !== undefined) return 'plan';

  if (event.variant !== 'peer_agent' && event.variant !== 'subagent_report') return null;

  if (event.payload_visibility === 'full' || event.payload_visibility === 'redact') {
    return event.payload.kinu_mode;
  }

  const payload = v.safeParse(JsonObjectSchema, event.payload);

  if (!payload.success) return null;
  const mode = v.safeParse(WorkModeSchema, payload.output.kinu_mode);

  return mode.success ? mode.output : null;
}

/** A schedule's tier, where `event` is a firing of one that names it. */
function scheduleTierOf(event: KinuEvent): ScheduleTier | null {
  if (event.variant !== 'timer' || (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact')) return null;

  return event.payload.tier ?? null;
}

/** How a peer's message is answered: the agent's chat is its owner's, and never reaches the sender (hearthlit-field,
 *  2026-10-25: a peer answered a question in its chat and the asker never heard it). */
function peerAnswerRoute(event: KinuEvent): string {
  if ((event.payload_visibility !== 'full' && event.payload_visibility !== 'redact') || event.variant !== 'peer_agent') return '';

  return event.payload.reply_expected
    ? ` [the sender awaits your answer: answer it with agents({op:'reply', eventId:'${event.id}', message:...})]`
    : ` [your chat does not reach the sender: to answer, agents({op:'message', agent:'${oneLine(event.payload.from_agent_name)}', message:...})]`;
}

/** Escapes CR/LF so an untrusted field cannot forge an extra drain entry. */
function oneLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Self-emitted/internal rows never wake a turn (anti-self-wake loop); `subagent_task` rows belong
 * to `drainAssignments`; `internal` ones to a lane. Shared with `EventLog.nextPendingDrainAt` so the wake fold cannot drift.
 */
export function wakesADrain(event: KinuEvent, internal?: InternalEventTest): boolean {
  return event.ingress !== 'self_emit'
    && event.variant !== 'internal'
    && event.variant !== 'subagent_task'
    && internal?.(event) !== true;
}

export function buildDrainBatch(events: KinuEvent[], internal?: InternalEventTest): DrainBatch | null {
  const pending = events.filter((event) => wakesADrain(event, internal));

  if (pending.length === 0) return null;
  // Plan and Build never share a turn: take the oldest event's mode group; the rest drain next.
  const mode = delegatedEventMode(pending[0]);
  const drainable = pending.filter((event) => delegatedEventMode(event) === mode);

  const lines = drainable.map((e) => {
    const r = renderForLLM(e);

    return `- [${r.variant}] from ${oneLine(r.triggered_by)}: ${oneLine(r.brief)}${peerAnswerRoute(e)}`;
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

  const tiers = new Set(drainable.map(scheduleTierOf));
  const [tier = null] = tiers.size === 1 ? tiers : [];

  return {
    ids: drainable.map((e) => e.id),
    missions,
    mode,
    tier,
    text: `${count} arrived while you were idle. Act on each as appropriate, then stop:\n${listing}`,
    midTurnText: `${count} ${MID_TURN_DELIVERY_OPENING}\n${listing}`,
  };
}
