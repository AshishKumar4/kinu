// Drives the shipped `Devbox` class with an in-memory R2 binding and a model of its chain:
// what the box asks of the chain is the subject here; the deploy tier runs the real one.
import { Effect } from 'effect';
import * as v from 'valibot';

import { DiskChainStateSchema, type DiskChain, type DiskChainPorts } from '../../src/disk-chain';
import { attempt } from '../../src/errors';
import { TestDevbox } from './test-devbox';
import type { StoredValue } from '../../src/storage';
import { harness, type FakeSandbox, type FakeStorage, type TestEnv, type TestSiblings } from './devbox-harness';

/** The disk chain record's revision, or null before the first commit. */
export function chainHead(rows: Map<string, StoredValue>): number | null {
  const parsed = v.safeParse(DiskChainStateSchema, rows.get('devbox:disk-chain'));

  return parsed.success ? parsed.output.rev : null;
}

/** What the box asked of its chain, in order. */
export const asked: string[] = [];

/** Commits a one-layer record; attaches from it, from a snapshot, or empty. It reaches the store
 *  mount where the real chain does: before a commit, and before a recovery. */
function modelChain(ports: DiskChainPorts): DiskChain {
  return {
    attach: (fromSnapshot) => Effect.gen(function* () {
      asked.push(`attach from ${fromSnapshot ? 'snapshot' : 'image'}`);

      if (fromSnapshot) return { kind: 'attached', detail: 'disk', recoveredTo: undefined };
      const state = yield* attempt('io', () => ports.readState());

      if (state === null) return { kind: 'empty', detail: 'no record', recoveredTo: undefined };
      yield* attempt('io', () => ports.mountStore());

      return { kind: 'attached', detail: 'lazy', recoveredTo: state.committedAt };
    }),
    commit: (kind) => Effect.gen(function* () {
      const state = yield* attempt('io', () => ports.readState());
      const at = ports.now();
      yield* attempt('io', () => ports.mountStore());
      yield* attempt('io', () => ports.writeState({ format: 'disk-chain/2', rev: (state?.rev ?? 0) + 1, base: { key: 'base', bytes: 1, committedAt: at, digest: { sha256: '0'.repeat(64), partBytes: 1 } }, deltas: [], committedAt: at }, state?.rev ?? null));
      asked.push(`commit ${kind}`);

      return { kind: 'committed', reason: undefined, bytes: 1, movedBytes: 1 };
    }),
  };
}

export interface ChainBox {
  readonly box: ChainTestBox;
  readonly container: FakeSandbox;
  readonly rows: Map<string, StoredValue>;
  readonly objects: Map<string, Uint8Array>;
  readonly env: TestEnv;
  readonly storage: FakeStorage;
  /** The platform evicts the object while its container runs on: a new instance over the same
   *  storage, container and bucket, holding nothing in memory. */
  readonly evict: () => ChainTestBox;
}

/** The shipped policy with a test-length probe: nothing here is about budgets,
 *  and ambient checkpoints are off so a test's own commits are the only ones. */
export class ChainTestBox extends TestDevbox<TestEnv> {
  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override diskChain(ports: DiskChainPorts): DiskChain {
    return modelChain(ports);
  }
}

export function chainBox(Box: typeof ChainTestBox = ChainTestBox, siblings?: TestSiblings): ChainBox {
  const { box, container, rows, objects, env, state, storage } = harness(Box, undefined, undefined, siblings);

  const evict = (): ChainTestBox => {
    const successor = new Box(state, env);
    container.owner = successor;

    return successor;
  };

  return { box, container, rows, objects, env, storage, evict };
}
