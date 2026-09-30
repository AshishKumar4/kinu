/** An actor's run-ledger sinks, recorded against its open run as its claim ledger reads it. */
import type { BoundActor } from '../state/actor-host';
import type { RunEventInput } from '../events/types';
import { diagnostics } from '../obs/log';
import { toKinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { Effect } from 'effect';
import type { TurnSinks } from './turn-accumulator';

/** No active run drops the event: a row keyed on '' joins every actor. */
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
