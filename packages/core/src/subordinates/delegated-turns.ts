
import type { WorkspaceActor } from '../identity/workspace-actors';
import { Effect } from 'effect';
import type { KinuError } from '../obs/error';
import { attempt, settle } from '../obs/effect';

/** Raising it is the owner's call (NESTED-HIRE-0926). */
export const DELEGATED_TURN_SLOTS = 1;

export interface DelegatedTurnRunnerDeps {
  readonly slots: number;
  pass(record: WorkspaceActor): Promise<boolean>;
  holdLane(body: () => Promise<void>): Promise<void>;
  failed(record: WorkspaceActor | null, error: KinuError): void;
}

export class DelegatedTurnRunners {
  private readonly actorRunners = new Map<string, Promise<void>>();

  private readonly again = new Set<string>();

  private lane: Promise<void> | null = null;

  private readonly queued: (() => void)[] = [];

  private free: number;

  private readonly stops = new Map<string, number>();

  constructor(private readonly deps: DelegatedTurnRunnerDeps) {
    this.free = deps.slots;
  }

  start(records: readonly WorkspaceActor[]): void {
    for (const record of records) this.startActorRunner(record);

    this.holdLane();
  }

  async turn(actorId: string, body: () => Promise<void>): Promise<void> {
    const queuedAt = this.stops.get(actorId) ?? 0;

    await this.acquire();

    try {
      if ((this.stops.get(actorId) ?? 0) === queuedAt) await body();
    } finally {
      this.release();
    }
  }

  /** Settles once no runner is left. */
  async idle(): Promise<void> {
    while (this.lane !== null) await this.lane;
  }

  /** A Stop skips these actors' queued turns. */
  cancelQueued(actorIds: readonly string[]): void {
    for (const id of actorIds) this.stops.set(id, (this.stops.get(id) ?? 0) + 1);
  }

  private async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
    } else {
      const turn = Promise.withResolvers<void>();
      this.queued.push(turn.resolve);
      await turn.promise;
    }
  }

  private release(): void {
    const next = this.queued.shift();

    if (next === undefined) this.free += 1;
    else next();
  }

  private startActorRunner(record: WorkspaceActor): void {
    const id = record.actorId;

    if (this.actorRunners.has(id)) {
      this.again.add(id);

      return;
    }

    const runner = this.runActor(record, id);

    this.actorRunners.set(id, runner);
  }

  private holdLane(): void {
    if (this.lane !== null || this.actorRunners.size === 0) return;

    this.lane = this.runLane();
  }

  runActor(record: WorkspaceActor, id: string): Promise<void> {
    return settle(attempt({ doing: 'reading a hired actor\'s admitted delegations', otherwise: 'io' }, async () => {
      let again = true;

      while (again) {
        this.again.delete(id);
        again = await this.deps.pass(record) || this.again.has(id);
      }
    }).pipe(
      Effect.catch((failure) => Effect.sync(() => { this.deps.failed(record, failure); })),
      Effect.ensuring(Effect.sync(() => { this.actorRunners.delete(id); })),
    ));
  }

  runLane(): Promise<void> {
    return settle(attempt({ doing: 'draining the delegated turns this workspace admitted', otherwise: 'io' }, () =>
      this.deps.holdLane(async () => {
        for (let live = [...this.actorRunners.values()]; live.length > 0; live = [...this.actorRunners.values()]) {
          await Promise.all(live);
        }
      })).pipe(
      Effect.catch((failure) => Effect.sync(() => { this.deps.failed(null, failure); })),
      Effect.ensuring(Effect.sync(() => {
        this.lane = null;
        this.holdLane();
      })),
    ));
  }
}
