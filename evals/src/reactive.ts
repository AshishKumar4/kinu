/**
 * The reactive-user eval's rules (docs/EVOLUTION-REDESIGN.md §8): learning on must beat learning off. The user's reply
 * is decided by the task's checks, so satisfaction follows what the agent did. `reactive-run.ts` drives the deployment.
 */
import { Seeded } from '../tasks/seeded';

/** The window §8 judges on, and the only segments the held-out family appears in. */
export const LAST_SEGMENTS = 50;

/** A thumb on one reply in ten. */
export const THUMB_RATE = 0.1;

/** Two-sided 95% t quantiles for 1..10 degrees of freedom. */
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];

/** The seeded order of families, the same for both arms; the held-out family only in the last segments. */
export function reactivePlan(families: readonly string[], segments: number, seed: number, heldOut: string): string[] {
  const rng = new Seeded(seed);
  const trained = families.filter((family) => family !== heldOut);

  if (trained.length === 0) throw new Error('no family is left to learn from');

  return Array.from({ length: segments }, (_, at) => rng.pick(at < segments - LAST_SEGMENTS ? trained : families));
}

/** The user's next message after a checked reply: a correction naming what failed, then the request again, then none. */
export function reactiveReply(prompt: string, failed: readonly string[], attempt: number): string | null {
  if (failed.length === 0 || attempt >= 2) return null;

  return attempt === 0 ? `That isn't right yet: ${failed.join(', ')} ${failed.length === 1 ? 'fails' : 'fail'}.` : prompt;
}

export interface SegmentResult {
  readonly family: string;
  readonly passed: boolean;
  readonly replies: number;
  readonly toolErrors: number;
  readonly steps: number;
  readonly thumbs: number;
}

export interface ArmRun {
  readonly arm: string;
  readonly seed: number;
  readonly segments: readonly SegmentResult[];
  /** Mean rated satisfaction over the last segments; null when none was rated. */
  readonly lastSatisfaction: number | null;
  readonly spend: unknown;
}

export interface Interval { readonly mean: number; readonly lo: number; readonly hi: number }

/** Mean and two-sided 95% interval over seeds; one seed has no interval. */
export function seedInterval(diffs: readonly number[]): Interval {
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / Math.max(1, n);

  if (n < 2) return { mean, lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY };
  const sd = Math.sqrt(diffs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1));
  const half = (T95[n - 2] ?? 1.96) * sd / Math.sqrt(n);

  return { mean, lo: mean - half, hi: mean + half };
}

const rate = (segments: readonly SegmentResult[], pick: (s: SegmentResult) => number) => segments.reduce((sum, s) => sum + pick(s), 0) / Math.max(1, segments.length);

/** §8's rule over seeds; reverting each kept promotion on a copy of the final state is not measured here. */
export function learningVerdict(runs: readonly { readonly on: ArmRun; readonly off: ArmRun; readonly heldOut: string }[]) {
  const last = (run: ArmRun) => run.segments.slice(-LAST_SEGMENTS);
  const diff = (pick: (run: ArmRun) => number) => seedInterval(runs.map(({ on, off }) => pick(on) - pick(off)));
  const passRate = diff((run) => rate(last(run), (s) => Number(s.passed)));
  const satisfied = diff((run) => run.lastSatisfaction ?? Number.NaN);
  const toolErrors = diff((run) => rate(last(run), (s) => s.toolErrors / Math.max(1, s.replies)));
  const steps = diff((run) => rate(last(run), (s) => s.steps / Math.max(1, s.replies)));

  const heldOutPass = seedInterval(runs.map(({ on, off, heldOut }) => {
    const of = (run: ArmRun) => rate(last(run).filter((s) => s.family === heldOut), (s) => Number(s.passed));

    return of(on) - of(off);
  }));

  return {
    passRate, satisfaction: satisfied, toolErrors, steps, heldOutPass,
    wins: passRate.lo > 0 && satisfied.lo > 0 && toolErrors.mean <= 0 && steps.mean <= 0 && heldOutPass.mean >= 0,
  };
}
