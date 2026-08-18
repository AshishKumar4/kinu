/**
 * The hard-task corpus itself: seven algorithmic-optimization instances, each
 * scored on a measured oracle count against a measured reference.
 *
 * WHY THIS FAMILY AND NOT MATHEMATICS OR CTFs. The requirement was tasks where
 * progress is QUANTIFIABLE and ground truth needs no persuading. Three families
 * were considered and two rejected:
 *
 *   - Competition mathematics. A final numeric answer is checkable, but it is
 *     BINARY, and a binary reward is exactly what makes a search degenerate
 *     toward best-of-n because there is no partial credit to climb. Partial credit
 *     on a derivation needs a reader, and a reader is a judge.
 *   - CTFs. Ground truth is a flag string, so it is verifiable — but it is again
 *     one bit, and every interesting category (pwn, crypto with real tooling,
 *     forensics) needs binaries, `python3`, or the network. Those are exactly what
 *     the workspace cannot reach until runtime provisioning lands.
 *   - Algorithmic optimization, kept. The score is a MEASURED COST RATIO, so it is
 *     continuous by construction rather than by interpretation; the ground truth is
 *     a number the verifier computes itself; and it needs nothing but `node`,
 *     which the workspace already has.
 *
 * WHAT EVERY TASK HAS IN COMMON. The agent is handed a correct but wasteful
 * reference and asked to beat it on the one metered resource. There is no
 * mechanism to exercise and no tool it is asked to use: `edit`, `run` and
 * `codemode` are means, and measuring them would say how the agent WORKED rather
 * than whether it SOLVED anything. Those still land in the run record as
 * covariates, where `isCovariateRow` keeps them out of any headline.
 *
 * WHY THE FLOORS ARE WHAT THEY ARE. `lowerBoundOps` is a PER-INSTANCE CERTIFICATE
 * bound: the fewest oracle calls any correct algorithm must make on THIS input to
 * be able to justify its answer. That is deliberately weaker than the textbook
 * worst-case bound, and the distinction is load-bearing. Finding both extremes
 * costs ceil(3n/2)-2 comparisons in the worst case, but certifying that x is the
 * minimum only needs each of the other n-1 elements to have lost one comparison,
 * and each comparison supplies one loss and one win — so n-1 comparisons can
 * certify both extremes on a fortunate input. An adversary bound used as a floor
 * would score a lucky run as a cheat. The worst-case optimum is therefore the
 * TARGET, where beating it saturates, and the certificate bound is the FLOOR,
 * below which the answer cannot have come through the oracle at all.
 *
 * WHY THE INSTANCES ARE SIZED THE WAY THEY ARE. Large enough that the reference's
 * cost separates from the target by more than a factor of a few — a narrow span
 * makes the log score twitchy — and small enough that the reference itself
 * finishes far inside the harness deadline. Both ends are asserted by
 * `hard-tasks.test.ts` against MEASURED counts, not argued here.
 */
import { ratioTask, type HardTask } from './cost-model.js';

/**
 * The comparison oracle, as harness source.
 *
 * Returns a sign rather than a difference so no magnitude leaks: `compare` is a
 * three-valued channel, which is what makes the cost of a task a statement about
 * the substrate rather than about the particular numbers hidden in it.
 */
const COMPARE_ORACLE = `const oracle = { compare: meter((a, b) => {
  const x = valueOf(a); const y = valueOf(b);
  return x < y ? -1 : x > y ? 1 : 0;
}) };`;

/** The equality oracle. Strictly weaker than {@link COMPARE_ORACLE}: it cannot
 *  order anything, which is what forces the majority and partition tasks to be
 *  solved by counting rather than by sorting. */
const EQUALS_ORACLE = 'const oracle = { equals: meter((a, b) => valueOf(a) === valueOf(b)) };';

/** `n` distinct hidden values 0..n-1 in shuffled token order, so the k-th
 *  smallest value IS k and the ground truth needs no second sort to establish.
 *  Leaves `vals` in ascending order for the tasks whose answer is the whole
 *  sequence. */
const DISTINCT_TOKENS = `const vals = new Array(P.n);
for (let i = 0; i < P.n; i += 1) vals[i] = i;
const tokens = shuffle(vals.map(tok));`;

const SELECT = { seed: 101, n: 50_000, k: 12_345 };

const SELECT_KTH = ratioTask({
  id: 'hard-select-kth',
  tags: ['hard-task', 'optimization', 'selection'],
  brief: [
    `You are given ${String(SELECT.n)} opaque tokens in arbitrary order, each hiding a distinct`,
    'number, and an index k. Return the token holding the k-th smallest value (0-based).',
    '',
    'input:  { tokens: object[], k: number }',
    'oracle: { compare(a, b) -> -1 | 0 | 1 }   the ONLY way to learn anything about a token',
    '',
    'The reference orders everything to answer a question about one position.',
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
    // Quickselect's expected cost is about 3.4n comparisons. 5n is reachable by any
    // competent partition-based selection and unreachable by ordering the input.
    targetOps: 5 * SELECT.n,
    // An element never compared could be the k-th smallest, so no correct answer
    // can be certified without touching every element at least once.
    lowerBoundOps: SELECT.n - 1,
  },
});

const TOPK = { seed: 102, n: 60_000, k: 50 };

const TOPK_SMALLEST = ratioTask({
  id: 'hard-topk-smallest',
  tags: ['hard-task', 'optimization', 'selection'],
  brief: [
    `You are given ${String(TOPK.n)} opaque tokens in arbitrary order, each hiding a distinct`,
    `number. Return the ${String(TOPK.k)} smallest of them, as an array in ASCENDING order.`,
    '',
    'input:  { tokens: object[], k: number }',
    'oracle: { compare(a, b) -> -1 | 0 | 1 }   the ONLY way to learn anything about a token',
    '',
    `The reference orders all ${String(TOPK.n)} to report ${String(TOPK.k)} of them. k is tiny`,
    'next to n, and the target is below 2n, so no full ordering can reach it.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: TOPK,
    reference: [
      'export function solve(input, oracle) {',
      '  return input.tokens.slice().sort(oracle.compare).slice(0, input.k);',
      '}',
    ].join('\n') + '\n',
    body: [
      DISTINCT_TOKENS,
      'const input = { tokens, k: P.k };',
      COMPARE_ORACLE,
      `const decode = (out) => {
  if (!Array.isArray(out)) throw new Error('expected an array of ' + String(P.k) + ' tokens, got ' + typeof out);
  return out.map(valueOf);
};`,
      'const expected = [];',
      'for (let i = 0; i < P.k; i += 1) expected.push(i);',
      'emitTrials([trial(input, oracle, decode, expected)]);',
    ].join('\n'),
    // A bounded insertion window costs about n + k*k/2 and a k-sized heap about
    // n + k*log2(k); both are far under 1.5n. Anything that orders the whole input
    // is above it by an order of magnitude.
    targetOps: Math.round(1.5 * TOPK.n),
    lowerBoundOps: TOPK.n - 1,
  },
});

const MINMAX = { seed: 103, n: 40_000 };

const MINMAX_PAIR = ratioTask({
  id: 'hard-minmax-pair',
  tags: ['hard-task', 'optimization', 'extremes'],
  brief: [
    `You are given ${String(MINMAX.n)} opaque tokens, each hiding a distinct number. Return`,
    'BOTH extremes at once, as { min, max }.',
    '',
    'input:  { tokens: object[] }',
    'oracle: { compare(a, b) -> -1 | 0 | 1 }   the ONLY way to learn anything about a token',
    '',
    'The reference makes two independent passes and so spends 2n-2 comparisons. The',
    'target is the known optimum for finding both extremes TOGETHER, which is strictly',
    'below 2n-2, so beating the reference needs a different shape of algorithm and not a',
    'tighter loop. Ordering the input is far WORSE than the reference here, not better.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: MINMAX,
    reference: [
      'export function solve(input, oracle) {',
      '  const t = input.tokens;',
      '  let min = t[0];',
      '  for (let i = 1; i < t.length; i += 1) if (oracle.compare(t[i], min) < 0) min = t[i];',
      '  let max = t[0];',
      '  for (let i = 1; i < t.length; i += 1) if (oracle.compare(t[i], max) > 0) max = t[i];',
      '  return { min, max };',
      '}',
    ].join('\n') + '\n',
    body: [
      DISTINCT_TOKENS,
      'const input = { tokens };',
      COMPARE_ORACLE,
      `const decode = (out) => {
  if (out === null || typeof out !== 'object') {
    throw new Error('expected { min, max }, got ' + typeof out);
  }
  return [valueOf(out.min), valueOf(out.max)];
};`,
      'emitTrials([trial(input, oracle, decode, [0, P.n - 1])]);',
    ].join('\n'),
    // ceil(3n/2)-2, the worst-case optimum: pair the elements up, then take the
    // minimum of the losers and the maximum of the winners.
    targetOps: Math.ceil((3 * MINMAX.n) / 2) - 2,
    // NOT the same number as the target, deliberately — see the header.
    lowerBoundOps: MINMAX.n - 1,
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
    'You are scored on TWO instances of the same size, summed: one that HAS a majority,',
    'and one whose most common value occupies exactly half the tokens and so is not a',
    'majority. Answering null always, or returning the most common value always, is',
    'wrong on one of the two and scores zero. The reference counts every token against',
    'every other.',
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
    // Boyer-Moore is one pass to find a candidate and one to verify it: 2n per
    // instance, 4n for the pair. 6n leaves room for a less tidy implementation of
    // the same idea while staying two orders of magnitude under the reference.
    targetOps: 6 * MAJORITY.n,
    // Per instance: a token never passed to `equals` could hold the majority value,
    // and in the second instance flipping one untouched token to 0 would CREATE a
    // majority. Two instances, so twice that.
    lowerBoundOps: 2 * (MAJORITY.n - 1),
  },
});

const SORT = { seed: 105, n: 1500 };

const SORT_TOTAL = ratioTask({
  id: 'hard-sort-total',
  tags: ['hard-task', 'optimization', 'sorting'],
  brief: [
    `You are given ${String(SORT.n)} opaque tokens in arbitrary order, each hiding a distinct`,
    'number. Return them all as an array in ASCENDING order.',
    '',
    'input:  { tokens: object[] }',
    'oracle: { compare(a, b) -> -1 | 0 | 1 }   the ONLY way to learn anything about a token',
    '',
    'The reference is an insertion sort, which costs about n*n/4 comparisons on shuffled',
    'input. The target is close to n*log2(n), the comparison-sorting optimum.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: SORT,
    reference: [
      'export function solve(input, oracle) {',
      '  const a = input.tokens.slice();',
      '  for (let i = 1; i < a.length; i += 1) {',
      '    const x = a[i];',
      '    let j = i - 1;',
      '    while (j >= 0 && oracle.compare(a[j], x) > 0) { a[j + 1] = a[j]; j -= 1; }',
      '    a[j + 1] = x;',
      '  }',
      '  return a;',
      '}',
    ].join('\n') + '\n',
    body: [
      DISTINCT_TOKENS,
      'const input = { tokens };',
      COMPARE_ORACLE,
      `const decode = (out) => {
  if (!Array.isArray(out)) {
    throw new Error('expected an array of ' + String(P.n) + ' tokens, got ' + typeof out);
  }
  return out.map(valueOf);
};`,
      'emitTrials([trial(input, oracle, decode, vals)]);',
    ].join('\n'),
    // ceil(n*log2(n)): merge sort lands a little under it, and a heapsort or a
    // delegation to Array.prototype.sort lands near it.
    targetOps: Math.ceil(SORT.n * Math.log2(SORT.n)),
    // A total order over n elements cannot be certified by fewer comparisons than
    // its own transitive reduction, which is a path of n-1 edges.
    lowerBoundOps: SORT.n - 1,
  },
});

const BOUNDARY = { seed: 106, m: 150, n: 4000 };

const BOUNDARY_BATCH = ratioTask({
  id: 'hard-boundary-batch',
  tags: ['hard-task', 'optimization', 'search'],
  brief: [
    `You are given ${String(BOUNDARY.m)} independent runs. Each run is an array of`,
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
    'The reference walks each run from the start, so its cost depends on where the',
    'thresholds happen to fall. The target does not.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: BOUNDARY,
    reference: [
      'export function solve(input, oracle) {',
      '  const out = [];',
      '  for (const run of input.runs) {',
      '    let at = run.length - 1;',
      '    for (let i = 0; i < run.length; i += 1) {',
      '      if (oracle.holds(run[i])) { at = i; break; }',
      '    }',
      '    out.push(at);',
      '  }',
      '  return out;',
      '}',
    ].join('\n'),
    body: [
      `// Each run's hidden values are its own indices, so "the first token at or above the
// threshold" IS the threshold, and the expected answer needs no second search to
// establish. Thresholds come from the seeded PRNG over the interior of the range,
// so neither end of a run is a shortcut and both arms see identical instances.
const runs = [];
const expected = [];
for (let r = 0; r < P.m; r += 1) {
  const run = new Array(P.n);
  for (let i = 0; i < P.n; i += 1) run[i] = tok(i);
  runs.push(run);
  expected.push(1 + Math.floor(rand() * (P.n - 2)));
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
    // Binary search costs ceil(log2(n)) = 12 calls per run; +2 leaves room for a
    // galloping or slightly loose implementation of the same idea.
    targetOps: BOUNDARY.m * (Math.ceil(Math.log2(BOUNDARY.n)) + 2),
    // Two calls per run — one token for which `holds` is true and its immediate
    // predecessor for which it is false — is the smallest certificate of one
    // answer, and there are m independent answers. Nothing about run r can be
    // learned from a call about run r', so the bound composes.
    lowerBoundOps: 2 * BOUNDARY.m,
  },
});

const CLASSES = { seed: 107, n: 1500, d: 25 };

const CLASSES_PARTITION = ratioTask({
  id: 'hard-classes-partition',
  tags: ['hard-task', 'optimization', 'counting'],
  brief: [
    `You are given ${String(CLASSES.n)} opaque tokens drawn from a small number of distinct`,
    'hidden values. Group them by equality and return the group SIZES as an array sorted',
    'DESCENDING.',
    '',
    'input:  { tokens: object[] }',
    'oracle: { equals(a, b) -> boolean }   the ONLY way to learn anything about a token.',
    '        No ordering is available: you cannot sort these.',
    '',
    'The reference compares every token against every other. You are told neither how',
    'many groups there are nor how big they are, and the groups are NOT equally sized.',
  ].join('\n'),
  signature: 'export function solve(input, oracle)',
  problem: {
    params: CLASSES,
    reference: [
      'export function solve(input, oracle) {',
      '  const t = input.tokens;',
      '  const sizes = [];',
      '  const claimed = new Array(t.length).fill(false);',
      '  for (let i = 0; i < t.length; i += 1) {',
      '    let size = 0;',
      '    for (let j = 0; j < t.length; j += 1) if (oracle.equals(t[i], t[j])) size += 1;',
      '    if (!claimed[i]) {',
      '      sizes.push(size);',
      '      for (let j = 0; j < t.length; j += 1) if (oracle.equals(t[i], t[j])) claimed[j] = true;',
      '    }',
      '  }',
      '  return sizes.sort((a, b) => b - a);',
      '}',
    ].join('\n') + '\n',
    body: [
      `// Sizes are deliberately UNEQUAL, so a solution that reports d copies of n/d is
// wrong: the answer carries the shape of the partition and not just its cardinality.
const counts = new Array(P.d);
let assigned = 0;
for (let v = 0; v < P.d; v += 1) { counts[v] = v + 1; assigned += counts[v]; }
counts[0] += P.n - assigned;
const vals = [];
for (let v = 0; v < P.d; v += 1) for (let i = 0; i < counts[v]; i += 1) vals.push(v);
const tokens = shuffle(vals.map(tok));
const input = { tokens };
const expected = counts.slice().sort((a, b) => b - a);`,
      EQUALS_ORACLE,
      `const decode = (out) => {
  if (!Array.isArray(out)) throw new Error('expected an array of group sizes, got ' + typeof out);
  return out.map((x) => (typeof x === 'number' ? x : Number.NaN));
};`,
      'emitTrials([trial(input, oracle, decode, expected)]);',
    ].join('\n'),
    // Keeping one representative per group and testing each token against the
    // representatives costs at most n*d, and about half that on shuffled input.
    targetOps: CLASSES.n * CLASSES.d,
    // A token never passed to `equals` cannot be placed in any group, and moving it
    // changes the sizes, so every token must appear in at least one call.
    lowerBoundOps: CLASSES.n - 1,
  },
});

/**
 * The corpus, in the order a reader should meet it: the selection tasks whose
 * improvement is the most standard first, then the ones that need a specific idea.
 *
 * Frozen rather than a mutable export, because the run record's `declaredTasks` is
 * derived from it and a corpus that can be appended to at runtime is a corpus
 * whose measured set can drift from its governed set.
 */
export const HARD_TASKS: readonly HardTask[] = Object.freeze([
  SELECT_KTH,
  TOPK_SMALLEST,
  MINMAX_PAIR,
  MAJORITY_VOTE,
  SORT_TOTAL,
  BOUNDARY_BATCH,
  CLASSES_PARTITION,
]);
