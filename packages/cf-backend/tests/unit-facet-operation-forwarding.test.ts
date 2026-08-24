/**
 * How an exploration facet's model-operation frames reach the root workspace,
 * and what happens when they do not.
 *
 * A facet has no durable log of its own, so these frames are forwarded over one
 * root RPC. That makes the forwarding an instrument, and an instrument nobody
 * asserts on is one nobody notices has stopped: `void parent.reportFacet…(event)`
 * discarded the rejection, and on workerd an unhandled rejection is a line in a
 * stream with no request attached to it — so a root that had stopped accepting
 * frames was indistinguishable from one receiving every frame while a whole
 * search's spend went unexplained.
 *
 * Driven through the forwarder rather than through `ExplorationAgent`, because
 * the only interesting behaviour here is a refused hand-off and a Durable Object
 * cannot be asked to refuse one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ModelOperationEvent } from '@kinu.run/core';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordingLogger,
} from '@kinu.run/core/obs';

import {
  forwardFacetModelOperations, type FacetOperationTarget,
} from '../src/obs/facet-operations';

const FRAME: ModelOperationEvent = {
  operationId: 'op-7f3a91',
  source: 'mcts',
  op: 'complete',
  phase: 'start',
};

let logs: RecordingLogger;

beforeEach(() => {
  logs = createRecordingLogger();
  setDiagnosticsSink(logs);
});

afterEach(() => { setDiagnosticsSink(createRecordingLogger()); });

/** One tick, so a rejection handled on the microtask queue has run before the
 *  assertions read the sink. The sink is synchronous by contract, so the RPC it
 *  starts settles after it returns — which is the whole reason the rejection had
 *  somewhere to go missing. */
async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('a frame the root accepts', () => {
  test('is handed over whole, and nothing is reported', async () => {
    const received: ModelOperationEvent[] = [];
    const forward = forwardFacetModelOperations(() => ({
      async reportFacetModelOperation(event) { received.push(event); },
    }));

    forward(FRAME);
    await settled();

    expect(received).toEqual([FRAME]);
    // No line at all on the happy path: a forwarder that logged unconditionally
    // would make the failure assertions below pass for the wrong reason.
    expect(logs.emitted).toEqual([]);
  });
});

describe('a frame that does not arrive', () => {
  test('a refused hand-off is recorded with its class and the frame’s identity', async () => {
    const forward = forwardFacetModelOperations(() => ({
      async reportFacetModelOperation() {
        throw new Error('the root workspace is not accepting calls');
      },
    }));

    forward(FRAME);
    await settled();

    expect(logs.emitted).toHaveLength(1);
    const line = logs.emitted[0];
    expect(line?.event).toBe('event.model_operation_emit_failed');
    expect(line?.code).toBe('io');
    expect(line?.cause).toContain('forwarding a model_operation frame to the root workspace');
    // The rejection's own words survive under ours: without them the line names
    // the instrument and not the fault.
    expect(line?.cause).toContain('not accepting calls');
    // Which frame, so a search whose spend does not add up can be traced to the
    // operations that never reached the ledger.
    expect(line?.fields).toEqual({ operationId: 'op-7f3a91', phase: 'start', source: 'mcts' });
  });

  test('an absent parent is reported through the same event, not silently dropped', async () => {
    const forward = forwardFacetModelOperations(() => null);

    forward(FRAME);
    await settled();

    expect(logs.emitted).toHaveLength(1);
    expect(logs.emitted[0]?.event).toBe('event.model_operation_emit_failed');
    expect(logs.emitted[0]?.code).toBe('io');
    expect(logs.emitted[0]?.cause).toContain('no parent workspace');
    expect(logs.emitted[0]?.fields).toEqual({ operationId: 'op-7f3a91', phase: 'start', source: 'mcts' });
  });

  test('the parent is read per frame, so one seeded after construction is used', async () => {
    // The thunk's reason: `_cf_initAsFacet` seeds the parent after every field
    // initializer has run, so a forwarder holding a value captured at
    // construction would report every frame as parentless forever.
    const received: ModelOperationEvent[] = [];
    let parent: FacetOperationTarget | null = null;
    const forward = forwardFacetModelOperations(() => parent);

    forward(FRAME);
    await settled();
    expect(logs.emitted).toHaveLength(1);

    parent = { async reportFacetModelOperation(event) { received.push(event); } };
    forward({ ...FRAME, phase: 'end' });
    await settled();

    expect(received).toEqual([{ ...FRAME, phase: 'end' }]);
    expect(logs.emitted).toHaveLength(1);
  });
});
