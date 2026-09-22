/**
 * Hard-task corpus: algorithmic-optimization instances scored by measured oracle count vs a measured reference
 * (continuous, judge-free, `node`-only). Each `lowerBoundOps` is a per-instance certificate bound, not the
 * worst-case adversary bound, so a lucky honest run is never scored as a cheat; the worst-case optimum is the target.
 */
import { ratioTask, type HardTask } from './cost-model';

/** The comparison oracle as harness source; returns a sign so no magnitude leaks. */
const COMPARE_ORACLE = `const oracle = { compare: meter((a, b) => {
  const x = valueOf(a); const y = valueOf(b);
  return x < y ? -1 : x > y ? 1 : 0;
}) };`;

/** The equality oracle; cannot order, so majority/partition tasks must count rather than sort. */
const EQUALS_ORACLE = 'const oracle = { equals: meter((a, b) => valueOf(a) === valueOf(b)) };';

/** `n` distinct hidden values 0..n-1 in shuffled token order, so the k-th smallest is k; leaves `vals` ascending. */
const DISTINCT_TOKENS = `const vals = new Array(P.n);
for (let i = 0; i < P.n; i += 1) vals[i] = i;
const tokens = shuffle(vals.map(tok));`;

const SELECT = { seed: 101, n: 50_000, k: 12_345 };

const SELECT_KTH = ratioTask({
  id: 'hard-select-kth',
  tags: ['hard-task', 'optimization', 'selection'],
  brief: [
    `You are given ${String(SELECT.n)} opaque tokens, each hiding a distinct number, and an`,
    'index k. Return the token holding the k-th smallest value (0-based).',
    '',
    'input:  { tokens: object[], k: number }',
    'oracle: { compare(a, b) -> -1 | 0 | 1 }   the ONLY way to learn anything about a token',
    '',
    'THE TOKENS ARRIVE IN UNIFORMLY RANDOM ORDER — a fresh random permutation, never an',
    'adversarial one — so any contiguous slice of the array is an unbiased sample of the',
    `whole. That is given, not something you have to establish. Here k is ${String(SELECT.k)},`,
    `well away from the middle of ${String(SELECT.n)}.`,
    '',
    'The reference orders everything to answer a question about one position, so it pays',
    'about n*log2(n). Partitioning around one pivot at a time does far better but still',
    'pays a constant times n. The best known cost is lower again — about n plus a term',
    'that shrinks as k moves away from the middle — and closing that gap is what is being',
    'measured.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: SELECT,
    reference: [
      'export function solve(input, oracle) {',
      '  return input.tokens.slice().sort(oracle.compare)[input.k];',
      '}',
    ].join('\n') + '\n',
    body: [
      DISTINCT_TOKENS,
      'const input = { tokens, k: P.k };',
      COMPARE_ORACLE,
      'const decode = (out) => valueOf(out);',
      'emitTrials([trial(input, oracle, decode, P.k)]);',
    ].join('\n'),
    // Measured: `BEST['hard-select-kth']` (sampling selection) on this instance; pivot-at-a-time costs ~3.4n.
    targetOps: 76_737,
    // Every element must be compared at least once.
    lowerBoundOps: SELECT.n - 1,
  },
});

const MAJORITY = { seed: 104, n: 1200 };

const MAJORITY_VOTE = ratioTask({
  id: 'hard-majority-vote',
  tags: ['hard-task', 'optimization', 'counting'],
  brief: [
    `You are given ${String(MAJORITY.n)} opaque tokens. Return the token whose hidden value`,
    'occurs in STRICTLY more than half of them, or null when no value does.',
    '',
    'input:  { tokens: object[] }',
    'oracle: { equals(a, b) -> boolean }   the ONLY way to learn anything about a token.',
    '        No ordering is available: you cannot sort these.',
    '',
    'Apart from the dominant value, every token holds a value of its own that appears',
    'exactly once, so two tokens picked at random are usually unequal.',
    '',
    'You are scored on TWO instances of the same size, summed: one that HAS a majority,',
    'and one whose most common value occupies exactly half the tokens and so is not a',
    'majority. Answering null always, or returning the most common value always, is',
    'wrong on one of the two and scores zero. The reference counts every token against',
    'every other.',
    '',
    'The target is the measured cost of the best algorithm known for this oracle, about',
    '1.25n calls per instance. Boyer-Moore — one pass to find a candidate, a second full',
    'pass to verify it — costs about 2n per instance and does NOT reach the target. What',
    'closes the gap is REUSING the comparisons already made instead of discarding them:',
    'a pair of tokens known to be unequal can contain at most one copy of any value.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: MAJORITY,
    reference: [
      'export function solve(input, oracle) {',
      '  const t = input.tokens;',
      '  let best = null;',
      '  let bestCount = 0;',
      '  for (let i = 0; i < t.length; i += 1) {',
      '    let c = 0;',
      '    for (let j = 0; j < t.length; j += 1) if (oracle.equals(t[i], t[j])) c += 1;',
      '    if (c > bestCount) { bestCount = c; best = t[i]; }',
      '  }',
      '  return bestCount * 2 > t.length ? best : null;',
      '}',
    ].join('\n') + '\n',
    body: [
      `// The majority value is 0 in the first instance. In the second, 0 occupies exactly
// half the tokens, so no strict majority exists and the answer is null.
function instance(hasMajority) {
  const vals = new Array(P.n);
  const copies = hasMajority ? Math.floor(P.n / 2) + 1 : Math.floor(P.n / 2);
  for (let i = 0; i < copies; i += 1) vals[i] = 0;
  for (let i = copies; i < P.n; i += 1) vals[i] = 1 + i;
  return { tokens: shuffle(vals.map(tok)) };
}`,
      EQUALS_ORACLE,
      'const decode = (out) => (out === null || out === undefined ? null : valueOf(out));',
      'emitTrials([',
      '  trial(instance(true), oracle, decode, 0),',
      '  trial(instance(false), oracle, decode, null),',
      ']);',
    ].join('\n'),
    // Measured: the cancellation tournament in BEST spends 1488 + 1504; Boyer-Moore costs 4696 and scores 0.93.
    targetOps: 2992,
    // Every token must appear in some `equals` call; a call touches two tokens, so ceil(n/2) per instance.
    lowerBoundOps: MAJORITY.n,
  },
});

const BOUNDARY = { seed: 106, m: 150, n: 4000 };

/**
 * Sorted thresholds make runs correlated: entropy log2 C(n-2, m) = 918 bits vs m*log2(n) = 1795, so
 * per-run binary search (1796 calls) leaves headroom that independent searches would not.
 */
const BOUNDARY_STAIRCASE = ratioTask({
  id: 'hard-boundary-staircase',
  tags: ['hard-task', 'optimization', 'search'],
  brief: [
    `You are given ${String(BOUNDARY.m)} runs. Each run is an array of`,
    `${String(BOUNDARY.n)} opaque tokens, and the oracle answers one question about a token:`,
    "does it hold a value at or above that run's own hidden threshold?",
    '',
    'input:  { runs: object[][] }',
    'oracle: { holds(token) -> boolean }   the ONLY way to learn anything about a token',
    '',
    'WITHIN EACH RUN THE TOKENS ARE ALREADY IN ASCENDING VALUE ORDER, so `holds` is false',
    'for a prefix of the array and true for the rest. Return an array of',
    `${String(BOUNDARY.m)} integers: for each run, in order, the index of the FIRST token`,
    'for which `holds` is true. Every run has at least one.',
    '',
    'THE RUNS ARE NOT INDEPENDENT OF EACH OTHER, and that is what this task is about.',
    `The ${String(BOUNDARY.m)} thresholds were drawn uniformly at random from the interior of`,
    'the index range and then SORTED ASCENDING before being handed out, so the answers form',
    "a STAIRCASE: run r's answer is >= run r-1's answer, never less. Ties are permitted, so",
    'two consecutive runs may share an answer. Both of those are given and you may rely on',
    `them. Because ${String(BOUNDARY.m)} sorted thresholds are spread over ${String(BOUNDARY.n)} indices,`,
    `consecutive answers are about ${String(Math.round(BOUNDARY.n / BOUNDARY.m))} apart on average — far closer to each other`,
    'than either is to the ends of the range.',
    '',
    'The reference scans each run in blocks of 64 and then walks the block it landed in,',
    'starting from index 0 every time. Searching each run properly is the obvious win, but',
    'the target is well below what independent searches of the full range can reach: a run',
    'searched after its predecessor already has a lower bound on its answer and a good',
    'estimate of how far past that bound the answer lies.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: BOUNDARY,
    // A block scan, not a linear scan: a linear-scan reference (285_515 calls) stretches the log span and flattens the score.
    reference: [
      'export function solve(input, oracle) {',
      '  const out = [];',
      '  const step = 64;',
      '  for (const run of input.runs) {',
      '    let probe = 0;',
      '    let lastFalse = -1;',
      '    while (probe < run.length - 1 && !oracle.holds(run[probe])) {',
      '      lastFalse = probe;',
      '      probe += step;',
      '    }',
      '    let at = lastFalse + 1;',
      '    while (!oracle.holds(run[at])) at += 1;',
      '    out.push(at);',
      '  }',
      '  return out;',
      '}',
    ].join('\n'),
    body: [
      `// Each run's hidden values are its own indices, so "the first token at or above the
// threshold" IS the threshold, and the expected answer needs no second search to
// establish. The thresholds are drawn over the INTERIOR of the range, so neither end of a
// run is a shortcut: index 0 is always false (a run whose answer were 0 would need no
// call to lower-bound it) and the last index is always true (an answer at n-1 would need
// no call to upper-bound it), which is what makes the certificate floor below exact.
//
// SORTED, which is the whole task: the answer vector is non-decreasing, so a run searched
// in order inherits a lower bound from its predecessor. Drawn through a Set so the m
// positions are distinct — see the floor's justification, which needs every run to own its
// two calls. Distinctness is deliberately NOT promised in the brief: a solution may not
// assume it, and the certificate bound is computed against the weaker promise the brief
// actually makes.
const picks = new Set();
while (picks.size < P.m) picks.add(1 + Math.floor(rand() * (P.n - 2)));
const expected = [...picks].sort((a, b) => a - b);
const runs = [];
for (let r = 0; r < P.m; r += 1) {
  const run = new Array(P.n);
  for (let i = 0; i < P.n; i += 1) run[i] = tok(i);
  runs.push(run);
}
const input = { runs };
// Keyed by TOKEN, not by run index: the oracle takes one token and must not be
// able to tell which run is being probed from the order it is called in, or a
// solution could learn a threshold from call sequence rather than from an answer.
const thresholdOf = new WeakMap();
for (let r = 0; r < P.m; r += 1) for (const t of runs[r]) thresholdOf.set(t, expected[r]);
const oracle = { holds: meter((t) => valueOf(t) >= thresholdOf.get(t)) };`,
      `const decode = (out) => {
  if (!Array.isArray(out)) {
    throw new Error('expected an array of ' + String(P.m) + ' indices, got ' + typeof out);
  }
  return out.map((x) => (typeof x === 'number' ? x : Number.NaN));
};`,
      'emitTrials([trial(input, oracle, decode, expected)]);',
    ].join('\n'),
    // Measured: the staircase search in `hard-tasks.test.ts`, 951 calls vs entropy log2 C(3998, 150) = 918 bits.
    targetOps: 951,
    // 2m: pinning each run needs a true and a false call on that run; positions are distinct, so no neighbour donates a bound.
    lowerBoundOps: 2 * BOUNDARY.m,
  },
});

const MERGE = { seed: 109, p: 200, q: 20_000 };

const MERGE_TWO = ratioTask({
  id: 'hard-merge-two',
  tags: ['hard-task', 'optimization', 'merge'],
  brief: [
    'You are given two runs of opaque tokens: a SHORT run of',
    `${String(MERGE.p)} tokens and a LONG run of ${String(MERGE.q)} tokens.`,
    'All values are distinct.',
    '',
    'input:  { shortRun: object[], longRun: object[] }',
    'oracle: { compare(a, b) -> -1 | 0 | 1 }   the ONLY way to learn anything about a token',
    '',
    'EACH RUN IS ALREADY IN ASCENDING VALUE ORDER. That is given, not something you have',
    'to establish: the two runs arrive sorted and you may rely on it.',
    '',
    `Return the two runs MERGED: one array of all ${String(MERGE.p + MERGE.q)} tokens in`,
    'ascending value order.',
    '',
    'The reference is the textbook linear merge, which walks both runs with two pointers',
    'and therefore pays for every element of the long run. The target does not: the runs',
    'are wildly unequal in length, and the optimal number of comparisons for merging',
    'unequal runs is far below their combined length.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: MERGE,
    reference: [
      'export function solve(input, oracle) {',
      '  const a = input.shortRun; const b = input.longRun;',
      '  const out = [];',
      '  let i = 0; let j = 0;',
      '  while (i < a.length && j < b.length) {',
      '    if (oracle.compare(a[i], b[j]) <= 0) { out.push(a[i]); i += 1; }',
      '    else { out.push(b[j]); j += 1; }',
      '  }',
      '  while (i < a.length) { out.push(a[i]); i += 1; }',
      '  while (j < b.length) { out.push(b[j]); j += 1; }',
      '  return out;',
      '}',
    ].join('\n'),
    body: [
      `// The long run holds the EVEN values 0,2,...,2q-2 and the short run holds distinct ODD
// values, so no value is shared, the merged order is total, and the expected answer is
// the numeric sorted union — computed here directly rather than by a second merge.
// The largest value overall is forced into the SHORT run, which is what makes the
// reference's linear merge exhaust the long run last and spend exactly p+q-1
// comparisons: a shape the task's prompt describes and the calibration suite measures.
// Both runs are handed over ASCENDING and are never shuffled — that sortedness is the
// structure the fast algorithm exploits.
const longVals = new Array(P.q);
for (let i = 0; i < P.q; i += 1) longVals[i] = 2 * i;
const odds = new Set([2 * P.q - 1]);
while (odds.size < P.p) odds.add(1 + 2 * Math.floor(rand() * (P.q - 1)));
const shortVals = [...odds].sort((x, y) => x - y);
const input = { shortRun: shortVals.map(tok), longRun: longVals.map(tok) };
const expected = [...shortVals, ...longVals].sort((x, y) => x - y);
${COMPARE_ORACLE}`,
      `const decode = (out) => {
  if (!Array.isArray(out)) {
    throw new Error('expected an array of ' + String(P.p + P.q) + ' tokens, got ' + typeof out);
  }
  return out.map((t) => valueOf(t));
};`,
      'emitTrials([trial(input, oracle, decode, expected)]);',
    ].join('\n'),
    // Measured: the Hwang-Lin binary merge in `hard-tasks.test.ts` on this instance.
    targetOps: 1610,
    // Intra-run order is given; each of the p short elements needs at least one comparison, so p.
    lowerBoundOps: MERGE.p,
  },
});

const KTH_RUNS = { seed: 110, instances: 40, len: 15_000 };

const KTH_TWO_RUNS = ratioTask({
  id: 'hard-kth-two-runs',
  tags: ['hard-task', 'optimization', 'selection'],
  brief: [
    `You are given ${String(KTH_RUNS.instances)} independent instances. Each instance is TWO runs`,
    `of ${String(KTH_RUNS.len)} opaque tokens plus its own index k. Within one instance the`,
    `${String(2 * KTH_RUNS.len)} hidden values are all distinct. Return the token holding the`,
    "k-th smallest value among that instance's two runs (0-based).",
    '',
    'input:  { instances: { runs: object[][], k: number }[] }',
    'oracle: { compare(a, b) -> -1 | 0 | 1 }   the ONLY way to learn anything about a token',
    '',
    'BOTH RUNS OF EVERY INSTANCE ARE HANDED TO YOU ALREADY IN ASCENDING VALUE ORDER, and',
    'nothing relates one instance to another. Return an array of',
    `${String(KTH_RUNS.instances)} tokens: one answer per instance, in the order the instances are`,
    'given.',
    '',
    'The reference merges each instance\'s two runs one element at a time until it reaches',
    'position k, so it pays about k comparisons per instance. The target does not grow with k',
    'that way.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: KTH_RUNS,
    reference: [
      'export function solve(input, oracle) {',
      '  const out = [];',
      '  for (const inst of input.instances) {',
      '    const a = inst.runs[0];',
      '    const b = inst.runs[1];',
      '    let i = 0;',
      '    let j = 0;',
      '    let picked = null;',
      '    for (let taken = 0; taken <= inst.k; taken += 1) {',
      '      if (i >= a.length) { picked = b[j]; j += 1; }',
      '      else if (j >= b.length) { picked = a[i]; i += 1; }',
      '      else if (oracle.compare(a[i], b[j]) <= 0) { picked = a[i]; i += 1; }',
      '      else { picked = b[j]; j += 1; }',
      '    }',
      '    out.push(picked);',
      '  }',
      '  return out;',
      '}',
    ].join('\n') + '\n',
    body: [
      `// Each instance's 2*len values are exactly 0..2*len-1, so the k-th smallest value IS k and
// the expected answer needs no second search to establish. The seeded shuffle decides which
// values land in which run, each run is then handed over ascending, and k comes from the same
// PRNG over the interior of the range so neither a first nor a last element is a shortcut.
// Both arms see bit-identical instances.
const instances = [];
const expected = [];
const span = 2 * P.len;
for (let s = 0; s < P.instances; s += 1) {
  const vals = new Array(span);
  for (let i = 0; i < span; i += 1) vals[i] = i;
  shuffle(vals);
  const left = vals.slice(0, P.len).sort((x, y) => x - y).map(tok);
  const right = vals.slice(P.len).sort((x, y) => x - y).map(tok);
  const k = 1 + Math.floor(rand() * (span - 2));
  instances.push({ runs: [left, right], k });
  expected.push(k);
}
const input = { instances };`,
      COMPARE_ORACLE,
      `const decode = (out) => {
  if (!Array.isArray(out)) {
    throw new Error('expected an array of ' + String(P.instances) + ' tokens, got ' + typeof out);
  }
  return out.map(valueOf);
};`,
      'emitTrials([trial(input, oracle, decode, expected)]);',
    ].join('\n'),
    // Measured: discard floor((k+1)/2) per comparison, about log2(k) per instance.
    targetOps: 609,
    // Two comparisons per instance certify the boundary pair; deliberately weak, it guards against oracle bypass.
    lowerBoundOps: 2 * KTH_RUNS.instances,
  },
});

const SECOND = { seed: 108, n: 40_000 };

const SECOND_SMALLEST = ratioTask({
  id: 'hard-second-smallest',
  tags: ['hard-task', 'optimization', 'selection'],
  brief: [
    `You are given ${String(SECOND.n)} opaque tokens in arbitrary order, each hiding a distinct`,
    'number. Return the token holding the SECOND smallest value.',
    '',
    'input:  { tokens: object[] }',
    'oracle: { compare(a, b) -> -1 | 0 | 1 }   the ONLY way to learn anything about a token',
    '',
    'The reference scans twice — once for the smallest, then again over everything else —',
    'so it spends about 2n comparisons. The target is a little OVER n, not under it: every',
    'element must lose a comparison before anything can be certified, but the second',
    'smallest can only be an element that lost DIRECTLY to the smallest, so the shape of',
    'the comparison schedule decides how many candidates remain once the smallest is known.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: SECOND,
    reference: [
      'export function solve(input, oracle) {',
      '  const t = input.tokens;',
      '  let min = t[0];',
      '  for (let i = 1; i < t.length; i += 1) if (oracle.compare(t[i], min) < 0) min = t[i];',
      '  let second = null;',
      '  for (let i = 0; i < t.length; i += 1) {',
      '    if (t[i] === min) continue;',
      '    if (second === null || oracle.compare(t[i], second) < 0) second = t[i];',
      '  }',
      '  return second;',
      '}',
    ].join('\n') + '\n',
    body: [
      DISTINCT_TOKENS,
      'const input = { tokens };',
      COMPARE_ORACLE,
      'const decode = (out) => valueOf(out);',
      'emitTrials([trial(input, oracle, decode, 1)]);',
    ].join('\n'),
    // Kislitsyn's optimum: n-1 for the knockout plus ceil(log2(n))-1; measured exactly on this instance.
    targetOps: SECOND.n + Math.ceil(Math.log2(SECOND.n)) - 2,
    // Certificate bound n-1: every element but the minimum must lose once; the adversary bound would be wrong here.
    lowerBoundOps: SECOND.n - 1,
  },
});

const SADDLEBACK = { seed: 111, rows: 200, cols: 200 };

const SADDLEBACK_COUNT = ratioTask({
  id: 'hard-saddleback-count',
  tags: ['hard-task', 'optimization', 'search'],
  brief: [
    `You are given a hidden matrix of opaque tokens as an array of ${String(SADDLEBACK.rows)} rows,`,
    `each an array of ${String(SADDLEBACK.cols)} tokens. The oracle answers one question about one`,
    "token: is that token's hidden value strictly below a hidden threshold?",
    '',
    'input:  { grid: object[][] }',
    'oracle: { below(token) -> boolean }   the ONLY way to learn anything about a token',
    '',
    'THE MATRIX IS SORTED ALONG BOTH AXES, AND BOTH FACTS ARE GUARANTEED:',
    '  * EVERY ROW is in ascending value order from left to right, and',
    '  * EVERY COLUMN is in ascending value order from top to bottom.',
    'There are no exceptions and no ties along either axis, so `below` is true for a',
    'prefix of every row and for a prefix of every column.',
    '',
    'Return, as a number, the COUNT of tokens in the whole matrix whose value is',
    'strictly below the threshold.',
    '',
    'The reference probes every cell, so it pays rows*cols and exploits neither',
    'ordering. Using one of the two gets you a long way. The target uses both.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: SADDLEBACK,
    reference: [
      'export function solve(input, oracle) {',
      '  let count = 0;',
      '  for (const row of input.grid) {',
      '    for (const t of row) if (oracle.below(t)) count += 1;',
      '  }',
      '  return count;',
      '}',
    ].join('\n') + '\n',
    body: [
      `// Cell (r, c) holds base[r] + c with base STRICTLY increasing, so values ascend
// along every row and down every column — both declared monotonicities hold by
// construction rather than by assertion. The row offsets step by 1 or 2 from the
// seeded PRNG rather than by a constant, so the below-threshold region is an
// IRREGULAR staircase: a solution cannot guess the boundary's shape and skip the
// work, it has to trace it.
const base = new Array(P.rows);
for (let r = 0, acc = 0; r < P.rows; r += 1) { base[r] = acc; acc += 1 + Math.floor(rand() * 2); }
const grid = new Array(P.rows);
for (let r = 0; r < P.rows; r += 1) {
  const row = new Array(P.cols);
  for (let c = 0; c < P.cols; c += 1) row[c] = tok(base[r] + c);
  grid[r] = row;
}
// Drawn from the PRNG across the width of the middle row, which keeps the boundary
// genuinely crossing the matrix instead of clipping a corner: a threshold sampled
// over the whole value range lands outside every row's span most of the time and
// would leave a degenerate instance that rewards no algorithm in particular.
const THRESHOLD = base[P.rows >> 1] + 1 + Math.floor(rand() * (P.cols - 2));
// Row r contributes the count of c with base[r] + c < THRESHOLD, which is
// THRESHOLD - base[r] clamped to [0, cols]. The ground truth is therefore COMPUTED
// from the construction, not recovered by a second search over the instance.
let expected = 0;
for (let r = 0; r < P.rows; r += 1) {
  const p = THRESHOLD - base[r];
  expected += p < 0 ? 0 : (p > P.cols ? P.cols : p);
}
const input = { grid };
const oracle = { below: meter((t) => valueOf(t) < THRESHOLD) };`,
      `const decode = (out) => {
  if (typeof out !== 'number') throw new Error('expected a number, got ' + typeof out);
  return out;
};`,
      'emitTrials([trial(input, oracle, decode, expected)]);',
    ].join('\n'),
    // Measured: the saddleback walk from the bottom-left corner, at most rows + cols probes.
    targetOps: 316,
    // Two: one true and one false probe pin any count; a single probe can settle a quadrant, so anything larger is an adversary bound.
    lowerBoundOps: 2,
  },
});

/**
 * The corpus, frozen so `declaredTasks` cannot drift. Tasks whose obvious algorithm is optimal are excluded:
 * e.g. merge sort scores 0.9938 against a Ford-Johnson target of 13691 (information bound ceil(log2(1500!)) = 13669).
 */
export const HARD_TASKS: readonly HardTask[] = Object.freeze([
  SELECT_KTH,
  MAJORITY_VOTE,
  BOUNDARY_STAIRCASE,
  SECOND_SMALLEST,
  MERGE_TWO,
  KTH_TWO_RUNS,
  SADDLEBACK_COUNT,
]);
