/** One runner per hired actor: its turns serial, actors concurrent, no count cap. */

import type { WorkspaceActor } from '../identity/workspace-actors';
import { toKinuError, type KinuError } from '../obs/error';

export interface DelegatedTurnRunnerDeps {
  /** True: budget cut it short. */
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

  private startActorRunner(record: WorkspaceActor): void {
    const id = record.actorId;

    if (this.actorRunners.has(id)) {
      this.again.add(id);

      return;
    }

    const runner = (async () => {
      try {
        let again = true;

        while (again) {
          this.again.delete(id);
          again = await this.deps.pass(record) || this.again.has(id);
        }
      } catch (cause) {
        this.deps.failed(record, toKinuError({ doing: 'reading a hired actor\'s admitted delegations', cause, otherwise: 'io' }));
      } finally {
        this.actorRunners.delete(id);
      }
    })();

    this.actorRunners.set(id, runner);
  }

  private holdLane(): void {
    if (this.lane !== null || this.actorRunners.size === 0) return;

    this.lane = (async () => {
      try {
        await this.deps.holdLane(async () => {
          for (let live = [...this.actorRunners.values()]; live.length > 0; live = [...this.actorRunners.values()]) {
            await Promise.all(live);
          }
        });
      } catch (cause) {
        this.deps.failed(null, toKinuError({ doing: 'draining the delegated turns this workspace admitted', cause, otherwise: 'io' }));
      } finally {
        this.lane = null;
        this.holdLane();
      }
    })();
  }
}
