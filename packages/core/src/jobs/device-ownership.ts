/**
 * Who owns the durable device requests ONE tool invocation issues.
 *
 * A laptop `exec` registers its command on the user's device under a request
 * identity, and that identity is what a cancellation names. So the identity has
 * an owner, and the owner decides which cancel reaches the command: the TURN
 * while the call is in the foreground, and the background JOB once the call has
 * auto-detached past the threshold.
 *
 * Per invocation and not per turn, because one turn can hold several parallel
 * device commands and only the detaching call changes hands. A turn-wide
 * handover would move requests that never detached, and the job-scoped cancel
 * that follows would then kill work the foreground is still waiting on.
 *
 * TWO PHASES, AND THEY WORK DIFFERENTLY ON PURPOSE.
 *
 * Before the handoff, every reported id accumulates here and the detach
 * transfers that set — one owner change per row that already exists on the
 * device side, so a refused transfer is a real failure and fails the whole
 * handoff (a job that cannot cancel its own device work must not run).
 *
 * After the handoff, NOTHING is transferred. The owner travels with the call
 * instead: `owningJobId` is read at exec time, so a request issued after the
 * detach is INSERTed already job-owned. Chasing those ids with a second
 * transfer cannot work — `execution/device-tunnel-executor.ts` mints the
 * identity and reports it (lines 290-291) BEFORE the `rpc('exec', …)` that
 * inserts the row (line 299), so a transfer fired from the reporter races its
 * own INSERT and a not-found answer would mean nothing.
 */

/** What a TOOL CALL may do with its holder: report what it issued, and read who
 *  owns it right now. Deliberately narrower than the holder — the claim is the
 *  runner's, at exactly one moment. */
export interface DeviceRequestChannel {
  /** Synchronous by contract: the executor calls this inside its own exec frame,
   *  before the request frame leaves for the device, and cannot handle a
   *  rejection. */
  report(requestId: string): void;
  /** The background job that owns this invocation's device work, or null while
   *  the call is still in the foreground. MUST be read per exec call, never
   *  captured: a detach can happen between two execs of the same invocation. */
  readonly owningJobId: string | null;
}

export class DeviceRequestOwnership implements DeviceRequestChannel {
  #issued: string[] = [];
  #owningJobId: string | null = null;

  /** A bound property, not a method: the sink is handed out bare through the
   *  tool-options bag and called with no receiver. */
  readonly report = (requestId: string): void => {
    // Once a job owns this invocation, a later id needs no accumulation — it is
    // registered job-owned at its own INSERT, and nothing reads this set again.
    if (this.#owningJobId !== null) return;
    this.#issued.push(requestId);
  };

  get owningJobId(): string | null {
    return this.#owningJobId;
  }

  /**
   * Hand this invocation to a job and take the ids issued before that moment —
   * the set whose owner the caller must now transfer.
   *
   * ONE synchronous step, and the ORDER inside it is the fix. The owner flips
   * first because it has to be visible to any report that lands while the
   * transfer is still in flight; the take happens in the same tick because an
   * id reported between a read and a later claim would fall through BOTH paths
   * — outside the frozen set, and inserted turn-owned into a turn that is over.
   */
  drain(jobId: string): readonly string[] {
    this.#owningJobId = jobId;
    const issued = this.#issued;
    this.#issued = [];
    return issued;
  }
}
