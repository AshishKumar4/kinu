/**
 * Where a computer's process run as a job ends, as its box tells it (`process-ended`): the job's own promise waits here.
 * Told while the promise waits, the end settles it through the job's settle path. Told while none does (its object
 * restarted and the job is not yet resumed), the job's runner settles its row with the end (`complete`), so the fact is
 * the job's own and nothing else keeps it. A resume after that finds the row settled, and returns at once.
 */
import type { ComputerProcessEnd } from './sandbox';

/** What the register reads and writes of a job: its row, through the runner that holds it. */
export interface ComputerProcessJobRows {
  /** Whether the job still runs, as its row says. */
  running(jobId: string): boolean;
  /** The job's row settled with its process's end, and its agent woken; nothing for a job no longer running. */
  complete(jobId: string, end: ComputerProcessEnd): Promise<void>;
}

/** A job's promise waiting for its process's end. */
interface Waiting {
  readonly promise: Promise<ComputerProcessEnd>;
  resolve(end: ComputerProcessEnd): void;
}

/** An end a resume reads where its job settled before it: the row holds the end; this answer is not recorded. */
const SETTLED_ALREADY: ComputerProcessEnd = { tail: '' };

export class ComputerProcessEnds {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly jobs: ComputerProcessJobRows) {}

  /** The job's process's end: when the box tells it, or at once for a job whose row has settled. */
  ended(jobId: string): Promise<ComputerProcessEnd> {
    if (!this.jobs.running(jobId)) return Promise.resolve(SETTLED_ALREADY);
    const waiting: Waiting = this.waiting.get(jobId) ?? Promise.withResolvers<ComputerProcessEnd>();
    this.waiting.set(jobId, waiting);

    return waiting.promise;
  }

  /** What the box told of `jobId`'s process's end: to its waiting promise, or onto its row. */
  async record(jobId: string, end: ComputerProcessEnd): Promise<void> {
    const waiting = this.waiting.get(jobId);

    if (waiting === undefined) return await this.jobs.complete(jobId, end);
    this.waiting.delete(jobId);
    waiting.resolve(end);
  }
}
