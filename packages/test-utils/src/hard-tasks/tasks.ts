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
import { ratioTask, type HardTask } from './cost-model';

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
    // MEASURED, not derived: the cost of the best implementation this corpus ships
    // (`BEST['hard-select-kth']` in `hard-tasks.test.ts`, a sampling selection that
    // brackets the target rank from a sub-linear sample and partitions against both
    // ends of the bracket) on this exact instance. 1.0 therefore means "matched the
    // best algorithm we know" and is reachable by construction. The obvious
    // pivot-at-a-time selection costs about 3.4n here and lands mid-scale.
    targetOps: 76_737,
    // An element never compared could be the k-th smallest, so no correct answer
    // can be certified without touching every element at least once.
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
    // MEASURED, not derived: the same-size cancellation tournament in the test file's
    // BEST spends 1488 calls on the first instance and 1504 on the second. It pairs
    // tokens up, cancels equal-sized groups of unequal values two-for-one, and then
    // verifies the survivor by reusing every unequal pair it produced — so no token is
    // ever compared to the candidate twice. Plain Boyer-Moore costs 4696 for the pair
    // and scores 0.93 against this, which is the headroom this task exists to have.
    targetOps: 2992,
    // Per instance, every token must appear in at least one call: one never passed to
    // `equals` could hold the majority value, and in the second instance flipping a
    // single untouched token to 0 would CREATE a majority. A call touches TWO tokens,
    // so covering n of them needs ceil(n/2) calls — n for the pair of instances.
    //
    // This was 2*(n-1), and that was WRONG IN THE DANGEROUS DIRECTION. It counted one
    // token per call, which is twice the true requirement, so it claimed a floor no
    // correct algorithm may go below while a correct algorithm certainly can: the real
    // per-instance certificate is nearer n/2 still (600 equalities prove 601 mutually
    // equal tokens; a perfect matching of unequal pairs proves no majority exists). A
    // floor above what an honest algorithm spends does not catch a cheat, it
    // MANUFACTURES one, which is the single worst thing a ground-truth check can do.
    // Nothing tripped it — BEST spends 2992 — but a floor is a proof or it is nothing.
    lowerBoundOps: MAJORITY.n,
  },
});

const BOUNDARY = { seed: 106, m: 150, n: 4000 };

/**
 * WHY THIS TASK'S RUNS ARE CORRELATED, and why it was rebuilt rather than retargeted.
 *
 * As `hard-boundary-batch` this was m INDEPENDENT monotone searches, and a live flash
 * model returned 1796 calls — exactly m*ceil(log2 n) — for a score of 1.0000. That was
 * not a calibration miss: m independent searches over n positions carry m*log2(n) bits
 * of answer, so binary search per run IS the information bound and NO target can create
 * headroom above it. The problem had to change.
 *
 * Sorting the thresholds ascending is what buys the headroom. The answer vector is now a
 * staircase, its entropy is log2 C(n-2, m) = 918 bits rather than m*log2(n) = 1795, and
 * the gap between the two IS the score range: the obvious algorithm still pays 1796 while
 * an algorithm that starts each run at its predecessor's answer and steps by the typical
 * gap pays 951, within 4% of that entropy.
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
    // A block scan, NOT a linear scan, and the choice is load-bearing. Scoring is
    // logarithmic between the reference and the target, so an absurd baseline flattens the
    // whole scale: a per-run linear scan — what this task shipped as its reference until now
    // — costs 285_515 calls on this instance, which stretches the span to 5.7 nats and would
    // score the obvious binary search 0.884, inside the band by 0.066 and saying almost
    // nothing. The block scan measures 9662, a span of 2.3 nats, on which the same 1.9x
    // improvement is worth 0.27 of the scale.
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
    // MEASURED: what the staircase search in `hard-tasks.test.ts` actually spends on this
    // instance. It walks the runs in order and probes each one first at the MEDIAN of where
    // its threshold can still be — a gap ahead of the previous answer, not the midpoint of
    // the range — then binary-searches the bracket that probe closes. 951 calls against an
    // entropy of log2 C(3998, 150) = 918 bits, so this is not a generous multiple of a
    // named algorithm: it is within 4% of what any algorithm can do on this instance.
    targetOps: 951,
    // Two calls per run, and with the answers now CORRELATED that needs re-deriving rather
    // than assuming. Under the brief's promise — non-decreasing, ties permitted — pinning
    // run r's answer t needs a true call at index t and a false call at t-1, and BOTH must
    // be calls on run r itself: for r' > r the promise gives t_r' >= t_r, so index t is
    // false there whenever t_r' > t_r; for r'' < r index t-1 is true there whenever
    // t_r'' < t_r. Only an EQUAL neighbour could donate a bound, and this instance's m
    // positions are distinct, so no run has one. Hence 2m, and it is a per-instance
    // certificate rather than an adversary bound: it is what the cheapest correct algorithm
    // must spend here, not what a worst case would force. (Had the generator allowed ties,
    // a block of k equal answers would share ONE such pair and the floor would have to drop
    // to twice the number of distinct answers.)
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
    // MEASURED: what the Hwang-Lin binary merge in `hard-tasks.test.ts` actually
    // spends on this instance. Not derived from p*log2(q/p)+p, which only says the
    // right order of magnitude.
    targetOps: 1610,
    // The intra-run orderings are GIVEN, so a certificate does not have to
    // re-establish them: all that is missing is the cross-run relations. Each of the
    // p short elements must take part in at least one comparison — one never
    // compared to anything in the long run could be moved past a long element
    // without contradicting a single answer — and one comparison can certify at most
    // one short element's side of the split. So p, not p+q-1: nearly all of the
    // pairwise order is free from the given sortedness, and a floor above what a
    // correct algorithm honestly spends would score an honest run as a cheat.
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
    // MEASURED, not derived: the cost of discarding floor((k+1)/2) elements per
    // comparison from whichever run holds the smaller of the two candidates, which is
    // one comparison per halving and so about log2(k) per instance.
    targetOps: 609,
    // Per instance: because both runs are DECLARED ascending, the k-th smallest x
    // sitting at index t of one run is certified by the boundary pair alone — the
    // other run's element immediately below x and the one immediately above it —
    // since sortedness then pins x's rank at t + (k - t). Two comparisons per
    // instance, and nothing about one instance can be learned from a comparison
    // inside another, so the bound composes over the batch.
    //
    // This floor is deliberately WEAK: the best algorithm the corpus ships spends an
    // order of magnitude more. That is the point. Its job is not tightness but being
    // unfalsifiable — a count below it proves the answer did not arrive through the
    // oracle, and a token carries no other channel — whereas a floor set above some
    // lucky-but-honest run would score that run as a cheat.
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
    // Kislitsyn's optimum: a knockout tournament finds the smallest in n-1
    // comparisons, and the second smallest is the smallest of the at most
    // ceil(log2(n)) elements the winner beat on its way up, for ceil(log2(n))-1
    // more. Measured at exactly this on this instance — the winner here played all
    // 16 rounds, so the closed form and the measurement coincide.
    targetOps: SECOND.n + Math.ceil(Math.log2(SECOND.n)) - 2,
    // Certificate bound. To certify x as second smallest, each of the n-2 elements
    // other than x and the minimum must have lost at least once, and x must itself
    // have lost to the minimum: n-1 distinct losses, and one comparison supplies
    // one loss. The worst-case optimum n+ceil(log2(n))-2 is an ADVERSARY bound and
    // would be wrong here — a lucky schedule can certify with fewer, and a floor
    // that a correct run can fall below scores that run as a cheat.
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
    // MEASURED, not derived: the cost of the saddleback walk on this instance. It
    // starts at the bottom-left corner and every probe either moves one column right
    // (the cell is below, so its whole column above it is too) or one row up (it is
    // not, so the rest of that row is not either), which traces the entire staircase
    // in at most rows + cols probes and usually fewer, because the walk stops the
    // moment a row turns out to be wholly below the threshold.
    targetOps: 316,
    // A certificate bound, and DELIBERATELY a very weak one. With both monotonicities
    // a single probe settles a whole quadrant — a true `below` at (r, c) settles
    // everything up and to the left, a false one everything down and to the right —
    // so on a degenerate instance a correct algorithm certifies the count with almost
    // nothing: if the threshold sits under every value, two probes at opposite corners
    // pin the answer at zero. Anything derived from `rows` is therefore an ADVERSARY
    // bound, not a certificate, and would score a lucky-but-honest run as a cheat.
    //
    // Two is what survives that objection: no count is pinned without at least one
    // probe that answers true and one that answers false, or the boundary could sit
    // anywhere. Its job is anti-bypass rather than tightness — a token carries no
    // channel besides the oracle, so a weak floor gives a cheat nothing to exploit
    // while a tight one risks calling an honest run fraudulent.
    lowerBoundOps: 2,
  },
});

/**
 * The corpus.
 *
 * Frozen rather than a mutable export, because the run record's `declaredTasks` is
 * derived from it and a corpus that can be appended to at runtime is a corpus
 * whose measured set can drift from its governed set.
 *
 * FOUR TASKS WERE REMOVED after the first live pilot, and the reason is a
 * property of the problems rather than of their calibration. `hard-topk-smallest`,
 * `hard-minmax-pair` and `hard-classes-partition` are SATURABLE BY CONSTRUCTION:
 * for each, the obvious algorithm IS the proven optimum — any streaming top-k
 * costs n + o(n) against a floor of n-1; ceil(3n/2)-2 is the bound for both
 * extremes and the agent returned exactly 59998; a representative list is the only
 * thing equality-only partitioning can do. `hard-sort-total` went for the same
 * reason on stronger evidence — an inequality rather than an argument. Against its
 * insertion-sort reference at 572357 comparisons, a top-down merge sort costs
 * 14011 and scores 0.9938 even with the target set to a MEASURED Ford-Johnson
 * merge-insertion sort at 13691; a hypothetical best sitting exactly on the
 * information bound ceil(log2(1500!)) = 13669 would still score merge 0.9934. No
 * target can create headroom there, because a quadratic reference is separated
 * from EVERY n-log-n sort by a factor of forty and the good sorts are separated
 * from each other by 2.5%, so the first idea holds 99% of the span. Retargeting
 * cannot fix a task whose ceiling is the first idea anyone has: it can never
 * produce a DIFFERING pair, so it buys no statistical power while costing about
 * 22k neurons per run.
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
