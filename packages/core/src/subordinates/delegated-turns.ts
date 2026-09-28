
import type { WorkspaceActor } from '../identity/workspace-actors';
import { Effect } from 'effect';
import type { KinuError } from '../obs/error';
import { attempt, settle } from '../obs/effect';

/** One runner per hired agent: its own turns in order, every agent's at once (owner, 2026-09-26: no limit). */
export interface DelegatedTurnRunnerDeps {
  pass(record: WorkspaceActor): Promise<boolean>;
  holdLane(body: () => Promise<void>): Promise<void>;
  failed(record: WorkspaceActor | null, error: KinuError): void;
}

export class DelegatedTurnRunners {
  private readonly actorRunners = new Map<string, Promise<void>>();

  private readonly again = new Set<string>();

  private lane: Promise<void> | null = null;

  constructor(private readonly deps: DelegatedTurnRunnerDeps) {}

  start(records: readonly WorkspaceActor[]): void {
    for (const record of records) this.startActorRunner(record);

    this.holdLane();
  }

  /** Settles once no runner is left. */
  async idle(): Promise<void> {
    while (this.lane !== null) await this.lane;
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
