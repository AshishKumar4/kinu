// Drives the shipped `Devbox` class with an in-memory R2 binding and a model of its chain:
// what the box asks of the chain is the subject here; disk-chain-image.test.ts runs the real one.
import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import * as v from 'valibot';

import { DiskChainStateSchema, type DiskChain, type DiskChainPorts } from '../../src/disk-chain';
import { attempt } from '../../src/errors';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../../src/lifecycle';
import type { DevboxStore, StoredValue } from '../../src/storage';
import { Devbox, harness } from './devbox-harness';
import type { FakeSandbox } from './devbox-harness';

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
      yield* attempt('io', () => ports.writeState({ format: 'disk-chain/2', rev: (state?.rev ?? 0) + 1, base: { key: 'base', bytes: 1, committedAt: at }, deltas: [], committedAt: at }, state?.rev ?? null));
      asked.push(`commit ${kind}`);

      return { kind: 'committed', reason: undefined, bytes: 1, movedBytes: 1 };
    }),
  };
}

/** In-memory bucket over the objects the container's store mount writes; `head` and `delete`
 *  answer as the R2 binding does, so the shipped `layerIntegrityFailure` runs unchanged. */
function memoryBucket(objects: Map<string, Uint8Array>): R2Bucket {
  // SAFETY: constructed against the R2Bucket contract. The box reaches the
  // four members below and nothing else — `mountBucket` is what exposes the
  // prefix to the container, and the archive travels through that mount — so
  // the rest of the surface is unreachable from this fixture's box.
  return Object.create({
    head: async (key: string) => {
      const bytes = objects.get(key);

      if (bytes === undefined) return null;

      return {
        key,
        size: bytes.byteLength,
        version: createHash('sha256').update(bytes).digest('hex'),
        checksums: { sha256: await crypto.subtle.digest('SHA-256', bytes.slice()) },
      };
    },
    get: async (key: string) => {
      const bytes = objects.get(key);

      return bytes === undefined ? null : { key, size: bytes.byteLength, body: new Response(bytes).body };
    },
    // R2 refuses a delete of no keys or of more than 1,000 (10027), and lists 1,000 at a time.
    delete: async (keys: string | string[]) => {
      const named = Array.isArray(keys) ? keys : [keys];

      if (named.length === 0 || named.length > 1000) throw new Error('delete: The number of keys in the request must be between 1 and 1000 inclusive. (10027)');

      for (const key of named) objects.delete(key);
    },
    // A cursor names the last key listed, so a page deleted in between does not shift the next one.
    list: async (options?: R2ListOptions) => {
      const after = options?.cursor ?? '';
      const matching = [...objects.keys()].filter((key) => key.startsWith(options?.prefix ?? '') && key > after).sort();
      const page = matching.slice(0, 1000);
      const truncated = page.length < matching.length;

      const listed = page.map((key) => ({ key }));

      return truncated ? { objects: listed, truncated, cursor: page.at(-1) } : { objects: listed, truncated };
    },
  });
}

export interface ChainBox {
  readonly box: ChainTestBox;
  readonly container: FakeSandbox;
  readonly rows: Map<string, StoredValue>;
  readonly objects: Map<string, Uint8Array>;
  /** The platform evicts the object while its container runs on: a new instance over the same
   *  storage, container and bucket, holding nothing in memory. */
  readonly evict: () => ChainTestBox;
}

/** The shipped policy with a test-length probe: nothing here is about budgets,
 *  and ambient checkpoints are off so a test's own commits are the only ones. */
export class ChainTestBox extends Devbox<Record<string, never>> {
  #store: DevboxStore | undefined;

  /** Wired after construction, because the harness creates the container the
   *  bucket's objects are shared with while constructing the box. */
  useStore(store: DevboxStore): void {
    this.#store = store;
  }

  protected override get store(): DevboxStore | undefined {
    return this.#store;
  }

  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override diskChain(ports: DiskChainPorts): DiskChain {
    return modelChain(ports);
  }
}

export function chainBox(Box: typeof ChainTestBox = ChainTestBox): ChainBox {
  const { box, container, rows, state } = harness(Box);
  const objects = new Map<string, Uint8Array>();
  const store = { binding: 'BACKUP_BUCKET', bucket: memoryBucket(objects) };
  box.useStore(store);

  const evict = (): ChainTestBox => {
    const successor = new Box(state, {});
    successor.useStore(store);
    container.owner = successor;

    return successor;
  };

  return { box, container, rows, objects, evict };
}
