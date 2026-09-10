// A box with a store, on the platform stand-in: the shipped strategy driven
// through the shipped class, end to end.
//
// WHY THIS IS ONE FIXTURE. `snapshot-chain.test.ts` substitutes the strategy's
// ports, so it cannot see a defect in how the CLASS orders them across a drive
// — the attach, the commit, the stop and the discard are composed in
// `Devbox.#chainPorts` and its lifecycle, not in the strategy. The
// devbox-harness runs the class over a faithful container; this module adds the
// one thing a durable box asks of the platform beyond that container — the R2
// binding the Durable Object side reads and verifies against — and nothing
// else.
//
// THE BUCKET AND THE STORE MOUNT ARE ONE MAP. The container publishes an
// archive by writing THROUGH its prefix-scoped mount (`dd conv=fsync`), and the
// Durable Object then reads that object's size and digest back through the
// binding. Two maps would let a test pass while the two halves disagreed, which
// is the whole class of defect this fixture exists to catch.
import { createHash } from 'node:crypto';

import { chainStoreRoot, normalizeChainState } from '../../src/snapshot-chain';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../../src/lifecycle';
import type { DevboxStore, StoredValue } from '../../src/storage';
import { Devbox, TEST_BOX_ID, harness } from './devbox-harness';
import type { FakeSandbox } from './devbox-harness';

/** The generation the durable chain record names, or null before a publish. */
export function chainHead(rows: Map<string, StoredValue>): string | null {
  return normalizeChainState(rows.get('devbox:storage-state'))?.base.id ?? null;
}

/**
 * The bucket binding, in memory, over the objects the container's own store
 * mount writes.
 *
 * The chain ports reach exactly these members: `head` for the layer identity
 * check (size, the store's per-upload version and the sha256 R2 records for a
 * single PUT), `delete` for a discard and the orphan sweep. Each answers what
 * the R2 binding answers, so the shipped `layerIntegrityFailure` runs unchanged
 * against it.
 */
function memoryBucket(objects: Map<string, Uint8Array>): R2Bucket {
  // SAFETY: constructed against the R2Bucket contract. The chain reaches the
  // three members below and nothing else — `mountBucket` is what exposes the
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
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    list: async (options?: R2ListOptions) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .map((key) => ({ key })),
      truncated: false,
    }),
  });
}

/** One box, its container, its durable rows and the objects both sides see. */
export interface ChainBox {
  readonly box: ChainTestBox;
  readonly container: FakeSandbox;
  readonly rows: Map<string, StoredValue>;
  readonly objects: Map<string, Uint8Array>;
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
}

export function chainBox(): ChainBox {
  const { box, container, rows } = harness(ChainTestBox);
  const objects = new Map<string, Uint8Array>();
  container.chainStore = { objects, root: chainStoreRoot(`boxes/${TEST_BOX_ID}`) };
  box.useStore({ binding: 'BACKUP_BUCKET', bucket: memoryBucket(objects) });

  return { box, container, rows, objects };
}
