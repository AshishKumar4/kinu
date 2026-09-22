// Drives the shipped strategy through the shipped `Devbox` class with an in-memory R2 binding.
// Bucket and store mount share one map so container writes and DO reads cannot disagree.
import { createHash } from 'node:crypto';

import { chainStoreRoot, normalizeChainState } from '../../src/snapshot-chain';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../../src/lifecycle';
import type { DevboxStore, StoredValue } from '../../src/storage';
import { Devbox, TEST_BOX_ID, harness } from './devbox-harness';
import type { FakeSandbox } from './devbox-harness';

export function chainHead(rows: Map<string, StoredValue>): string | null {
  return normalizeChainState(rows.get('devbox:storage-state'))?.base.id ?? null;
}

/** In-memory bucket over the objects the container's store mount writes; `head` and `delete`
 *  answer as the R2 binding does, so the shipped `layerIntegrityFailure` runs unchanged. */
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
