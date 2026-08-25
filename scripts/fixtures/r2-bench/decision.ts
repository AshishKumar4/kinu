/**
 * The decision rule, and the pricing that makes a tick comparable to a dollar.
 *
 * Kept separate from the driver because it is arithmetic over recorded rows and
 * nothing else: it takes measured ticks and returns a verdict, so it can be
 * tested without a deployment and cannot quietly consult anything the report
 * does not show. Every threshold here is a CHOSEN threshold, named as such by
 * the research that set it, and the experiment exists to measure the ratio
 * rather than to confirm it.
 */

/** R2 published pricing, developers.cloudflare.com/r2/pricing. Class A is the
 *  write class (PUT, LIST, multipart part upload and completion); Class B is the
 *  read class (GET, HEAD). Deletes are billed at nothing and still counted, so
 *  small-file churn stays visible. */
export const R2_CLASS_A_USD_PER_MILLION = 4.5;
export const R2_CLASS_B_USD_PER_MILLION = 0.36;

export interface TickRecord {
  /** Which workload produced it: `npm`, `npm-excluded`, `git` or `sqlite`. */
  readonly arm: string;
  readonly workload: string;
  /** Segment name from the workload program, so a tick is attributable. */
  readonly segment: string;
  readonly wallMs: number;
  readonly classA: number;
  readonly classB: number;
  readonly classFree: number;
  /**
   * Bytes this tick MOVED, from the strategy's own `movedBytes`.
   *
   * THREE-VALUED ON PURPOSE. A committed tick reports what it staged. A SKIPPED
   * tick reports 0, because a skip knows it moved nothing. A FAILED tick reports
   * `null`, because it may have landed blobs before throwing and genuinely cannot
   * say — and r2fs reports `null` always, since s3fs uploads when the last handle
   * closes so no bytes attribute to a commit boundary.
   *
   * `null` means CANNOT ANSWER and must never be coerced to 0. Collapsing them
   * would let an unanswerable tick contribute a confident zero to a total, which
   * is the silent-misreading class this instrument exists to refuse.
   */
  readonly bytesPut: number | null;
  /** Cumulative durable bytes HELD after the tick. A different quantity: it can
   *  FALL across a fold or rebase, which is why differencing it is invalid and why
   *  this benchmark no longer derives a per-tick cost from it. */
  readonly heldBytes: number | null;
  /** Whether this tick could answer at all. False mirrors `bytesPut === null`. */
  readonly movedReported: boolean;
  /** What the strategy itself says it moved: journal entries for a
   *  content-addressed arm, delta bytes for a chain. Absent when the arm's
   *  checkpoint reported neither, which is a finding rather than a zero. */
  readonly unitsMoved: number | null;
  readonly unitLabel: string;
  readonly outcome: string;
}

export interface WorkloadTotals {
  readonly workload: string;
  readonly ticks: number;
  readonly sumWallMs: number;
  readonly p50WallMs: number;
  readonly p95WallMs: number;
  readonly classA: number;
  readonly classB: number;
  readonly classFree: number;
  /** Sum over ticks that COULD answer. Meaningless without `unanswerable`. */
  readonly bytesPut: number;
  /** How many ticks could not answer. A total drawn from 3 of 5 ticks is not the
   *  workload's cost, and printing it without this number would imply it was. */
  readonly unanswerable: number;
  /** False when NO tick could answer, so the renderer prints "not measurable"
   *  rather than a byte total — a sum of absences is 0, and 0 is a claim. */
  readonly movedReported: boolean;
  readonly usd: number;
}


const percentile = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  // Nearest-rank on the sorted sample. No interpolation, because an interpolated
  // p95 over six ticks invents a value between two real measurements.
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
};

export function priceOps(classA: number, classB: number): number {
  return (classA / 1_000_000) * R2_CLASS_A_USD_PER_MILLION
    + (classB / 1_000_000) * R2_CLASS_B_USD_PER_MILLION;
}

/**
 * Did the op counter actually see this workload's work?
 *
 * A tick that moved bytes MUST have issued at least one class-A operation: bytes
 * reach R2 through a PUT or a multipart part, and there is no third way. So
 * `bytesPut > 0` with zero operations of every class is not a cheap arm, it is a
 * BLIND INSTRUMENT, and the two are indistinguishable from the numbers alone.
 *
 * MEASURED: a full run reported 536 MiB PUT against classA=0 on every arm and
 * every workload. The mechanism is that the tally batches per isolate and only
 * pushes at a threshold, while the explicit flush drains whichever isolate serves
 * the flush — so a Durable-Object-side checkpoint under that threshold tallies
 * where nothing reads it. Priced at face value that would have published $0.00
 * as the cost of half a gigabyte, which is a plausible wrong number and
 * therefore worse than an absent one.
 */
export function opsAreBlind(ticks: readonly TickRecord[], workload: string): boolean {
  const mine = ticks.filter((tick) => tick.workload === workload);
  if (mine.length === 0) return false;
  const bytes = mine.reduce((acc, tick) => acc + (tick.bytesPut ?? 0), 0);
  const ops = mine.reduce((acc, tick) => acc + tick.classA + tick.classB + tick.classFree, 0);
  return bytes > 0 && ops === 0;
}

export function totalsFor(ticks: readonly TickRecord[], workload: string): WorkloadTotals {
  const mine = ticks.filter((tick) => tick.workload === workload);
  const walls = mine.map((tick) => tick.wallMs).sort((a, b) => a - b);
  const sum = (pick: (tick: TickRecord) => number): number =>
    mine.reduce((acc, tick) => acc + pick(tick), 0);
  const classA = sum((tick) => tick.classA);
  const classB = sum((tick) => tick.classB);
  return {
    workload,
    ticks: mine.length,
    sumWallMs: sum((tick) => tick.wallMs),
    p50WallMs: percentile(walls, 0.5),
    p95WallMs: percentile(walls, 0.95),
    classA,
    classB,
    classFree: sum((tick) => tick.classFree),
    bytesPut: mine.reduce((acc, tick) => acc + (tick.bytesPut ?? 0), 0),
    unanswerable: mine.filter((tick) => tick.bytesPut === null).length,
    movedReported: mine.some((tick) => tick.bytesPut !== null),
    usd: priceOps(classA, classB),
  };
}

export type DecisionVerdict =
  | { readonly kind: 'o-p-wins'; readonly detail: string }
  | { readonly kind: 'chain-stays'; readonly detail: string }
  | { readonly kind: 'inconclusive'; readonly reason: string };

/**
 * The rule, applied to measured ticks and to nothing else.
 *
 *   ratio(w) = Σ ticks(chain, w) / Σ ticks(candidate, w)
 *   ratio(git) ≥ 10 AND ratio(npm) ≥ 3  ⇒ the O(p) shape wins outright
 *   both ratios < 3                     ⇒ O(c) ticks are not the bottleneck
 *
 * Anything between those is INCONCLUSIVE and says so. A rule that returned a
 * winner for every input would not be a rule, and the gap between the two
 * thresholds is the region the research deliberately left undecided.
 *
 * An arm with no ticks on a workload cannot be a denominator, so the verdict is
 * inconclusive naming the missing arm rather than dividing by zero and calling
 * an unmeasured arm infinitely better.
 */
export function decide(
  ticks: readonly TickRecord[],
  chainArm: string,
  candidateArm: string,
): DecisionVerdict {
  const sumFor = (arm: string, workload: string): number =>
    ticks.filter((tick) => tick.arm === arm && tick.workload === workload)
      .reduce((acc, tick) => acc + tick.wallMs, 0);
  const countFor = (arm: string, workload: string): number =>
    ticks.filter((tick) => tick.arm === arm && tick.workload === workload).length;

  const ratios: Record<string, number> = {};
  for (const workload of ['git', 'npm'] as const) {
    if (countFor(chainArm, workload) === 0) {
      return { kind: 'inconclusive', reason: `${chainArm} produced no ${workload} ticks` };
    }
    if (countFor(candidateArm, workload) === 0) {
      return { kind: 'inconclusive', reason: `${candidateArm} produced no ${workload} ticks` };
    }
    const candidate = sumFor(candidateArm, workload);
    if (candidate <= 0) {
      return {
        kind: 'inconclusive',
        reason: `${candidateArm} reported ${candidate} ms of ${workload} tick time, which cannot be a denominator`,
      };
    }
    ratios[workload] = sumFor(chainArm, workload) / candidate;
  }

  const git = ratios['git']!;
  const npm = ratios['npm']!;
  const measured = `git ${git.toFixed(2)}x, npm ${npm.toFixed(2)}x`;
  if (git >= 10 && npm >= 3) {
    return {
      kind: 'o-p-wins',
      detail: `${measured} — clears the 10x/3x bar, so tick cost tracks pending change and ${candidateArm} becomes default`,
    };
  }
  if (git < 3 && npm < 3) {
    return {
      kind: 'chain-stays',
      detail: `${measured} — below 3x on both, so O(c) tick cost is not the bottleneck and ${chainArm} stays default`,
    };
  }
  return {
    kind: 'inconclusive',
    reason: `${measured} — between the thresholds the rule deliberately leaves undecided`,
  };
}

/**
 * The sqlite arm's separate question: does file granularity re-ship the whole
 * database per tick?
 *
 * This decides nothing about the default. It decides whether extent-level
 * tracking is ever worth building, and the research is explicit that a
 * whole-file re-ship here is to be recorded rather than treated as
 * disqualifying.
 */
export function sqliteFinding(ticks: readonly TickRecord[], dbBytes: number): string {
  const mine = ticks.filter((tick) => tick.workload === 'sqlite' && tick.segment.startsWith('sqlite-rewrite'));
  if (mine.length === 0) return 'no sqlite rewrite ticks were recorded';
  // A tick that cannot answer is excluded rather than counted as zero; a median
  // over coerced zeros would understate the re-ship and read as good news.
  const perTick = mine.flatMap((tick) => (tick.bytesPut === null ? [] : [tick.bytesPut]));
  if (perTick.length === 0) {
    return `${mine.length} sqlite rewrite tick(s) recorded, none able to report bytes moved, `
      + 'so the re-ship ratio is unknown on this arm';
  }
  const median = perTick.slice().sort((a, b) => a - b)[Math.floor(perTick.length / 2)]!;
  if (dbBytes <= 0) {
    return `median ${(median / 1024 / 1024).toFixed(1)} MiB PUT per rewrite tick; the database size was not measured, `
      + 'so the re-ship ratio is unknown';
  }
  const ratio = median / dbBytes;
  const verdict = ratio > 0.5
    ? 'file granularity re-ships essentially the whole database per tick, so extent-level tracking is the only thing that would help here'
    : 'the tick moves materially less than the whole database, so file granularity is not re-shipping it and extent-level tracking buys less than expected';
  return `median ${(median / 1024 / 1024).toFixed(1)} MiB PUT per rewrite tick against a `
    + `${(dbBytes / 1024 / 1024).toFixed(1)} MiB database (${(ratio * 100).toFixed(0)}%) — ${verdict}`;
}
