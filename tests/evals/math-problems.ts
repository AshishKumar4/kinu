/**
 * The math family's instances: each a pure function of a run seed, each answer exact (an integer or a
 * reduced fraction), graded on `answer.txt` with no model or judge in the scoring path. Beside its one
 * caller, math.eval.ts.
 */
import * as v from 'valibot';
import type { EvalCase, JsonObject } from '../../packages/core/src/index';
import { seededRandom } from '../../packages/core/src/index';
import {
  HARD_TASK_BUDGET, outcomeRow, subgoalsOutcome, type EvalScoreRow, type EvalSubgoal,
} from '@kinu.run/test-utils';

export const MATH_TASK_ENV = 'math-task';

export const MATH_ANSWER_FILE = 'answer.txt';

export const FLOAT_EXACT_LIMIT = 2n ** 53n;

const MODULUS = 1_000_000_007n;

export const MATH_KINDS = [
  'recurrence', 'sigma-sum', 'pell', 'spanning-trees', 'dice', 'lattice', 'prime-sum', 'totient-sum', 'squarefree',
] as const;

export type MathKind = (typeof MATH_KINDS)[number];

export type MathNotation = 'integer' | 'fraction';

export interface MathSeedFile {
  readonly path: string;
  readonly content: string;
}

export interface MathProblem {
  readonly id: string;
  readonly kind: MathKind;
  readonly seed: number;
  readonly statement: string;
  readonly files: readonly MathSeedFile[];
  readonly answer: string;
  readonly notation: MathNotation;
  readonly params: JsonObject;
}

type Rand = () => number;

function randInt(rand: Rand, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** One stream per kind, so adding a kind never moves another kind's instance. */
function kindRand(seed: number, kind: MathKind): Rand {
  const index = MATH_KINDS.indexOf(kind);

  return seededRandom((Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(index + 1, 0xc2b2ae35)) >>> 0);
}

function mod(value: bigint, m: bigint): bigint {
  const r = value % m;

  return r < 0n ? r + m : r;
}

function powMod(base: bigint, exponent: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;

  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }

  return result;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;

  while (y !== 0n) [x, y] = [y, x % y];

  return x;
}


type Matrix3 = readonly [readonly [bigint, bigint, bigint], readonly [bigint, bigint, bigint], readonly [bigint, bigint, bigint]];

function mul3(a: Matrix3, b: Matrix3, m: bigint): Matrix3 {
  const cell = (i: number, j: number): bigint =>
    (a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]) % m;

  return [
    [cell(0, 0), cell(0, 1), cell(0, 2)],
    [cell(1, 0), cell(1, 1), cell(1, 2)],
    [cell(2, 0), cell(2, 1), cell(2, 2)],
  ];
}

/** a_n mod m for a_n = c1·a_{n−1} + c2·a_{n−2} + c3·a_{n−3}, by 3×3 matrix power. */
export function solveRecurrence(
  c: readonly [bigint, bigint, bigint], a: readonly [bigint, bigint, bigint], n: bigint, m: bigint,
): bigint {
  if (n < 3n) return mod(a[Number(n)], m);
  let power: Matrix3 = [[1n, 0n, 0n], [0n, 1n, 0n], [0n, 0n, 1n]];
  let base: Matrix3 = [[mod(c[0], m), mod(c[1], m), mod(c[2], m)], [1n, 0n, 0n], [0n, 1n, 0n]];
  let e = n - 2n;

  while (e > 0n) {
    if (e & 1n) power = mul3(power, base, m);
    base = mul3(base, base, m);
    e >>= 1n;
  }

  return mod(power[0][0] * a[2] + power[0][1] * a[1] + power[0][2] * a[0], m);
}

function recurrenceProblem(seed: number): MathProblem {
  const rand = kindRand(seed, 'recurrence');
  const c = [randInt(rand, 1, 999), randInt(rand, 1, 999), randInt(rand, 1, 999)] as const;
  const a = [randInt(rand, 0, 999), randInt(rand, 0, 999), randInt(rand, 0, 999)] as const;
  const n = BigInt(randInt(rand, 100_000_000, 999_999_999)) * 1_000_000_000n + BigInt(randInt(rand, 0, 999_999_999));
  const answer = solveRecurrence([BigInt(c[0]), BigInt(c[1]), BigInt(c[2])], [BigInt(a[0]), BigInt(a[1]), BigInt(a[2])], n, MODULUS);

  return {
    id: 'math-recurrence', kind: 'recurrence', seed, notation: 'integer', files: [],
    statement: [
      `A sequence is defined by a_0 = ${String(a[0])}, a_1 = ${String(a[1])}, a_2 = ${String(a[2])} and, for n >= 3,`,
      `    a_n = ${String(c[0])}*a_(n-1) + ${String(c[1])}*a_(n-2) + ${String(c[2])}*a_(n-3).`,
      `Compute a_N mod 1000000007 for N = ${String(n)}.`,
    ].join('\n'),
    answer: String(answer),
    params: { c1: c[0], c2: c[1], c3: c[2], a0: a[0], a1: a[1], a2: a[2], n: String(n) },
  };
}


/** Σσ(k) = Σ d·⌊N/d⌋, over the blocks where ⌊N/d⌋ is constant. */
export function solveSigmaSum(n: bigint): bigint {
  let total = 0n;
  let d = 1n;

  while (d <= n) {
    const q = n / d;
    const last = n / q;
    total += q * ((d + last) * (last - d + 1n) / 2n);
    d = last + 1n;
  }

  return total;
}

function sigmaSumProblem(seed: number): MathProblem {
  const rand = kindRand(seed, 'sigma-sum');
  const n = BigInt(randInt(rand, 100_000, 999_999)) * 1_000_000n + BigInt(randInt(rand, 0, 999_999));

  return {
    id: 'math-sigma-sum', kind: 'sigma-sum', seed, notation: 'integer', files: [],
    statement: [
      'Let sigma(k) be the sum of all positive divisors of k (so sigma(6) = 1 + 2 + 3 + 6 = 12).',
      `Compute S = sigma(1) + sigma(2) + ... + sigma(N) exactly, for N = ${String(n)}.`,
      'Give S itself, not a remainder.',
    ].join('\n'),
    answer: String(solveSigmaSum(n)),
    params: { n: String(n) },
  };
}


function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));

  while (x * x > n) x -= 1n;

  while ((x + 1n) * (x + 1n) <= n) x += 1n;

  return x;
}

/** Fundamental solution of x² − D·y² = 1, from the continued fraction of √D. */
export function solvePell(d: bigint) {
  const a0 = isqrt(d);

  if (a0 * a0 === d) throw new Error(`D = ${String(d)} is a perfect square, so x² − D·y² = 1 has no solution with y > 0`);
  let m = 0n;
  let q = 1n;
  let a = a0;
  let [hPrev, h] = [1n, a0];
  let [kPrev, k] = [0n, 1n];

  while (h * h - d * k * k !== 1n) {
    m = q * a - m;
    q = (d - m * m) / q;
    a = (a0 + m) / q;
    [hPrev, h] = [h, a * h + hPrev];
    [kPrev, k] = [k, a * k + kPrev];
  }

  return { x: h, y: k };
}

/** Fewer digits than this and a search over y finds x before the method matters. */
const PELL_MIN_DIGITS = 12;

function pellProblem(seed: number): MathProblem {
  const rand = kindRand(seed, 'pell');
  let d = randInt(rand, 200, 999);

  for (;;) {
    const root = isqrt(BigInt(d));

    if (root * root !== BigInt(d) && String(solvePell(BigInt(d)).x).length >= PELL_MIN_DIGITS) break;
    d = d === 999 ? 200 : d + 1;
  }

  return {
    id: 'math-pell', kind: 'pell', seed, notation: 'integer', files: [],
    statement: [
      `For D = ${String(d)}, find the smallest integer x > 1 for which some positive integer y satisfies`,
      '    x^2 - D*y^2 = 1.',
      'Give x.',
    ].join('\n'),
    answer: String(solvePell(BigInt(d)).x),
    params: { d },
  };
}


/** Exact determinant by fraction-free (Bareiss) elimination; a row swap flips the sign. */
export function bareissDeterminant(matrix: readonly (readonly bigint[])[]): bigint {
  const a = matrix.map((row) => [...row]);
  const n = a.length;

  if (n === 0) return 1n;
  let sign = 1n;
  let previous = 1n;

  for (let k = 0; k < n - 1; k++) {
    if (a[k][k] === 0n) {
      const swap = a.findIndex((row, r) => r > k && row[k] !== 0n);

      if (swap < 0) return 0n;
      [a[k], a[swap]] = [a[swap], a[k]];
      sign = -sign;
    }

    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) {
        a[i][j] = (a[i][j] * a[k][k] - a[i][k] * a[k][j]) / previous;
      }
    }

    previous = a[k][k];
  }

  return sign * a[n - 1][n - 1];
}

/** Kirchhoff's matrix-tree theorem: any cofactor of the Laplacian over vertices 1..n. */
export function countSpanningTrees(n: number, edges: readonly (readonly [number, number])[]): bigint {
  const size = n - 1;
  const laplacian = Array.from({ length: size }, () => Array.from({ length: size }, () => 0n));

  for (const [u, w] of edges) {
    const i = u - 1;
    const j = w - 1;

    if (i < size) laplacian[i][i] += 1n;

    if (j < size) laplacian[j][j] += 1n;

    if (i < size && j < size) {
      laplacian[i][j] -= 1n;
      laplacian[j][i] -= 1n;
    }
  }

  return bareissDeterminant(laplacian);
}

function spanningTreesProblem(seed: number): MathProblem {
  const rand = kindRand(seed, 'spanning-trees');
  const n = randInt(rand, 18, 22);
  const density = randInt(rand, 45, 65) / 100;
  const present = new Set<string>();
  const edges: [number, number][] = [];

  const add = (u: number, w: number): void => {
    const [lo, hi] = u < w ? [u, w] : [w, u];
    const key = `${String(lo)}-${String(hi)}`;

    if (present.has(key)) return;
    present.add(key);
    edges.push([lo, hi]);
  };

  // A random recursive tree first, so the graph is connected whatever the density draws.
  for (let w = 2; w <= n; w++) add(randInt(rand, 1, w - 1), w);

  for (let u = 1; u <= n; u++) {
    for (let w = u + 1; w <= n; w++) if (rand() < density) add(u, w);
  }

  // Past 2^53, so a float determinant cannot land on the count.
  let count = countSpanningTrees(n, edges);

  while (count <= FLOAT_EXACT_LIMIT) {
    if (edges.length === n * (n - 1) / 2) {
      throw new Error(`the complete graph on ${String(n)} vertices counted ${String(count)} spanning trees, `
        + `not ${String(n)}^${String(n - 2)}: the count itself is wrong`);
    }

    const u = randInt(rand, 1, n);
    const w = randInt(rand, 1, n);

    if (u !== w) add(u, w);
    count = countSpanningTrees(n, edges);
  }

  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const graph = [`${String(n)} ${String(edges.length)}`, ...edges.map(([u, w]) => `${String(u)} ${String(w)}`)].join('\n');

  return {
    id: 'math-spanning-trees', kind: 'spanning-trees', seed, notation: 'integer',
    files: [{ path: 'graph.txt', content: `${graph}\n` }],
    statement: [
      'graph.txt in this workspace describes an undirected simple graph. Its first line is "n m";',
      'each of the next m lines is "u v", an edge between vertices u and v (vertices are 1..n).',
      'How many spanning trees does this graph have? Give the exact count.',
    ].join('\n'),
    answer: String(count),
    params: { n, m: edges.length, density },
  };
}


/** P(sum of `count` fair `sides`-sided dice ≥ target), reduced. */
export function diceAtLeast(count: number, sides: number, target: number) {
  let ways: bigint[] = [1n];

  for (let die = 0; die < count; die++) {
    const next = Array.from({ length: ways.length + sides }, () => 0n);

    for (let sum = 0; sum < ways.length; sum++) {
      if (ways[sum] === 0n) continue;

      for (let face = 1; face <= sides; face++) next[sum + face] += ways[sum];
    }

    ways = next;
  }

  let num = 0n;

  for (let sum = Math.max(0, target); sum < ways.length; sum++) num += ways[sum];
  const den = BigInt(sides) ** BigInt(count);
  const g = gcd(num, den);

  return { num: num / g, den: den / g };
}

const DICE_SIDES = [6, 8, 10, 12, 20] as const;

function diceProblem(seed: number): MathProblem {
  const rand = kindRand(seed, 'dice');
  // At least 25 dice, so sides^count is past 2^53 for every face count offered.
  const count = randInt(rand, 25, 40);
  const sides = DICE_SIDES[randInt(rand, 0, DICE_SIDES.length - 1)];
  const mean = count * (sides + 1) / 2;
  const sd = Math.sqrt(count * (sides * sides - 1) / 12);
  const target = Math.round(mean + (randInt(rand, 50, 200) / 100) * sd);
  const { num, den } = diceAtLeast(count, sides, target);

  return {
    id: 'math-dice', kind: 'dice', seed, notation: 'fraction', files: [],
    statement: [
      `${String(count)} fair ${String(sides)}-sided dice (faces 1..${String(sides)}) are rolled together.`,
      `What is the exact probability that the total is at least ${String(target)}?`,
    ].join('\n'),
    answer: `${String(num)}/${String(den)}`,
    params: { count, sides, target },
  };
}


/** Monotone lattice paths (0,0)→(w,h) avoiding `blocked`, mod m, by inclusion–exclusion over the blocks. */
export function latticePaths(
  w: number, h: number, blocked: readonly (readonly [number, number])[], m: bigint,
): bigint {
  const top = w + h;
  const fact = Array.from({ length: top + 1 }, () => 1n);
  fact[0] = 1n;

  for (let i = 1; i <= top; i++) fact[i] = (fact[i - 1] * BigInt(i)) % m;
  const inverse = Array.from({ length: top + 1 }, () => 1n);
  inverse[top] = powMod(fact[top], m - 2n, m);

  for (let i = top; i > 0; i--) inverse[i - 1] = (inverse[i] * BigInt(i)) % m;

  const choose = (dx: number, dy: number): bigint => (fact[dx + dy] * inverse[dx] % m) * inverse[dy] % m;
  const points = [...blocked].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const reachFirst: bigint[] = [];

  for (const [i, [xi, yi]] of points.entries()) {
    let value = choose(xi, yi);

    for (let j = 0; j < i; j++) {
      const [xj, yj] = points[j];

      if (xj <= xi && yj <= yi) value = mod(value - reachFirst[j] * choose(xi - xj, yi - yj), m);
    }

    reachFirst.push(value);
  }

  let total = choose(w, h);

  for (const [j, [xj, yj]] of points.entries()) {
    if (xj <= w && yj <= h) total = mod(total - reachFirst[j] * choose(w - xj, h - yj), m);
  }

  return total;
}

function latticeProblem(seed: number): MathProblem {
  const rand = kindRand(seed, 'lattice');
  const w = randInt(rand, 50_000, 100_000);
  const h = randInt(rand, 50_000, 100_000);
  const count = randInt(rand, 10, 25);
  const blocked: [number, number][] = [];
  const taken = new Set<string>(['0,0', `${String(w)},${String(h)}`]);

  // Near the diagonal, where most paths run, so every block removes real paths.
  while (blocked.length < count) {
    const x = randInt(rand, 1, w - 1);
    const spread = Math.floor(h / 20);
    const y = Math.min(h - 1, Math.max(1, Math.round(x * h / w) + randInt(rand, -spread, spread)));
    const key = `${String(x)},${String(y)}`;

    if (taken.has(key)) continue;
    taken.add(key);
    blocked.push([x, y]);
  }

  return {
    id: 'math-lattice', kind: 'lattice', seed, notation: 'integer', files: [],
    statement: [
      `Count the lattice paths from (0,0) to (${String(w)},${String(h)}) that move one unit at a time, either right`,
      '(x+1) or up (y+1), and never step on any of these blocked points:',
      blocked.map(([x, y]) => `(${String(x)},${String(y)})`).join(' '),
      'Give the count modulo 1000000007.',
    ].join('\n'),
    answer: String(latticePaths(w, h, blocked, MODULUS)),
    params: { w, h, blocked: blocked.map(([x, y]) => `${String(x)},${String(y)}`).join(' ') },
  };
}


const MOD = 1_000_000_007;

/** Exact in doubles: b splits into 15-bit halves, so no product passes 2^46. */
function mulMod(a: number, b: number): number {
  const high = Math.floor(b / 32_768);

  return (((a * high) % MOD) * 32_768 + a * (b - high * 32_768)) % MOD;
}

/** k(k+1)/2 mod MOD for k < 2^52: the even factor is halved before either is reduced. */
function triangularMod(k: number): number {
  return k % 2 === 0 ? mulMod((k / 2) % MOD, (k + 1) % MOD) : mulMod(k % MOD, ((k + 1) / 2) % MOD);
}

function isqrtNumber(n: number): number {
  let r = Math.floor(Math.sqrt(n));

  while (r * r > n) r -= 1;

  while ((r + 1) * (r + 1) <= n) r += 1;

  return r;
}

/** Σ primes ≤ n mod MOD, by Lucy's sieve over the values ⌊n/i⌋. */
export function primeSumMod(n: number): number {
  const r = isqrtNumber(n);
  const small = new Float64Array(r + 1);
  const large = new Float64Array(r + 1);

  for (let k = 1; k <= r; k++) small[k] = (triangularMod(k) - 1 + MOD) % MOD;

  for (let i = 1; i <= r; i++) large[i] = (triangularMod(Math.floor(n / i)) - 1 + MOD) % MOD;
  const composite = new Uint8Array(r + 1);

  for (let p = 2; p <= r; p++) {
    if (composite[p] === 1) continue;

    for (let m = p * p; m <= r; m += p) composite[m] = 1;
    const below = small[p - 1];
    const square = p * p;
    const lastLarge = Math.min(r, Math.floor(n / square));

    // |p·Δ| < 2^50 is exact in a double, so one reduction per update.
    for (let i = 1; i <= lastLarge; i++) {
      const j = i * p;
      const quotient = j <= r ? large[j] : small[Math.floor(n / j)];
      const next = (large[i] - p * (quotient - below)) % MOD;
      large[i] = next < 0 ? next + MOD : next;
    }

    for (let k = r; k >= square; k--) {
      const next = (small[k] - p * (small[Math.floor(k / p)] - below)) % MOD;
      small[k] = next < 0 ? next + MOD : next;
    }
  }

  return large[1];
}

/** Σφ(k) mod MOD: φ sieved to n^{2/3}, then Φ(v) = v(v+1)/2 − Σ_{d≥2} Φ(⌊v/d⌋). */
export function totientSumMod(n: number): number {
  const limit = Math.min(n, Math.max(1, Math.floor(Math.cbrt(n) ** 2)));
  const phi = new Int32Array(limit + 1);

  for (let i = 0; i <= limit; i++) phi[i] = i;

  for (let p = 2; p <= limit; p++) {
    if (phi[p] !== p) continue;

    for (let m = p; m <= limit; m += p) phi[m] -= phi[m] / p;
  }

  const prefix = new Float64Array(limit + 1);

  for (let i = 1; i <= limit; i++) prefix[i] = (prefix[i - 1] + phi[i]) % MOD;
  const last = Math.floor(n / (limit + 1));
  const big = new Float64Array(last + 1);

  for (let i = last; i >= 1; i--) {
    const top = Math.floor(n / i);
    let total = triangularMod(top);

    for (let d = 2; d <= top;) {
      const q = Math.floor(top / d);
      const upper = Math.floor(top / q);
      const phiSum = q <= limit ? prefix[q] : big[Math.floor(n / q)];
      total = (total - mulMod((upper - d + 1) % MOD, phiSum) + MOD) % MOD;
      d = upper + 1;
    }

    big[i] = total;
  }

  return n <= limit ? prefix[n] : big[1];
}

/** Σ_{d ≤ √n} μ(d)·⌊n/d²⌋. */
export function squarefreeCount(n: number): number {
  const r = isqrtNumber(n);
  const mu = new Int8Array(r + 1).fill(1);
  const composite = new Uint8Array(r + 1);

  for (let p = 2; p <= r; p++) {
    if (composite[p] === 1) continue;

    for (let m = p; m <= r; m += p) {
      if (m !== p) composite[m] = 1;
      mu[m] = -mu[m];
    }

    for (let m = p * p; m <= r; m += p * p) mu[m] = 0;
  }

  let count = 0;

  for (let d = 1; d <= r; d++) {
    if (mu[d] === 0) continue;
    const square = d * d;
    let q = Math.floor(n / square);

    // A double quotient can land one off an integer boundary; the products stay below 2^53.
    while (q * square > n) q -= 1;

    while ((q + 1) * square <= n) q += 1;
    count += mu[d] * q;
  }

  return count;
}

function primeSumProblem(seed: number): MathProblem {
  const rand = kindRand(seed, 'prime-sum');
  const n = randInt(rand, 100_000, 999_999) * 1_000_000 + randInt(rand, 0, 999_999);

  return {
    id: 'math-prime-sum', kind: 'prime-sum', seed, notation: 'integer', files: [],
    statement: [
      `Let P be the sum of all primes p <= N, for N = ${String(n)}.`,
      'Give P mod 1000000007.',
    ].join('\n'),
    answer: String(primeSumMod(n)),
    params: { n },
  };
}

function totientSumProblem(seed: number): MathProblem {
  const rand = kindRand(seed, 'totient-sum');
  const n = randInt(rand, 2_000, 9_999) * 1_000_000 + randInt(rand, 0, 999_999);

  return {
    id: 'math-totient-sum', kind: 'totient-sum', seed, notation: 'integer', files: [],
    statement: [
      "Let phi be Euler's totient function (phi(k) counts the integers 1..k coprime to k).",
      `Compute phi(1) + phi(2) + ... + phi(N) for N = ${String(n)}, and give it mod 1000000007.`,
    ].join('\n'),
    answer: String(totientSumMod(n)),
    params: { n },
  };
}

function squarefreeProblem(seed: number): MathProblem {
  const rand = kindRand(seed, 'squarefree');
  const n = randInt(rand, 10_000_000, 99_999_999) * 1_000_000 + randInt(rand, 0, 999_999);

  return {
    id: 'math-squarefree', kind: 'squarefree', seed, notation: 'integer', files: [],
    statement: [
      'A positive integer is squarefree when no square of a prime divides it (1, 2, 3, 5, 6, 7, 10 are; 4, 8, 9 are not).',
      `How many squarefree integers k satisfy 1 <= k <= N, for N = ${String(n)}? Give the exact count.`,
    ].join('\n'),
    answer: String(squarefreeCount(n)),
    params: { n },
  };
}

const GENERATORS = {
  recurrence: recurrenceProblem,
  'sigma-sum': sigmaSumProblem,
  pell: pellProblem,
  'spanning-trees': spanningTreesProblem,
  dice: diceProblem,
  lattice: latticeProblem,
  'prime-sum': primeSumProblem,
  'totient-sum': totientSumProblem,
  squarefree: squarefreeProblem,
} satisfies Record<MathKind, (seed: number) => MathProblem>;

export function mathProblems(seed: number): MathProblem[] {
  return MATH_KINDS.map((kind) => GENERATORS[kind](seed));
}

const NOTATION_RULE = {
  integer: 'a base-10 integer: digits only, a leading minus sign if negative, no separators, no exponent',
  fraction: 'a fraction p/q in lowest terms, p and q base-10 integers with no separators',
} satisfies Record<MathNotation, string>;

export function mathPrompt(problem: MathProblem): string {
  return [
    problem.statement,
    '',
    `Write the exact answer to ${MATH_ANSWER_FILE} in the workspace root, as ${NOTATION_RULE[problem.notation]}.`,
    `The file is compared exactly and nothing else is read: put only the answer in it, no working and no`,
    'explanation. Compute it however you like.',
  ].join('\n');
}

export function mathTaskCase(problem: MathProblem): EvalCase {
  return {
    id: problem.id,
    task: mathPrompt(problem),
    tags: ['math', problem.kind],
    env: MATH_TASK_ENV,
    params: { seed: problem.seed, ...problem.params },
    budget: { ...HARD_TASK_BUDGET },
  };
}

const SeedSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0xffff_ffff));

/** The problem behind a case, generated from the seed it carries; undefined for other families. */
export function mathProblemFor(task: Pick<EvalCase, 'id' | 'env' | 'params'>): MathProblem | undefined {
  if (task.env !== MATH_TASK_ENV) return undefined;
  const seed = v.safeParse(SeedSchema, task.params?.['seed']);

  if (!seed.success) throw new Error(`${task.id}: a math case carries no numeric params.seed, so its instance cannot be re-derived`);
  const kind = MATH_KINDS.find((candidate) => `math-${candidate}` === task.id);

  return kind === undefined ? undefined : GENERATORS[kind](seed.output);
}

export function checkMathAnswer(problem: MathProblem, written: string | null): EvalSubgoal {
  const what = `${problem.id} (seed ${String(problem.seed)})`;

  if (written === null) return { what, reached: false, detail: `${MATH_ANSWER_FILE} is absent` };
  const text = written.trim();
  const shown = text.length > 80 ? `${text.slice(0, 80)}…` : text;

  if (problem.notation === 'integer') {
    if (!/^-?\d+$/.test(text)) return { what, reached: false, detail: `"${shown}" is not a base-10 integer` };
    const right = BigInt(text) === BigInt(problem.answer);

    return { what, reached: right, detail: right ? `exact: ${problem.answer}` : `"${shown}" is not ${problem.answer}` };
  }

  const parts = /^(-?\d+)\/(\d+)$/.exec(text);

  if (parts === null) return { what, reached: false, detail: `"${shown}" is not a fraction p/q` };
  const [num, den] = [BigInt(parts[1]), BigInt(parts[2])];

  if (den === 0n || gcd(num, den) !== 1n) return { what, reached: false, detail: `"${shown}" is not in lowest terms` };
  const right = `${String(num)}/${String(den)}` === problem.answer;

  return { what, reached: right, detail: right ? `exact: ${problem.answer}` : `"${shown}" is not ${problem.answer}` };
}

/** The `task_outcome` row: one exact subgoal over the answer file the agent left. */
export async function verifyMathProblem(
  problem: MathProblem, files: { readText(path: string): Promise<string | null> },
): Promise<EvalScoreRow> {
  return outcomeRow(subgoalsOutcome([checkMathAnswer(problem, await files.readText(MATH_ANSWER_FILE))]));
}
