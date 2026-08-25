/**
 * The statistics the report is allowed to make. Pure, so both the in-container
 * probe and the driver compute them the same way, and so the gate self-test can
 * pin them without a container.
 *
 * One rule shapes everything here: a number is reported with its dispersion or
 * it is not reported. "Run repetitions until variance is stated" is the
 * acceptance criterion, and a mean with no spread beside it cannot distinguish
 * a layout that is slow from a layout that is unpredictable — which, for a
 * workspace filesystem, is the more important of the two.
 */

export interface Summary {
  /** How many observations. Zero is reported, never silently skipped. */
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
  /** Sample standard deviation (n-1). Zero when n < 2. */
  readonly stddev: number;
  /** stddev / mean. The dispersion figure the report states. */
  readonly cv: number;
}

export const EMPTY_SUMMARY: Summary = {
  n: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0, stddev: 0, cv: 0,
};

/**
 * Nearest-rank percentile on the sorted sample. Nearest-rank rather than
 * interpolated because an interpolated p95 of six observations invents a value
 * no operation actually took, and these samples are often small by nature (a
 * 100 MiB write is not run a thousand times).
 */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const rank = Math.ceil(q * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return EMPTY_SUMMARY;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  const variance = n < 2
    ? 0
    : sorted.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / (n - 1);
  const stddev = Math.sqrt(variance);
  return {
    n,
    min: sorted[0]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[n - 1]!,
    mean,
    stddev,
    cv: mean === 0 ? 0 : stddev / mean,
  };
}

/**
 * Whether a sample is dispersed enough that its central value should not be
 * compared against another arm's without saying so. The threshold is a
 * REPORTING rule, not a pass/fail gate: a coefficient of variation above 0.25
 * means the arms may be indistinguishable at this repetition count, and the
 * report says that instead of ranking them.
 */
export const UNSTABLE_CV = 0.25;

export function isUnstable(summary: Summary): boolean {
  return summary.n >= 2 && summary.cv > UNSTABLE_CV;
}

/**
 * Throughput in MiB/s from a byte count and a duration. Returns 0 for a
 * zero-length measurement rather than Infinity, because Infinity in a report
 * table is a formatting accident that reads as a result.
 */
export function throughputMiBs(bytes: number, ms: number): number {
  if (ms <= 0) return 0;
  return (bytes / (1024 * 1024)) / (ms / 1000);
}

/**
 * Ratio of a candidate to the control, guarded so a missing control reads as
 * "no comparison" instead of a division artefact. Greater than 1 means slower.
 */
export function slowdown(candidate: number, control: number): number | null {
  if (control <= 0 || candidate <= 0) return null;
  return candidate / control;
}

/**
 * A deterministic 32-bit PRNG. Every random offset, file name and byte pattern
 * in the benchmark comes from a seeded generator, so two runs of the same
 * revision touch the same offsets in the same order. Without this, "4 KiB
 * random read p95" is a different experiment on every invocation and comparing
 * two arms compares two workloads.
 *
 * mulberry32: small, and its cycle far exceeds any sample here.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic offsets, aligned to `blockBytes`, covering `count` draws over a
 * file of `fileBytes`. Aligned because an unaligned 4 KiB read spans two blocks
 * and measures a different thing on every filesystem in the comparison.
 */
export function randomOffsets(
  fileBytes: number,
  blockBytes: number,
  count: number,
  seed: number,
): number[] {
  const blocks = Math.max(1, Math.floor(fileBytes / blockBytes));
  const next = mulberry32(seed);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(Math.floor(next() * blocks) * blockBytes);
  return offsets;
}
