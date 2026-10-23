/**
 * Watchers: triggers whose check program runs before they fire, so only a check that found something wakes the agent,
 * with what it found as the turn's brief. A check costs no model call; it reads, and answers `{ fire, brief?, state? }`,
 * its `state` (a cursor: a history id, an ETag) kept on the trigger for its next run.
 *
 * One check runs per trigger at a time: an arrival during a check is folded into one re-check after it. The cursor is
 * written only when the check read the one stored and its own does not move back, and a trigger cancelled or paused
 * while its check ran fires nothing.
 */

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import type { TriggerRegistry } from '../hub/triggers';
import type { TriggerRow } from '../hub/types';
import { runWorkModeInvocation } from '../../execution/work-mode';
import { stableStringify } from '../../safety/argument-digest';
import type { CodemodeProvider } from '../../types/codemode';
import type { ResolvedProvider } from '../../types/primitives';
import { WatchCheckSchema, type WatchCheck } from '../../types/watch';
import { decodeJsonValue, JsonValueSchema, type JsonObject, type JsonValue } from '../../utils/json';

export { WatchCheckSchema, type WatchCheck } from '../../types/watch';

/** Why a watcher stopped checking: each lifts only on its own cause, never on a clock. */
export type WatchParkReason = 'connection' | 'program' | 'overran';

const WatchSchema = v.object({
  state: v.optional(JsonValueSchema),
  parked: v.optional(v.object({ reason: v.picklist(['connection', 'program', 'overran']), at: v.number(), detail: v.string() })),
});

const CheckAnswerSchema = v.union([
  v.object({ fire: v.literal(false), state: v.optional(JsonValueSchema) }),
  v.object({ fire: v.literal(true), brief: v.pipe(v.string(), v.minLength(1)), state: v.optional(JsonValueSchema) }),
]);

export type CheckAnswer = v.InferOutput<typeof CheckAnswerSchema>;

/** How a check ended, as its runner reads it. */
export type WatchOutcome =
  | { readonly kind: 'answered'; readonly answer: CheckAnswer }
  | { readonly kind: 'parked'; readonly reason: WatchParkReason; readonly detail: string }
  /** The provider named when to ask again (a 429's Retry-After, GitHub's X-Poll-Interval). */
  | { readonly kind: 'deferred'; readonly until: number; readonly detail: string }
  /** Network or a provider's 5xx: the trigger's next firing is the next try. */
  | { readonly kind: 'transient'; readonly detail: string };

/** Runs `check` over the trigger's stored `state`; `input` is the delivery that woke it, where one did. */
export type RunCheck = (check: WatchCheck, state: JsonValue | undefined, input: JsonValue | undefined) => Promise<WatchOutcome>;

/** A program's answer, or null where it is off-shape (the watcher parks on `program`). */
export function checkAnswerOf(result: JsonValue | undefined): CheckAnswer | null {
  const parsed = v.safeParse(CheckAnswerSchema, result);

  return parsed.success ? parsed.output : null;
}

/**
 * What a check's program reaches: of each namespace its `reads` names, the members whose operation only observes, each
 * run in Plan. Plan alone would leave it `memory.remember`, `db` writes and `mail.send`; a check changes nothing.
 */
export function watchProviders(providers: readonly CodemodeProvider[], reads: readonly string[]): ResolvedProvider[] {
  return providers.filter((provider) => reads.includes(provider.name)).map((provider) => {
    const observes = new Set((provider.operations ?? []).filter(({ op }) => op.impact === 'observe').map(({ op }) => op.name));
    const fns: ResolvedProvider['fns'] = {};

    for (const [name, member] of Object.entries(provider.tools)) {
      if (!observes.has(name)) continue;
      fns[name] = async (...args) => {
        const result = await runWorkModeInvocation('plan', () => member.execute(...args));

        return result === undefined ? undefined : decodeJsonValue({ value: result });
      };
    }

    return { name: provider.name, fns };
  });
}

/** The check a trigger carries; null for a plain schedule. */
export function watchCheckOf(trigger: Pick<TriggerRow, 'spec'>): WatchCheck | null {
  const check = trigger.spec['check'];

  return check === undefined ? null : v.parse(WatchCheckSchema, check);
}

function watchOf(trigger: Pick<TriggerRow, 'spec'>): v.InferOutput<typeof WatchSchema> {
  return v.parse(WatchSchema, trigger.spec['watch'] ?? {});
}

/** An ordered cursor (`state.cursor`, a number or digits) may only grow; any other state may change freely. */
function movesBack(stored: JsonValue | undefined, next: JsonValue | undefined): boolean {
  const cursor = (state: JsonValue | undefined): bigint | null => {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) return null;
    const value = state['cursor'];

    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);

    return typeof value === 'string' && /^\d{1,30}$/u.test(value) ? BigInt(value) : null;
  };

  const before = cursor(stored);
  const after = cursor(next);

  return before !== null && after !== null && after < before;
}

/**
 * The checks running in this object, by trigger: a claim lives in memory, as the check it guards does, and a reset loses
 * both. An arrival during a check sets `again`, and the check runs once more after it commits.
 */
export class WatchClaims {
  private readonly running = new Map<string, { again: boolean; input: JsonValue | undefined }>();

  /** Runs `check` for `triggerId` over `input`, or folds this arrival into the running one's re-check, which reads the
   *  latest arrival's input. */
  async run(triggerId: string, input: JsonValue | undefined, check: (input: JsonValue | undefined) => Promise<void>): Promise<void> {
    const held = this.running.get(triggerId);

    if (held !== undefined) {
      held.again = true;
      held.input = input;

      return;
    }

    const claim = { again: false, input };

    this.running.set(triggerId, claim);

    try {
      do {
        claim.again = false;
        await check(claim.input);
      } while (claim.again);
    } finally {
      this.running.delete(triggerId);
    }
  }
}

export interface WatchDeps {
  readonly registry: TriggerRegistry;
  readonly log: EventLog;
  readonly run: RunCheck;
  readonly claims: WatchClaims;
}

type WatchCommit = 'fired' | 'quiet' | 'parked' | 'deferred' | 'dropped';

/**
 * One check of `triggerId`, its fire keyed by `asked.at` (the firing or delivery that asked for it), and its commit. A
 * trigger whose check is already running is checked once more after it, under that check's claim.
 */
export async function checkWatcher(
  deps: WatchDeps, triggerId: string, asked: { readonly at: number; readonly input?: JsonValue }, now: () => number,
): Promise<void> {
  const scheduledAt = asked.at;

  await deps.claims.run(triggerId, asked.input, async (input) => {
    const trigger = deps.registry.get(triggerId);
    const check = trigger === null || trigger.state !== 'active' ? null : watchCheckOf(trigger);

    if (trigger === null || check === null) return;
    const read = watchOf(trigger).state;
    const outcome = await deps.run(check, read, input);

    await commitCheck(deps, { triggerId, read, outcome, scheduledAt, now: now() });
  });
}

/** Its writes made in one synchronous section over the row read again: nothing else of this object runs between the read
 *  and the writes, so a revoke, a pause or another commit lands wholly before or wholly after. */
async function commitCheck(deps: Pick<WatchDeps, 'registry' | 'log'>, checked: {
  readonly triggerId: string;
  /** The state the check read. */
  readonly read: JsonValue | undefined;
  readonly outcome: WatchOutcome;
  /** The firing that asked for the check, which keys its fire. */
  readonly scheduledAt: number;
  readonly now: number;
}): Promise<WatchCommit> {
  const { triggerId, read, outcome, scheduledAt, now } = checked;
  const trigger = deps.registry.get(triggerId);

  if (trigger === null || trigger.state !== 'active') return 'dropped';
  const watch = watchOf(trigger);

  // Another commit moved the cursor since this check read it: what it found is measured against an older state.
  if (stableStringify(watch.state ?? null) !== stableStringify(read ?? null)) return 'dropped';

  if (outcome.kind === 'transient') return 'quiet';

  if (outcome.kind === 'deferred') {
    await deps.registry.retime(triggerId, trigger.spec, Math.max(trigger.next_fire_at ?? outcome.until, outcome.until));

    return 'deferred';
  }

  if (outcome.kind === 'parked') {
    const watching: JsonObject = { parked: { reason: outcome.reason, at: now, detail: outcome.detail } };

    if (read !== undefined) watching['state'] = read;
    deps.registry.amendSpec(triggerId, { ...trigger.spec, watch: watching });
    deps.registry.pause(triggerId, now);

    return 'parked';
  }

  const { answer } = outcome;
  const next = answer.state ?? read;

  // A cursor that moved back is a check that saw less than the one before it: nothing it found is new.
  if (movesBack(read, next)) return 'quiet';

  if (stableStringify(next ?? null) !== stableStringify(read ?? null)) {
    deps.registry.amendSpec(triggerId, { ...trigger.spec, watch: next === undefined ? {} : { state: next } });
  }

  if (!answer.fire) return 'quiet';
  const label = trigger.spec['label'];

  deps.log.publish({
    descriptor: {
      ingress: 'timer_alarm',
      variant: 'timer',
      payload: {
        trigger_id: triggerId,
        scheduled_fire_at: scheduledAt,
        ...(typeof label === 'string' && { label }),
        ...(trigger.spec['payload'] !== undefined && { user_payload: trigger.spec['payload'] }),
        ...(typeof trigger.spec['mission_label'] === 'string' && { mission_label: trigger.spec['mission_label'] }),
        watch_brief: answer.brief,
      },
      trigger_creator_trust: trigger.creator_trust,
    },
    now,
  });

  return 'fired';
}
