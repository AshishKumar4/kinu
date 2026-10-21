/**
 * Where a computer's process run as a job ends, as its box tells it (`process-ended`). The end is the job's own outcome:
 * told, it settles the job's row before anything else (`complete`), so an incident acknowledged has its end kept, then
 * releases the job's waiting promise, whose own settle then finds the row settled and adds nothing. A promise asked of a
 * job whose row has settled answers at once; one asked before the row exists (the job is still being adopted) waits.
 */
import type { ComputerProcessEnd } from './sandbox';

/** Where a job's row stands: not made yet, running, or settled. */
export type ComputerProcessJobState = 'missing' | 'running' | 'settled';

/** A job row's status, as the register reads it: `undefined` for a row not made yet. */
export function jobState(status: string | undefined): ComputerProcessJobState {
  if (status === undefined) return 'missing';

  return status === 'running' ? 'running' : 'settled';
}

/** What the register reads and writes of a job: its row, through the runner that holds it. */
export interface ComputerProcessJobRows {
  state(jobId: string): ComputerProcessJobState;
  /** The job's row settled with its process's end, and its agent woken; nothing for a job no longer running. */
  complete(jobId: string, end: ComputerProcessEnd): Promise<void>;
}

/** A job's promise waiting for its process's end. */
interface Waiting {
  readonly promise: Promise<ComputerProcessEnd>;
  resolve(end: ComputerProcessEnd): void;
}

/** What a promise asked of a settled job answers: its row holds the end, and this answer is recorded nowhere. */
const SETTLED_ALREADY: ComputerProcessEnd = { tail: '' };

export class ComputerProcessEnds {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly jobs: ComputerProcessJobRows) {}

  /** Where the job's row stands. */
  state(jobId: string): ComputerProcessJobState {
    return this.jobs.state(jobId);
  }

  /** The job's process's end: when the box tells it, or at once for a job whose row has settled. */
  ended(jobId: string): Promise<ComputerProcessEnd> {
    if (this.jobs.state(jobId) === 'settled') return Promise.resolve(SETTLED_ALREADY);
    const waiting: Waiting = this.waiting.get(jobId) ?? Promise.withResolvers<ComputerProcessEnd>();
    this.waiting.set(jobId, waiting);

    return waiting.promise;
  }

  /** What the box told of `jobId`'s process's end: onto its row first, then to its waiting promise. */
  async record(jobId: string, end: ComputerProcessEnd): Promise<void> {
    await this.jobs.complete(jobId, end);
    const waiting = this.waiting.get(jobId);

    this.waiting.delete(jobId);
    waiting?.resolve(end);
  }
}
