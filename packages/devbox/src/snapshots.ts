/** D65 lineage ownership: wake selection, publication, and deletion share one owner. */
import * as v from 'valibot';
import { attemptSync, settleSync } from './errors';
import { OwedSchema, SNAPSHOT_LIFE_MS, payDebt, type Owed, type SnapshotRegistry } from './snapshot-registry';

const SNAPSHOT_KEY = 'devbox:snapshot';

const DEAD_SNAPSHOTS_KEY = 'devbox:dead-snapshots';

const WOKE_FROM_KEY = 'devbox:woke-from';

const Record = v.object({
  id: v.string(), image: v.string(), chainRev: v.number(), takenAt: v.number(), lineage: v.array(v.string()),
  rootTakenAt: v.number(),
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
  /** Moves at each supersede: a save whose take began before one was superseded with what it read. */
  #lineage = 0;
  constructor(readonly ports: Ports) {}

  get record(): v.InferOutput<typeof Record> | null {
    const held = this.ports.kv.get(SNAPSHOT_KEY);

    if (held === undefined) return null;

    return settleSync(attemptSync('io', () => v.parse(Record, held), 'Corrupt devbox snapshot record'));
  }

  wake(): string | undefined {
    const held = this.record;
    const rev = this.ports.chainRev();

    if (held === null || held.image !== this.ports.base() || Date.now() - held.rootTakenAt > SNAPSHOT_LIFE_MS) return undefined;

    return rev !== undefined && rev > held.chainRev ? undefined : held.id;
  }

  started(own?: string): void { this.ports.kv.put(WOKE_FROM_KEY, own ?? ''); }

  /** The own snapshot the running container was started from, none for a golden start: kept in storage, so a start over
   *  that container after the object was reset still knows its root holds the workspace. */
  wokeFrom(): string | undefined {
    const own = this.ports.kv.get<string>(WOKE_FROM_KEY);

    return own === undefined || own === '' ? undefined : own;
  }

  /**
   * An image or golden start ends the old lineage; a wake from its own save extends it. A lineage superseded while the
   * take ran (a discard, a cutover) makes the snapshot owed for deletion, never the next wake: it holds what was
   * discarded.
   */
  async save(): Promise<void> {
    const rev = this.ports.chainRev();
    const held = this.record;
    const parent = held !== null && held.id === this.wokeFrom() ? held : undefined;
    const lineage = this.#lineage;
    const snapshot = await this.ports.take();
    const takenAt = Date.now();

    if (lineage !== this.#lineage) {
      this.#owe([snapshot.id]);

      return;
    }

    if (parent === undefined) this.supersede();
    this.ports.kv.put(SNAPSHOT_KEY, {
      id: snapshot.id, image: this.ports.base(), chainRev: rev ?? 0, takenAt,
      lineage: parent === undefined ? [] : [...parent.lineage, parent.id], rootTakenAt: parent === undefined ? takenAt : parent.rootTakenAt,
    });
  }

  /** A take still under way is given up: when it lands it is owed for deletion, never the next wake, as a superseded
   *  one is. The snapshot this box already holds stays. */
  abandon(): void {
    this.#lineage += 1;
  }

  supersede(): void {
    const held = this.record;

    this.#lineage += 1;

    if (held === null) return;
    this.#owe([...held.lineage, held.id]);
    this.ports.kv.delete(SNAPSHOT_KEY);
  }

  /** Dead snapshots are owed a deletion at once. */
  #owe(ids: readonly string[]): void {
    const owed = this.#dead();
    const now = Date.now();

    this.ports.kv.put(DEAD_SNAPSHOTS_KEY, [...owed, ...ids.filter((id) => !owed.some((dead) => dead.ref === id)).map((ref) => ({ ref, at: now }))]);
  }

  #dead(): readonly Owed[] {
    const dead = v.safeParse(v.array(OwedSchema), this.ports.kv.get(DEAD_SNAPSHOTS_KEY));

    return dead.success ? dead.output : [];
  }

  /** `wipe` deletes the box's storage; the snapshots still owed a deletion stay recorded, for a sweep to pay. */
  async keepingOwed(wipe: () => Promise<void>): Promise<void> {
    const owed = this.#dead();

    await wipe();

    if (owed.length > 0) this.ports.kv.put(DEAD_SNAPSHOTS_KEY, owed);
  }

  /** A failed deletion never holds a wake or save, and stays owed for the next sweep. */
  sweep(): Promise<void> { return this.#sweeping ??= this.#sweep().finally(() => { this.#sweeping = undefined; }); }

  async #sweep(): Promise<void> {
    const registry = this.ports.registry();

    if (registry === undefined) return;
    await payDebt({
      read: () => this.#dead(), write: (owed) => { this.ports.kv.put(DEAD_SNAPSHOTS_KEY, owed); }, delete: (ref, owe) => registry.delete(ref, owe),
      now: () => Date.now(), called: 'the dead snapshot',
    });
  }
}
