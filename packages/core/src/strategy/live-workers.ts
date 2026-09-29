import type { SpawnedHead } from '../heads/controller';
import { OWNER_STOPPED } from '../heads/types';

type Stop = () => void | Promise<void>;

/** Each running swarm worker's own stop, by its head id; one registry per workspace object. */
export class LiveWorkers {
  readonly #stops = new Map<string, Stop>();

  /** Returns the release, called once the worker settles. */
  register(id: string, stop: Stop): () => void {
    this.#stops.set(id, stop);

    return () => {
      if (this.#stops.get(id) === stop) this.#stops.delete(id);
    };
  }

  /** Does nothing when no worker by that id is running. */
  async stop(id: string): Promise<void> {
    await this.#stops.get(id)?.();
  }
}

/** The reason a worker's own signal carries when its owner stopped it. */
const OWNER_STOP = new Error(OWNER_STOPPED);

export interface WorkerSignal {
  readonly signal: AbortSignal;
  readonly stop: () => void;
}

/** A signal of the worker's own, aborted by its Stop or by the search's. */
export function workerSignal(search: AbortSignal | undefined): WorkerSignal {
  const own = new AbortController();

  return {
    signal: search === undefined ? own.signal : AbortSignal.any([search, own.signal]),
    stop: () => { own.abort(OWNER_STOP); },
  };
}

/** Whether `signal` was aborted by its owner's Stop, not with its search. */
export function stoppedByOwner(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === OWNER_STOP;
}

/** A branch head registered while its run is in flight; its Stop is the head's own abort. */
export function liveHead(workers: LiveWorkers, head: SpawnedHead): SpawnedHead {
  return {
    id: head.id,
    abort: (reason) => head.abort(reason),
    run: () => {
      const release = workers.register(head.id, () => head.abort(OWNER_STOPPED));

      return head.run().finally(release);
    },
  };
}
