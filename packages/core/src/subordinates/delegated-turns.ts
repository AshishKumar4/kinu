
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

  private readonly holders = new Set<string>();

  private readonly queued: (() => void)[] = [];

  private free: number;

  constructor(private readonly deps: DelegatedTurnRunnerDeps) {
    this.free = deps.slots;
  }

  start(records: readonly WorkspaceActor[]): void {
    for (const record of records) this.startActorRunner(record);

    this.holdLane();
  }

  async turn<T>(actorId: string, body: () => Promise<T>): Promise<T> {
    await this.acquire(actorId);

    try {
      return await body();
    } finally {
      this.release(actorId);
    }
  }

  /** Waiting on a delegate frees the slot. */
  async whileWaiting<T>(actorId: string, waited: Promise<T>): Promise<T> {
    if (!this.holders.has(actorId)) return await waited;
    this.release(actorId);

    try {
      return await waited;
    } finally {
      await this.acquire(actorId);
    }
  }

  private async acquire(actorId: string): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
    } else {
      const turn = Promise.withResolvers<void>();
      this.queued.push(turn.resolve);
      await turn.promise;
    }

    this.holders.add(actorId);
  }

  private release(actorId: string): void {
    this.holders.delete(actorId);
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
