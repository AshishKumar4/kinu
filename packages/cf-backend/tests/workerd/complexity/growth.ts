/**
 * How a counted cost grows with a subject's size, judged from the counts alone.
 *
 * Between two sizes n1 < n2 the fitted exponent is ln((c2 + 1) / (c1 + 1)) / ln(n2 / n1): 0 for a
 * cost that stays put, 1 for one that grows with n, 2 for one that grows with n². The +1 keeps a
 * count of zero comparable. A counter fails when its exponent between any two consecutive sizes
 * exceeds its declared class's by more than `EXPONENT_SLACK`, which absorbs a constant term's
 * pull (a+bn fits below 1) but not a term one class up: at a size ratio of 6 an O(n) term on an
 * O(1) declaration reads near 1, four times the slack.
 */
export type GrowthClass = 'O(1)' | 'O(n)' | 'O(n^2)';

const EXPONENT: Readonly<Record<GrowthClass, number>> = { 'O(1)': 0, 'O(n)': 1, 'O(n^2)': 2 };

export const EXPONENT_SLACK = 0.25;

/** One counter's value at each of the subject's sizes, and the class it may not outgrow. */
export interface GrowthCounter {
  readonly name: string;
  readonly declared: GrowthClass;
  readonly values: readonly number[];
}

export interface GrowthFinding {
  readonly counter: string;
  readonly declared: GrowthClass;
  readonly exponent: number;
  readonly from: { readonly size: number; readonly value: number };
  readonly to: { readonly size: number; readonly value: number };
}

export function fittedExponent(sizes: readonly [number, number], values: readonly [number, number]): number {
  return Math.log((values[1] + 1) / (values[0] + 1)) / Math.log(sizes[1] / sizes[0]);
}

/** The steepest exponent a counter shows between consecutive sizes. */
export function steepest(sizes: readonly number[], values: readonly number[]): { readonly exponent: number; readonly at: number } {
  let worst = { exponent: Number.NEGATIVE_INFINITY, at: 0 };

  for (let at = 1; at < sizes.length; at += 1) {
    const exponent = fittedExponent([sizes[at - 1] ?? 0, sizes[at] ?? 0], [values[at - 1] ?? 0, values[at] ?? 0]);

    if (exponent > worst.exponent) worst = { exponent, at };
  }

  return worst;
}

export function judge(sizes: readonly number[], counters: readonly GrowthCounter[]): GrowthFinding[] {
  if (sizes.length < 2 || sizes.some((size, at) => at > 0 && size <= (sizes[at - 1] ?? 0))) {
    throw new Error(`growth needs two or more increasing sizes, got ${JSON.stringify(sizes)}`);
  }

  const findings: GrowthFinding[] = [];

  for (const counter of counters) {
    const { exponent, at } = steepest(sizes, counter.values);

    if (exponent <= EXPONENT[counter.declared] + EXPONENT_SLACK) continue;
    findings.push({
      counter: counter.name,
      declared: counter.declared,
      exponent,
      from: { size: sizes[at - 1] ?? 0, value: counter.values[at - 1] ?? 0 },
      to: { size: sizes[at] ?? 0, value: counter.values[at] ?? 0 },
    });
  }

  return findings;
}
