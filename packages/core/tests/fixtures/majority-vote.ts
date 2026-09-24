/**
 * The majority-vote problem: `n` opaque tokens, an `equals` oracle and nothing else, find the value
 * held by strictly more than half of them. Swarm entry zero (`unit-swarm-call-fixture.test.ts`) is
 * built from these numbers, and the Lean floor witnesses (`Kinu/Exploration/Objective.lean`) quote
 * them, so they are written once, here.
 */
import type { RatioProblem } from '../../src/index';

/** The equality oracle; it cannot order, so a solution must count rather than sort. */
const EQUALS_ORACLE = 'const oracle = { equals: meter((a, b) => valueOf(a) === valueOf(b)) };';

export const MAJORITY = { seed: 104, n: 1200 };

export const MAJORITY_VOTE: RatioProblem = {
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
  // Measured: a cancellation tournament spends 1488 + 1504; Boyer-Moore costs 4696.
  targetOps: 2992,
  // Every token must appear in some `equals` call; a call touches two tokens, so ceil(n/2) per instance.
  lowerBoundOps: MAJORITY.n,
};
