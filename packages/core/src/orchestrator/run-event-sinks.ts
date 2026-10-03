/** An actor's run-ledger sinks, recorded against its open run as its claim ledger reads it. */
import type { BoundActor } from '../state/actor-host';
import type { RunEventInput } from '../events/types';
import type { TurnSinks } from './turn-accumulator';

/** No active run drops the event: a row keyed on '' joins every actor. */
function activeRunOf(stores: BoundActor['stores']): string | null {
  return stores.claims.unsettled(1)[0]?.runId ?? null;
}

type HostedRunEvent = Extract<RunEventInput, { type: 'tool_call_end' | 'step_finish' }>;

export function runEventSinks(
  bound: Pick<BoundActor, 'stores'>,
  logActivity: (event: string, detail?: string) => void,
): TurnSinks {
  const recorded = (input: HostedRunEvent): void => {
    const runId = activeRunOf(bound.stores);

    if (runId !== null) bound.stores.eventRecorder.emit(runId, input);
  };

  return {
    logActivity,
    onToolCallEvent: (event) => recorded({ type: 'tool_call_end', ...event }),
    onStepEvent: (event) => recorded({ type: 'step_finish', ...event }),
  };
}
