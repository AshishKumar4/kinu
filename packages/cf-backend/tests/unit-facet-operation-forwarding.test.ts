/**
 * The external transfer used by the facet's durable model-operation outbox.
 * Queueing, retry, and deletion belong to the facet; this boundary only
 * acknowledges a complete parent RPC or rejects.
 */
import { describe, expect, test } from 'bun:test';
import type { ModelOperationEvent } from '@kinu.run/core';

import {
  forwardFacetModelOperation, type FacetOperationTarget,
} from '../src/obs/facet-operations';

const FRAME: ModelOperationEvent = {
  operationId: 'op-7f3a91',
  source: 'mcts',
  op: 'complete',
  phase: 'start',
};

describe('a frame the root accepts', () => {
  test('is handed over whole', async () => {
    const received: ModelOperationEvent[] = [];
    await forwardFacetModelOperation(() => ({
      async reportFacetModelOperation(event) { received.push(event); },
    }), FRAME);

    expect(received).toEqual([FRAME]);
  });
});

describe('a frame that does not arrive', () => {
  test('a refused parent RPC rejects with its original cause', async () => {
    await expect(forwardFacetModelOperation(() => ({
      async reportFacetModelOperation() {
        throw new Error('the root workspace is not accepting calls');
      },
    }), FRAME)).rejects.toThrow('the root workspace is not accepting calls');
  });

  test('an absent parent rejects instead of acknowledging the outbox row', async () => {
    await expect(forwardFacetModelOperation(() => null, FRAME))
      .rejects.toThrow('no parent workspace');
  });

  test('the parent is read for every delivery attempt', async () => {
    const received: ModelOperationEvent[] = [];
    let parent: FacetOperationTarget | null = null;
    await expect(forwardFacetModelOperation(() => parent, FRAME))
      .rejects.toThrow('no parent workspace');

    parent = { async reportFacetModelOperation(event) { received.push(event); } };
    await forwardFacetModelOperation(() => parent, { ...FRAME, phase: 'end' });

    expect(received).toEqual([{ ...FRAME, phase: 'end' }]);
  });
});
