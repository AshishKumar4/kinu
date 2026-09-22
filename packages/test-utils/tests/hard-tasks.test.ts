/**
 * Every reference runs and answers correctly, costs more than its target, is matched by a
 * known-optimal solution, and can score zero by a real failure. No model or credential involved.
 */
import { scratchDir } from '../src/scratch';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';

import { join } from 'node:path';
import { minimumPairsForSignificance } from '../../core/src/index';
import { createWorkspace } from '../../core/src/identity/index';
import { initWorkspaceSchema, type LLMProviderConfig } from '../../core/src/index';
import { openWorkspaceCLI, makeWorkspaceSchemaSql } from '../../cli-backend/src/index';
import { TASK_OUTCOME, type VerifierContext } from '../src/eval-outcome';
import {
  HARD_TASKS, HARD_TASK_ENV,
  hardTaskCases, hardTaskFor, scoreRatio, seedHardTask, verifyHardTask,
  type HardTask,
} from '../src/hard-tasks/index';
// The substrate lives in core: a registered verifier kind must resolve to code the tool
// surface can reach.
import { REFERENCE_FILE, SOLUTION_FILE, type RatioMeasurement } from '@kinu.run/core';

// Never called; the unroutable baseURL makes any model use fail.
const LLM: LLMProviderConfig = {
  name: 'test', baseURL: 'http://127.0.0.1:1', headers: {}, model: 'unused',
};

let dir: string;

let ctx: VerifierContext;

let db: Database;

beforeAll(async () => {
  dir = scratchDir('hard-tasks');
  const dbPath = join(dir, 'agent.db');
  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  await createWorkspace(db, { name: 'hard-tasks', purpose: 'calibration', llm: LLM });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const { rt } = await openWorkspaceCLI(db, dbPath, { llm: LLM });
  const shell = rt.shell;

  if (!shell) throw new Error('the opened runtime has no shell, so nothing here can be measured');
  ctx = { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
});

afterAll(() => {
  db.close();
});

/**
 * Each task's files are written fresh; the harness's cache-busted import makes
 * re-verification read the new file.
 */
async function scoreWith(task: HardTask, source: string) {
  await seedHardTask(task, ctx.vfs);
  await ctx.vfs.writeFile(SOLUTION_FILE, source);

  return task.verify(ctx);
}

/** Exactly the reference: the floor of the scale. */
const asReference = async (task: HardTask) => {
  const ref = task.seed.find((f) => f.path === REFERENCE_FILE);

  if (!ref) throw new Error(`${task.id} seeds no ${REFERENCE_FILE}`);

  return scoreWith(task, ref.content);
};

/**
 * The best known implementation per task; its measured cost is the task's `targetOps`, so 1.0
 * is reachable. Written out, not generated: a generated solution proving a generated target proves nothing.
 */
const BEST = {
  // Floyd-Rivest select: n + min(k, n-k) + O(n^(2/3)) vs quickselect's ~3.4n. No PRNG, so its
  // cost, and therefore targetOps, is reproducible.
  'hard-select-kth': `export function solve(input, oracle) {
  const a = input.tokens.slice();
  const swap = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
  const select = (left, right, k) => {
    while (right > left) {
      if (right - left > 600) {
        const n = right - left + 1;
        const i = k - left + 1;
        const z = Math.log(n);
        const s = 0.5 * Math.exp((2 * z) / 3);
        const sd = 0.5 * Math.sqrt((z * s * (n - s)) / n) * (i - n / 2 < 0 ? -1 : 1);
        select(
          Math.max(left, Math.floor(k - (i * s) / n + sd)),
          Math.min(right, Math.floor(k + ((n - i) * s) / n + sd)),
          k,
        );
      }
      const t = a[k];
      let i = left; let j = right;
      swap(left, k);
      if (oracle.compare(a[right], t) > 0) swap(right, left);
      while (i < j) {
        swap(i, j);
        i += 1; j -= 1;
        while (oracle.compare(a[i], t) < 0) i += 1;
        while (oracle.compare(a[j], t) > 0) j -= 1;
      }
      if (oracle.compare(a[left], t) === 0) swap(left, j);
      else { j += 1; swap(j, right); }
      if (j <= k) left = j + 1;
      if (k <= j) right = j - 1;
    }
    return a[k];
  };
  return select(0, a.length - 1, input.k);
}
`,
  // Same-size cancellation tournament (Fischer-Salzberg for an equality oracle); its record
  // verifies the survivor. 2992 calls vs 4696 for plain Boyer-Moore.
  'hard-majority-vote': `export function solve(input, oracle) {
  const t = input.tokens;
  const n = t.length;
  if (n === 0) return null;
  // A group holds tokens already proven mutually equal, so every size is a power of
  // two and every call either merges two groups or cancels two equal-sized groups
  // whose values differ. Cancelling preserves any majority: it removes 2s tokens of
  // which at most s can share a value.
  const bySize = new Map();
  const cancelled = [];
  const admit = (g) => {
    const held = bySize.get(g.length);
    if (held === undefined) { bySize.set(g.length, g); return; }
    bySize.delete(g.length);
    if (oracle.equals(held[0], g[0])) admit(held.concat(g));
    else cancelled.push([held, g]);
  };
  for (const x of t) admit([x]);
  // Distinct powers of two, so the largest survivor outweighs all the others
  // combined: its value is the only one that can still be a majority.
  const sizes = [...bySize.keys()].sort((a, b) => b - a);
  if (sizes.length === 0) return null;
  const cand = bySize.get(sizes[0])[0];
  let known = sizes[0];
  let possible = known;
  for (let i = 1; i < sizes.length; i += 1) possible += sizes[i];
  for (const pair of cancelled) possible += pair[0].length;
  // Verification reuses the tournament instead of rescanning, and exits as soon as
  // the count passes half or can no longer reach it.
  for (let i = 1; i < sizes.length; i += 1) {
    if (known * 2 > n) return cand;
    if (possible * 2 <= n) return null;
    const g = bySize.get(sizes[i]);
    if (oracle.equals(cand, g[0])) known += g.length; else possible -= g.length;
  }
  for (const [a, b] of cancelled) {
    if (known * 2 > n) return cand;
    if (possible * 2 <= n) return null;
    if (oracle.equals(cand, a[0])) known += a.length;
    else if (oracle.equals(cand, b[0])) known += b.length;
    else possible -= a.length;
  }
  return known * 2 > n ? cand : null;
}
`,
  // Ascending runs inherit the predecessor's answer as a lower bound; probing at the probability
  // median hi - (hi-lo)*2^(-1/rem) approaches the staircase's entropy, not m*log2(n).
  'hard-boundary-staircase': `export function solve(input, oracle) {
  const runs = input.runs;
  const m = runs.length;
  const out = [];
  let prev = 0;
  for (let r = 0; r < m; r += 1) {
    const run = runs[r];
    const rem = m - r;
    let lo = prev;
    let hi = run.length - 1;
    for (;;) {
      let probe = Math.floor(hi - (hi - lo) * Math.pow(0.5, 1 / rem));
      if (probe < lo) probe = lo;
      if (probe > hi) probe = hi;
      if (oracle.holds(run[probe])) { hi = probe; break; }
      lo = probe + 1;
    }
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (oracle.holds(run[mid])) hi = mid; else lo = mid + 1;
    }
    out.push(lo);
    prev = lo;
  }
  return out;
}
`,
  'hard-second-smallest': `export function solve(input, oracle) {
  // Knockout tournament. Each survivor carries the tokens it has beaten, so the
  // winner's list is exactly the O(log n) elements that could be second smallest:
  // n-1 comparisons to find the smallest, then one scan of that list.
  let round = input.tokens.map((t) => ({ tok: t, beat: [] }));
  while (round.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < round.length; i += 2) {
      const a = round[i]; const b = round[i + 1];
      const aWins = oracle.compare(a.tok, b.tok) < 0;
      const win = aWins ? a : b;
      win.beat.push(aWins ? b.tok : a.tok);
      next.push(win);
    }
    if (round.length % 2 === 1) next.push(round[round.length - 1]);
    round = next;
  }
  const cands = round[0].beat;
  let second = cands[0];
  for (let i = 1; i < cands.length; i += 1) {
    if (oracle.compare(cands[i], second) < 0) second = cands[i];
  }
  return second;
}
`,
  // Hwang-Lin binary merge: probe 2^t ahead, skip whole blocks, binary search inside; insertion
  // points are non-decreasing, so the long run is never re-searched.
  'hard-merge-two': `export function solve(input, oracle) {
  const a = input.shortRun; const b = input.longRun;
  const p = a.length; const q = b.length;
  const out = [];
  let i = 0; let j = 0;
  while (i < p && j < q) {
    const qRem = q - j;
    const t = Math.max(0, Math.floor(Math.log2(qRem / (p - i))));
    const step = Math.min(1 << t, qRem);
    const x = a[i];
    let hi = j + step;
    if (step < qRem) {
      if (oracle.compare(x, b[j + step - 1]) > 0) {
        for (let k = 0; k < step; k += 1) { out.push(b[j]); j += 1; }
        continue;
      }
      hi = j + step - 1;
    }
    let lo = j;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (oracle.compare(b[mid], x) < 0) lo = mid + 1; else hi = mid;
    }
    while (j < lo) { out.push(b[j]); j += 1; }
    out.push(x); i += 1;
  }
  while (i < p) { out.push(a[i]); i += 1; }
  while (j < q) { out.push(b[j]); j += 1; }
  return out;
}
`,
  // Halve both runs at once: one comparison discards half the smaller side, about log2(k) per instance.
  'hard-kth-two-runs': `export function solve(input, oracle) {
  const out = [];
  for (const inst of input.instances) {
    const a = inst.runs[0];
    const b = inst.runs[1];
    let i = 0;
    let j = 0;
    let k = inst.k;
    for (;;) {
      if (i >= a.length) { out.push(b[j + k]); break; }
      if (j >= b.length) { out.push(a[i + k]); break; }
      if (k === 0) { out.push(oracle.compare(a[i], b[j]) <= 0 ? a[i] : b[j]); break; }
      const half = (k + 1) >> 1;
      const ha = Math.min(half, a.length - i);
      const hb = Math.min(half, b.length - j);
      if (oracle.compare(a[i + ha - 1], b[j + hb - 1]) <= 0) { i += ha; k -= ha; }
      else { j += hb; k -= hb; }
    }
  }
  return out;
}
`,
  // Saddleback walk from bottom-left: each probe retires a column or a row (316 probes here),
  // using both row and column monotonicity.
  'hard-saddleback-count': `export function solve(input, oracle) {
  const g = input.grid;
  const rows = g.length;
  const cols = rows === 0 ? 0 : g[0].length;
  let r = rows - 1;
  let c = 0;
  let count = 0;
  while (r >= 0 && c < cols) {
    if (oracle.below(g[r][c])) { count += r + 1; c += 1; }
    else { r -= 1; }
  }
  return count;
}
`,
} satisfies Record<string, string>;

/**
 * The obvious improvement per task. Must score inside a band: ~0 means the task is
 * all-or-nothing, ~1 means no headroom above the first idea.
 */
const STANDARD = {
  // Quickselect with a three-way partition. LCG pivot, not `Math.random`, so the cost is stable
  // against the band; seeds 1, 7, 101, 12345, 999983 all stayed inside it.
  'hard-select-kth': `export function solve(input, oracle) {
  const a = input.tokens.slice();
  const k = input.k;
  let seed = 12345;
  const nextPivot = (span) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 4294967296) * span);
  };
  let lo = 0; let hi = a.length - 1;
  for (;;) {
    if (lo >= hi) return a[lo];
    const p = a[lo + nextPivot(hi - lo + 1)];
    let i = lo; let j = hi; let m = lo;
    while (m <= j) {
      const c = oracle.compare(a[m], p);
      if (c < 0) { const t = a[i]; a[i] = a[m]; a[m] = t; i += 1; m += 1; }
      else if (c > 0) { const t = a[m]; a[m] = a[j]; a[j] = t; j -= 1; }
      else m += 1;
    }
    if (k < i) hi = i - 1; else if (k > j) lo = j + 1; else return a[k];
  }
}
`,
  // Plain Boyer-Moore: the verify pass discards what the first pass learned. 4696 calls, 1.57x target.
  'hard-majority-vote': `export function solve(input, oracle) {
  const t = input.tokens;
  let cand = null; let count = 0;
  for (const x of t) {
    if (count === 0) { cand = x; count = 1; }
    else if (oracle.equals(cand, x)) count += 1;
    else count -= 1;
  }
  if (cand === null) return null;
  let c = 0;
  for (const x of t) if (oracle.equals(cand, x)) c += 1;
  return c * 2 > t.length ? cand : null;
}
`,
  // Independent binary search per short element: p*ceil(log2 q), re-searching the whole long run.
  'hard-merge-two': `export function solve(input, oracle) {
  const a = input.shortRun; const b = input.longRun;
  const at = new Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    let lo = 0; let hi = b.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (oracle.compare(b[mid], a[i]) < 0) lo = mid + 1; else hi = mid;
    }
    at[i] = lo;
  }
  const out = [];
  let j = 0;
  for (let i = 0; i < a.length; i += 1) {
    while (j < at[i]) { out.push(b[j]); j += 1; }
    out.push(a[i]);
  }
  while (j < b.length) { out.push(b[j]); j += 1; }
  return out;
}
`,
  'hard-second-smallest': `export function solve(input, oracle) {
  // One round of pairing, then two linear scans. Halving the field before scanning
  // is the partial insight: 3n/2 instead of 2n, but it stops one level short of
  // recursing, so it never learns who the smallest actually beat.
  const t = input.tokens;
  const winners = [];
  const partner = new Map();
  for (let i = 0; i + 1 < t.length; i += 2) {
    const a = t[i]; const b = t[i + 1];
    const aWins = oracle.compare(a, b) < 0;
    winners.push(aWins ? a : b);
    partner.set(aWins ? a : b, aWins ? b : a);
  }
  if (t.length % 2 === 1) winners.push(t[t.length - 1]);
  let min = winners[0];
  for (let i = 1; i < winners.length; i += 1) {
    if (oracle.compare(winners[i], min) < 0) min = winners[i];
  }
  const cands = winners.filter((w) => w !== min);
  const p = partner.get(min);
  if (p !== undefined) cands.push(p);
  let second = cands[0];
  for (let i = 1; i < cands.length; i += 1) {
    if (oracle.compare(cands[i], second) < 0) second = cands[i];
  }
  return second;
}
`,
  // Nested binary search on rank: log-squared where halving pays log.
  'hard-kth-two-runs': `export function solve(input, oracle) {
  const below = (run, x) => {
    let lo = 0;
    let hi = run.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (oracle.compare(run[mid], x) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const hunt = (self, other, k) => {
    let lo = 0;
    let hi = self.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const rank = mid + below(other, self[mid]);
      if (rank === k) return self[mid];
      if (rank < k) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  };
  const out = [];
  for (const inst of input.instances) {
    const a = inst.runs[0];
    const b = inst.runs[1];
    const found = hunt(a, b, inst.k);
    out.push(found === null ? hunt(b, a, inst.k) : found);
  }
  return out;
}
`,
  // Independent binary search per run: 1796 calls, discarding the staircase's lower bounds.
  'hard-boundary-staircase': `export function solve(input, oracle) {
  const out = [];
  for (const run of input.runs) {
    let lo = 0; let hi = run.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (oracle.holds(run[mid])) hi = mid; else lo = mid + 1;
    }
    out.push(lo);
  }
  return out;
}
`,
  // Per-row binary search: uses only row order, ignoring the non-increasing prefix lengths.
  'hard-saddleback-count': `export function solve(input, oracle) {
  let count = 0;
  for (const row of input.grid) {
    let lo = 0;
    let hi = row.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (oracle.below(row[mid])) lo = mid + 1; else hi = mid;
    }
    count += lo;
  }
  return count;
}
`,
} satisfies Record<string, string>;

/** Looked up by runtime id so a task without a solution reads `undefined` without casts. */
const BEST_BY_ID = new Map<string, string>(Object.entries(BEST));

const STANDARD_BY_ID = new Map<string, string>(Object.entries(STANDARD));

describe('every task has a scoring range, measured on this substrate', () => {
  test.each(HARD_TASKS.map((t) => [t.id, t] as const))(
    '%s: the reference runs, answers correctly, and costs more than its target',
    async (_id, task) => {
      const scored = await asReference(task);
      const { refOps, candOps, targetOps, lowerBoundOps } = scored.measured;

      // `trial` and `scoreRatio` throw on a wrong reference or unreachable target; these surface the numbers.
      expect(refOps, `${task.id}: reference must cost more than its ${String(targetOps)} target`)
        .toBeGreaterThan(targetOps);
      expect(refOps, `${task.id}: reference must be above its own certificate floor`)
        .toBeGreaterThanOrEqual(lowerBoundOps);
      expect(
        candOps,
        `${task.id}: the reference, submitted verbatim as the solution, must be measured at the `
        + `same cost as itself. Verdict was: ${scored.detail}`,
      ).toBe(refOps);

      // Submitting the reference verbatim is the bottom of the scale, not a pass.
      expect(scored.score, `${task.id}: matching the reference must score 0`).toBe(0);
    },
  );
});

describe('the target is reachable — the best implementation the corpus ships hits it', () => {
  test.each(HARD_TASKS.map((t) => [t.id, t] as const))(
    '%s: BEST scores 1.0 and stays above the certificate floor',
    async (_id, task) => {
      const source = BEST_BY_ID.get(task.id);
      expect(source, `${task.id} ships no BEST solution, so its target is unevidenced and the task `
        + 'may be impossible rather than hard').toBeString();
      const scored = await scoreWith(task, source ?? '');

      // The target is this implementation's measured cost, so below 1.0 means it came from arithmetic.
      expect(
        scored.score,
        `${task.id}: ${scored.detail} — targetOps must be set to what BEST actually costs`,
      ).toBeGreaterThanOrEqual(0.999);
      expect(
        scored.measured.candOps,
        `${task.id}: a correct solution below the certificate floor would be scored a cheat`,
      ).toBeGreaterThanOrEqual(scored.measured.lowerBoundOps);

      console.log(
        `  ${task.id.padEnd(24)} ref ${String(scored.measured.refOps).padStart(8)}`
        + `  BEST ${String(scored.measured.candOps).padStart(8)}`
        + `  target ${String(scored.measured.targetOps).padStart(8)}`
        + `  floor ${String(scored.measured.lowerBoundOps).padStart(6)}`
        + `  score ${scored.score.toFixed(4)}`,
      );
    },
  );
});

/**
 * Every task needs headroom over the obvious algorithm: band (0.10, 0.95), partial credit
 * yet short of the best.
 */
describe('no task is saturated — the obvious algorithm lands strictly inside the scale', () => {
  test.each(HARD_TASKS.map((t) => [t.id, t] as const))(
    '%s: STANDARD earns partial credit and does NOT reach the target',
    async (_id, task) => {
      const source = STANDARD_BY_ID.get(task.id);
      expect(source, `${task.id} ships no STANDARD solution, so nothing proves it has headroom `
        + 'above the first idea anyone has').toBeString();
      const scored = await scoreWith(task, source ?? '');

      expect(
        scored.score,
        `${task.id}: the obvious algorithm scored ${scored.score.toFixed(4)} — ${scored.detail}. `
        + 'Below 0.10 this task is effectively all-or-nothing, which is the binary metric this '
        + 'tier exists to replace.',
      ).toBeGreaterThan(0.10);
      expect(
        scored.score,
        `${task.id}: the obvious algorithm scored ${scored.score.toFixed(4)} — ${scored.detail}. `
        + 'At or above 0.95 this task is SATURATED: no headroom above the first idea, so two arms '
        + 'cannot disagree on it and it ranks nothing. Raise the target or replace the task.',
      ).toBeLessThan(0.95);

      console.log(
        `  ${task.id.padEnd(24)} STANDARD ${String(scored.measured.candOps).padStart(8)}`
        + `  score ${scored.score.toFixed(4)}  (costs `
        + `${(scored.measured.candOps / scored.measured.targetOps).toFixed(2)}x the target)`,
      );
    },
  );
});

/** Partial progress earns a partial score: three merges of increasing quality must be ordered by score. */
describe('the score is continuous, not a bit in disguise', () => {
  const task = HARD_TASKS.find((t) => t.id === 'hard-merge-two');

  if (!task) throw new Error('hard-merge-two is missing from the corpus');

  test('three merges of increasing quality receive strictly increasing scores', async () => {
    // The linear merge is the task's seeded reference, read from the corpus.
    const linear = await asReference(task);
    const binary = await scoreWith(task, STANDARD_BY_ID.get(task.id) ?? '');
    const best = await scoreWith(task, BEST_BY_ID.get(task.id) ?? '');

    for (const scored of [linear, binary, best]) {
      expect(scored.detail, `a candidate did not produce a measurement: ${scored.detail}`)
        .not.toContain('no usable solution');
    }

    expect(linear.measured.candOps).toBeGreaterThan(binary.measured.candOps);
    expect(binary.measured.candOps).toBeGreaterThan(best.measured.candOps);

    // The middle one fails if the scale collapses to {0, 1}.
    expect(binary.score, `binary insertion scored ${binary.score.toFixed(4)}: ${binary.detail}`)
      .toBeGreaterThan(0);
    expect(binary.score).toBeLessThan(1);
    expect(linear.score, 'matching the reference is the bottom of the scale').toBe(0);
    expect(binary.score).toBeGreaterThan(linear.score);
    expect(best.score).toBeGreaterThan(binary.score);

    console.log(
      `  continuity: linear ${linear.score.toFixed(4)} (${String(linear.measured.candOps)} ops)`
      + ` < binary ${binary.score.toFixed(4)} (${String(binary.measured.candOps)})`
      + ` < Hwang-Lin ${best.score.toFixed(4)} (${String(best.measured.candOps)})`,
    );
  });
});

describe('every task can score zero by a real failure', () => {
  // One task: failure paths are shared through `trial` in the harness prologue.
  const task = HARD_TASKS[0];

  if (!task) throw new Error('HARD_TASKS is empty');

  test('a solution that throws scores 0 and says so', async () => {
    const scored = await scoreWith(task, 'export function solve() { throw new Error("nope"); }\n');
    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('no usable solution');
    expect(scored.detail).toContain('nope');
  });

  const unusableCases = [
    {
      name: 'a solution that does not parse scores 0 rather than taking the harness down',
      source: 'export function solve( {{{ \n', detail: 'import failed',
    },
    {
      name: 'a module exporting no `solve` scores 0 and names what was missing',
      source: 'export const notSolve = 1;\n', detail: 'exports no',
    },
  ];

  for (const unusable of unusableCases) {
    test(unusable.name, async () => {
      const scored = await scoreWith(task, unusable.source);
      expect(scored.score).toBe(0);
      expect(scored.detail).toContain(unusable.detail);
    });
  }

  test('a cheap WRONG answer scores 0 — correctness gates the ratio', async () => {
    const scored = await scoreWith(task, 'export function solve(input) { return input.tokens[0]; }\n');
    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('wrong answer');
    expect(scored.measured.candOps).toBe(0);
  });

  test('a runaway is stopped by its own oracle budget, not by a timeout', async () => {
    const scored = await scoreWith(task, `export function solve(input, oracle) {
  const t = input.tokens;
  for (;;) oracle.compare(t[0], t[1]);
}
`);

    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('oracle budget');
    // The budget is a multiple of the measured reference, not a constant.
    expect(scored.measured.candOps).toBeGreaterThan(scored.measured.refOps);
  });
});

describe('scoreRatio — the refusals that keep a bad number from being published', () => {
  const task = HARD_TASKS[0];

  if (!task) throw new Error('HARD_TASKS is empty');

  const measurement = (over: Partial<RatioMeasurement>): RatioMeasurement => ({
    refOps: 1_000_000, candOps: 200_000, refMs: 10, candMs: 2, correct: true, failure: null, ...over,
  });

  test('a count below the certificate floor scores 0, however correct the answer', () => {
    const scored = scoreRatio(
      measurement({ candOps: task.problem.lowerBoundOps - 1 }), task.problem,
    );

    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('information-theoretic');
    expect(scored.detail).toContain('measurement channel was bypassed');
  });

  test('a count exactly AT the floor is scored, not refused', () => {
    const scored = scoreRatio(measurement({ candOps: task.problem.lowerBoundOps }), task.problem);
    expect(scored.score).toBeGreaterThan(0);
  });

  test('a target at or below the measured reference is unscoreable and throws', () => {
    expect(() => scoreRatio(
      measurement({ refOps: task.problem.targetOps }), task.problem,
    )).toThrow(/no range to score on/);
  });

  test('worse than the reference clamps to 0 and says it was clamped', () => {
    const scored = scoreRatio(measurement({ candOps: 2_000_000 }), task.problem);
    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('worse than the reference');
  });

  test('beating the target saturates at 1 and keeps both raw counts', () => {
    const scored = scoreRatio(measurement({ candOps: task.problem.lowerBoundOps }), task.problem);
    expect(scored.score).toBeLessThanOrEqual(1);
    expect(scored.measured.candOps).toBe(task.problem.lowerBoundOps);
    expect(scored.measured.refOps).toBe(1_000_000);
  });
});

describe('the corpus as eval cases', () => {
  const cases = hardTaskCases();

  test('it can supply the differing pairs an exact paired test needs', () => {
    expect(cases.length).toBeGreaterThanOrEqual(minimumPairsForSignificance());
  });

  test('ids are unique, so two tasks cannot collide on one pairing identity', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  test('no case carries a rubric or a reference answer — there is nothing for a judge to read', () => {
    for (const c of cases) {
      expect(c.rubric, `${c.id} carries a rubric, which is a judge's affordance`).toBeUndefined();
      expect(c.reference, `${c.id} carries a reference answer for a judge to compare`).toBeUndefined();
    }
  });

  test('every case resolves back to its task, and a foreign case resolves to nothing', () => {
    for (const c of cases) {
      expect(c.env).toBe(HARD_TASK_ENV);
      expect(hardTaskFor(c)?.id).toBe(c.id);
    }

    expect(hardTaskFor({ id: 'ws-fix-broken', env: undefined })).toBeUndefined();
    expect(hardTaskFor({ id: cases[0]?.id ?? '', env: 'something-else' })).toBeUndefined();
  });

  test('every prompt quotes the target its own verifier scores against', () => {
    for (const task of HARD_TASKS) {
      expect(
        task.prompt,
        `${task.id}: the prompt must state the target the scorer uses, or the task is mis-stated`,
      ).toContain(String(task.problem.targetOps));
    }
  });

  test('the instance parameters travel with the case, so a score is re-derivable', () => {
    for (const c of cases) {
      const task = hardTaskFor(c);
      expect(c.params).toEqual({ ...task?.problem.params });
    }
  });
});

describe('the outcome row this tier publishes', () => {
  test('it is the primary metric, carries the measured counts, and nothing else is', async () => {
    const task = HARD_TASKS[0];

    if (!task) throw new Error('HARD_TASKS is empty');
    await seedHardTask(task, ctx.vfs);
    await ctx.vfs.writeFile(SOLUTION_FILE, BEST_BY_ID.get(task.id) ?? '');
    const row = await verifyHardTask(task, ctx);

    expect(row.name).toBe(TASK_OUTCOME);
    expect(row.rate).toBeGreaterThan(0.9);
    expect(row.passed).toBeLessThanOrEqual(row.eligible);
    // Destructured, not optional-chained: `?.` passes vacuously when `measured` is absent on
    // one side. An absent `measured` is its own failure.
    const measured = row.measured;
    expect(measured, 'the outcome row carries no measured counts, so its ratio cannot be '
      + 're-derived from the record').toBeDefined();
    expect(measured?.refOps).toBeGreaterThan(measured?.targetOps ?? Number.POSITIVE_INFINITY);
  });
});
