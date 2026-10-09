/** D65 lineage ownership: wake selection, publication, and deletion share one owner. */
import * as v from 'valibot';
import type { SnapshotRegistry } from './snapshot-registry';

const SNAPSHOT_KEY = 'devbox:snapshot';

const DEAD_SNAPSHOTS_KEY = 'devbox:dead-snapshots';

const WOKE_FROM_KEY = 'devbox:woke-from';

const LIFE_MS = 29 * 24 * 60 * 60 * 1000;

const Record = v.object({
  id: v.string(), image: v.string(), chainRev: v.number(), takenAt: v.number(), lineage: v.optional(v.array(v.string()), []),
  rootTakenAt: v.optional(v.number()),
});

interface Ports {
  readonly kv: DurableObjectStorage['kv'];
  readonly base: () => string;
  readonly chainRev: () => number | undefined;
  readonly take: () => Promise<{ readonly id: string }>;
  readonly registry: () => SnapshotRegistry | undefined;
}

export class Snapshots {
  #sweeping: Promise<void> | undefined;
  constructor(readonly ports: Ports) {}

  get record(): v.InferOutput<typeof Record> | null {
    const held = v.safeParse(Record, this.ports.kv.get(SNAPSHOT_KEY));

    return held.success ? held.output : null;
  }

  wake(): string | undefined {
    const held = this.record;
    const rev = this.ports.chainRev();

    if (held === null || held.image !== this.ports.base() || Date.now() - (held.rootTakenAt ?? held.takenAt) > LIFE_MS) return undefined;

    return rev !== undefined && rev > held.chainRev ? undefined : held.id;
  }

  started(own?: string): void { this.ports.kv.put(WOKE_FROM_KEY, own ?? ''); }

  /** An image or golden start ends the old lineage; a wake from its own save extends it. */
  async save(): Promise<void> {
    const rev = this.ports.chainRev();
    const held = this.record;
    const parent = held !== null && held.id === this.ports.kv.get(WOKE_FROM_KEY) ? held : undefined;
    const snapshot = await this.ports.take();
    const takenAt = Date.now();

    if (parent === undefined) this.supersede();
    this.ports.kv.put(SNAPSHOT_KEY, {
      id: snapshot.id, image: this.ports.base(), chainRev: rev ?? 0, takenAt,
      lineage: parent === undefined ? [] : [...parent.lineage, parent.id], rootTakenAt: parent === undefined ? takenAt : parent.rootTakenAt ?? parent.takenAt,
    });
  }

  supersede(): void {
    const held = this.record;

    if (held === null) return;
    this.ports.kv.put(DEAD_SNAPSHOTS_KEY, [...new Set([...this.#dead(), ...held.lineage, held.id])]);
    this.ports.kv.delete(SNAPSHOT_KEY);
  }

  #dead(): readonly string[] {
    const dead = v.safeParse(v.array(v.string()), this.ports.kv.get(DEAD_SNAPSHOTS_KEY));

    return dead.success ? dead.output : [];
  }

  /** A failed deletion never holds a wake or save, and stays owed for the next sweep. */
  sweep(): Promise<void> { return this.#sweeping ??= this.#sweep().finally(() => { this.#sweeping = undefined; }); }

  async #sweep(): Promise<void> {
    const registry = this.ports.registry();

    if (registry === undefined) return;

    for (const id of this.#dead()) {
      const outcome = await registry.delete(id);

      if (outcome.kind === 'refused') {
        console.error(`[devbox] the dead snapshot ${id} was not deleted: ${outcome.reason}`);
      }

      // Its tags gone, the manifest is found by its digest alone, so the debt is the digest from here on.
      const owed = outcome.kind === 'refused' ? [outcome.left ?? id] : [];

      this.ports.kv.put(DEAD_SNAPSHOTS_KEY, this.#dead().flatMap(dead => dead === id ? owed : [dead]));
    }
  }
}
