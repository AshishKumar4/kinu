/**
 * Per-invocation owner of device request ids: the turn while foreground, the background job after detach.
 * Ids issued before detach are transferred by the caller; after detach, requests are inserted job-owned
 * via `owningJobId` (transferring them would race their own INSERT).
 */

/** The tool call's view: report issued ids, read the current owner. */
export interface DeviceRequestChannel {
  /** The job this invocation becomes if it outlives its window. */
  readonly jobId: string;
  /** Synchronous: called inside the executor's exec frame, which cannot handle a rejection. */
  report(requestId: string): void;
  /** Owning job, or null while foreground. Read per exec call, never captured: detach can happen between execs. */
  readonly owningJobId: string | null;
  readonly detached: AbortSignal;
}

export class DeviceRequestOwnership implements DeviceRequestChannel {
  constructor(readonly jobId: string) {}

  #issued: string[] = [];
  #owningJobId: string | null = null;
  readonly #detached = new AbortController();

  /** Bound property: handed out bare and called with no receiver. */
  readonly report = (requestId: string): void => {
    // After detach, ids are inserted job-owned; nothing reads this set again.
    if (this.#owningJobId !== null) return;
    this.#issued.push(requestId);
  };

  get owningJobId(): string | null {
    return this.#owningJobId;
  }

  get detached(): AbortSignal {
    return this.#detached.signal;
  }

  /**
   * Hand this invocation to a job and take the ids to transfer. One synchronous step: flipping the owner
   * and taking the set in the same tick keeps a concurrent report from falling through both paths.
   */
  drain(jobId: string): readonly string[] {
    this.#owningJobId = jobId;
    const issued = this.#issued;
    this.#issued = [];
    this.#detached.abort();

    return issued;
  }
}
