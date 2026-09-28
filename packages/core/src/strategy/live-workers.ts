import type { SpawnedHead } from '../heads/controller';

/** Each running swarm worker's own stop, by its head id; one registry per workspace object. */
type Stop = (reason: string) => void | Promise<void>;

export class LiveWorkers {
  readonly #stops = new Map<string, Stop>();

  /** Returns the release, called once the worker settles. */
  register(id: string, stop: Stop): () => void {
    this.#stops.set(id, stop);

    return () => {
      if (this.#stops.get(id) === stop) this.#stops.delete(id);
    };
  }

  /** False when no worker by that id is running. */
  async stop(id: string, reason: string): Promise<boolean> {
    const stop = this.#stops.get(id);

    if (stop === undefined) return false;
    await stop(reason);

    return true;
  }

  ids(): string[] {
    return [...this.#stops.keys()];
  }
}

export interface WorkerSignal {
  readonly signal: AbortSignal;
  readonly stop: (reason: string) => void;
}

/** A signal of the worker's own, aborted by its Stop or by the search's. */
export function workerSignal(search: AbortSignal | undefined): WorkerSignal {
  const own = new AbortController();

  return {
    signal: search === undefined ? own.signal : AbortSignal.any([search, own.signal]),
    stop: (reason) => { own.abort(new Error(reason)); },
  };
}

/** A branch head registered while its run is in flight; its Stop is the head's own abort. */
export function liveHead(workers: LiveWorkers, head: SpawnedHead): SpawnedHead {
  return {
    id: head.id,
    abort: (reason) => head.abort(reason),
    run: () => {
      const release = workers.register(head.id, (reason) => head.abort(reason));

      return head.run().finally(release);
    },
  };
}
