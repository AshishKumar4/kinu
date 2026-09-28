/**
 * An actor's run-ledger sinks: each finished step and tool call is recorded against the actor's open run, read from
 * its claim ledger, so the recording survives an eviction. A hosted actor's host and an agent in its own isolate
 * (whose ledger is in its own database) build the same sinks.
 */
import type { BoundActor } from '../state/actor-host';
import type { RunEventInput } from '../events/types';
import { diagnostics } from '../obs/log';
import { toKinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { Effect } from 'effect';
import type { TurnSinks } from './turn-accumulator';

/**
 * The actor's newest unsettled claim, read from the ledger so it survives eviction.
 * No active run drops the event: a row keyed on '' would join to every actor.
 */
function activeRunOf(stores: BoundActor['stores']): string | null {
  return stores.claims.unsettled(1)[0]?.runId ?? null;
}

type HostedRunEvent = Extract<RunEventInput, { type: 'tool_call_end' | 'step_finish' }>;

/** Written out so a lost recording stays greppable. */
const RUN_EVENT_EMIT_FAILED = {
  tool_call_end: 'event.tool_call_end_emit_failed',
  step_finish: 'event.step_finish_emit_failed',
} as const;

export function runEventSinks(
  bound: Pick<BoundActor, 'stores' | 'handle'>,
  logActivity: (event: string, detail?: string) => void,
): TurnSinks {
  // A failed recording is reported, never thrown: losing an event must not end the turn.
  const recorded = (input: HostedRunEvent) => Effect.try({
    try: () => {
      const runId = activeRunOf(bound.stores);

      if (runId !== null) bound.stores.eventRecorder.emit(runId, input);
    },
    catch: (cause) => toKinuError({ doing: `recording a hosted actor ${input.type} run event`, cause, otherwise: 'io' }),
  }).pipe(Effect.catch((failure) => Effect.sync(() => {
    diagnostics.failure(RUN_EVENT_EMIT_FAILED[input.type], failure, { actor: bound.handle.name });
  })));

  return {
    logActivity,
    onToolCallEvent: (event) => settleSync(recorded({ type: 'tool_call_end', ...event })),
    onStepEvent: (event) => settleSync(recorded({ type: 'step_finish', ...event })),
  };
}
