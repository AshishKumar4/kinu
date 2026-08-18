/**
 * The hard-task corpus, calibrated against MEASURED oracle counts rather than
 * against arithmetic in a comment.
 *
 * WHAT THIS PROVES, AND WHY EACH PART IS NECESSARY.
 *
 *   1. Every reference RUNS, in a real opened workspace, and answers its own
 *      instance correctly. `trial` throws when the reference is wrong, so a green
 *      run here is the ground truth checking itself.
 *   2. Every reference costs MORE than its target. `scoreRatio` refuses a target at
 *      or below the measured reference, so this is the assertion that each task has
 *      a range to score on at all — and it is measured on this machine, in this
 *      substrate, not asserted from a formula.
 *   3. Every task is SOLVABLE: a known-optimal implementation reaches a high score
 *      and does so ABOVE the certificate floor. A corpus nothing can solve ranks
 *      exactly as little as one everything solves, and "hard" has to mean hard
 *      rather than impossible.
 *   4. Every task can score ZERO by a real failure — absent module, syntax error,
 *      wrong answer, runaway — with a detail that says which. A tier where nothing
 *      can score zero has reproduced, in a new field, the defect that made
 *      `pass@1` read 1.000 twice.
 *
 * These run without a credential and spend nothing: the workspace is real, the
 * measurement is real, and no model is involved anywhere. The corpus's difficulty
 * for an AGENT is a separate question that only a live run can answer.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// The measurement substrate itself lives in core now — a registered verifier kind has
// to resolve to code the tool surface can reach, and a kind whose implementation sat in
// a test package would be a name with nothing behind it in production. The corpus is
// one caller of it; what stayed in `cost-model.ts` is the eval ladder's own scoring.
import { REFERENCE_FILE, SOLUTION_FILE, type RatioMeasurement } from '@proteus/core';

// Never called. The unroutable baseURL is deliberate: if anything in this file
// reaches a model, it must fail rather than quietly bill someone.
const LLM: LLMProviderConfig = {
  name: 'test', baseURL: 'http://127.0.0.1:1', headers: {}, model: 'unused',
};

let dir: string;
let ctx: VerifierContext;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'proteus-hard-tasks-'));
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
  rmSync(dir, { recursive: true, force: true });
});

/** Seed the task, overwrite the solution with `source`, and score it. Each task's
 *  files are written fresh, so one workspace serves every case and the harness's
 *  cache-busted import is what makes re-verification read the new file. */
async function scoreWith(task: HardTask, source: string) {
  await seedHardTask(task, ctx.vfs);
  await ctx.vfs.writeFile(SOLUTION_FILE, source);
  return task.verify(ctx);
}

/** A candidate that is exactly the reference. The floor of the scale by
 *  definition, and the cheapest way to prove the whole pipeline ran. */
const asReference = async (task: HardTask) => {
  const ref = task.seed.find((f) => f.path === REFERENCE_FILE);
  if (!ref) throw new Error(`${task.id} seeds no ${REFERENCE_FILE}`);
  return scoreWith(task, ref.content);
};

/**
 * THE BEST implementation this corpus ships, per task. Its MEASURED cost is what
 * each task's `targetOps` is set to, so 1.0 means "matched the best algorithm we
 * know for this problem" and is reachable by construction rather than by hope.
 *
 * WHY THIS REPLACED "a textbook algorithm scores > 0.9". The first live pilot
 * solved 7 of 7 at exactly 1.0000 and beat six of the seven targets outright,
 * because every target had been set at a generous multiple of a NAMED algorithm
 * and a strong model recalls named algorithms: it returned 59998 for min-and-max,
 * which is exactly ceil(3n/2)-2, and 1796 for 150 binary searches, which is
 * exactly 12 probes each. A corpus whose ceiling is the first idea anyone has
 * cannot produce a differing pair, so it buys no statistical power at all.
 *
 * Written out in full rather than generated: a generated solution proving a
 * generated target proves nothing.
 */
const BEST = {
  // Floyd-Rivest SELECT. The array arrives in random order, so the contiguous
  // sub-range around the target rank IS a random sample: recursing into a band of
  // width ~n^(2/3) chosen from the order statistics of that sample yields two
  // pivots that bracket rank k with high probability, and the outer partition then
  // touches each element about once. Costs n + min(k, n-k) + O(n^(2/3)) rather than
  // quickselect's ~3.4n. No PRNG at all, so its measured cost — and therefore this
  // task's targetOps — is reproducible.
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
  // Same-size cancellation tournament, the equality-oracle analogue of Fischer-
  // Salzberg: pair the tokens up, cancel unequal pairs two-for-one, merge equal ones
  // into groups that are then cancelled only against groups of the SAME size. 746
  // calls settle the candidate here where Boyer-Moore's first pass costs n. The
  // second half is where the win is: the tournament's own record verifies the
  // survivor, because one call to a group's representative settles the whole group
  // and each cancelled pair can hold the candidate on at most one of its two sides.
  // 1488 + 1504 = 2992 calls for the pair, under 1.25n each, against 4696 for plain
  // Boyer-Moore. Worst case observed over 100k fuzzed instances is 1.4n, inside
  // Fischer-Salzberg's 3n/2 - 2 optimum.
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
  // Walk the runs in ASCENDING order so each one inherits its predecessor's answer as a
  // lower bound, and probe first where the answer most likely IS rather than at the
  // midpoint of what is left. With `rem` thresholds still to place in [lo, hi], the next
  // one exceeds x with probability ((hi-x)/(hi-lo))^rem, so the median sits at
  // hi - (hi-lo)*2^(-1/rem) — about a gap ahead of `lo`, not half a range. Every probe
  // then splits the remaining possibilities in half by PROBABILITY, which is what makes
  // the total approach the entropy of the staircase instead of m*log2(n).
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
  // Hwang-Lin binary merge: for each short element, probe the element one block of
  // 2^t ahead in the long run (t from the ratio of what REMAINS of each), skip the
  // whole block on one comparison when the short element is larger, and binary
  // search inside the block when it is not. Optimal in order for unequal runs, and
  // what the independent-binary-search STANDARD misses is exactly this: successive
  // insertion points are non-decreasing, so the long run is never re-searched.
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
  // Binary search on BOTH runs at once: one comparison between the two runs'
  // floor((k+1)/2)-th remaining elements proves that whole half of the smaller side
  // lies inside the first k, so it is discarded outright and k shrinks with it. One
  // comparison per halving, hence about log2(k) per instance.
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
  // The saddleback walk. Start at the bottom-left corner and read one probe as a
  // statement about a whole quadrant: if the cell is below the threshold then so is
  // everything above it in that column, so the column contributes r+1 to the count
  // and we step right; if it is not, then neither is anything to its right in that
  // row, so that row is finished and we step up. Every probe therefore retires a
  // column or a row and the entire staircase is traced in at most rows + cols, here
  // 316 because the walk stops as soon as it climbs into a wholly-below row. This is
  // the only solution here that uses BOTH declared monotonicities: the column order
  // is what makes one probe worth r+1 cells instead of one.
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
 * THE OBVIOUS correct improvement over the reference, per task — the solution a
 * competent solver writes first, without the specific idea the task is about.
 *
 * It exists to be the thing that must NOT reach the target. This is the assertion
 * that makes a saturating corpus unable to pass its own tests, and it is
 * deliberately bounded on BOTH sides: a standard algorithm scoring ~0 would mean
 * the task is all-or-nothing, which is the binary metric this tier replaced, and
 * one scoring ~1 would mean the task has no headroom above the first idea. Both
 * are corpus defects and both are red.
 */
const STANDARD = {
  // Quickselect with a three-way partition: recurse into the side holding rank k and
  // throw the other away. The first idea anyone has here, and a real 5x win over
  // sorting, but it re-scans a linear-sized range at every level and so pays a
  // constant times n instead of n plus a sub-linear correction.
  //
  // The pivot comes from an LCG seeded in the solution, NOT from `Math.random`: this
  // number is asserted against a band, and a candidate whose cost moves between runs
  // would make that assertion flake. Measured 172_302 here, close to the analytic
  // expectation of 2(n + k*ln(n/k) + (n-k)*ln(n/(n-k))) = 156_138 for this k; every
  // plain seed tried (1, 7, 101, 12345, 999983) spanned 98_466..400_236 and stayed
  // inside the band, so the headroom is a property of the algorithm, not of the seed.
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
  // Plain Boyer-Moore: one pass to find a candidate, one full pass to verify it. The
  // named algorithm everyone recalls, a 613x win over the all-pairs reference, and
  // still 1.57x the target — because the verification pass throws away everything the
  // first pass learned and re-compares all n tokens. 2336 + 2360 = 4696 calls.
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
  // Binary-search each short element's insertion point in the WHOLE long run,
  // independently: p*ceil(log2 q) comparisons. A real 7x win over the linear merge
  // and the first thing anyone writes once they notice the runs are sorted, but it
  // throws away the monotonicity of the insertion points and re-searches the whole
  // long run 200 times.
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
  // Rank by nested binary search. The global rank of a run's t-th token is
  // t + (how many of the other run's tokens are below it), which is increasing in t,
  // so binary search t and answer each probe with a second binary search in the other
  // run. Correct, and a huge win over merging, but it pays log2(len) comparisons per
  // probe where the halving algorithm pays one: log-squared instead of log.
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
  // One binary search per run over the WHOLE index range, each run treated as if it stood
  // alone: 1796 calls — 146 runs at ceil(log2 n) = 12 and the 4 whose interval happens to
  // close a step early at 11 — which is the very number a live flash model returned when
  // the runs really were independent. A 5.4x win over the block-scanning reference and the
  // first thing anyone writes, but it throws the staircase away — every search restarts at
  // index 0 and spends its first several probes re-establishing a lower bound the previous
  // run's answer already gave it for free.
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
  // Binary-search each row for its own boundary and sum the prefix lengths:
  // rows * ceil(log2(cols + 1)) probes. The first thing anyone writes once told the
  // rows are sorted, and a real 27x win over probing all 40000 cells — but it uses
  // only the ROW ordering. Every row is searched from scratch even though the column
  // ordering makes the prefix lengths non-increasing, so each of the 200 searches
  // re-derives a boundary the previous one had already almost located.
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

/** Looked up by a runtime id rather than indexed, so the literal keys survive and
 *  a task shipped without a solution reads as `undefined` here instead of needing
 *  a cast at every call site. */
const BEST_BY_ID = new Map<string, string>(Object.entries(BEST));
const STANDARD_BY_ID = new Map<string, string>(Object.entries(STANDARD));

describe('every task has a scoring range, measured on this substrate', () => {
  test.each(HARD_TASKS.map((t) => [t.id, t] as const))(
    '%s: the reference runs, answers correctly, and costs more than its target',
    async (_id, task) => {
      const scored = await asReference(task);
      const { refOps, candOps, targetOps, lowerBoundOps } = scored.measured;

      // `trial` throws when the reference answers wrongly and `scoreRatio` throws
      // when the target is unreachable, so arriving here at all is most of the
      // proof. These make the numbers visible in the failure message.
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
    120_000,
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

      // Not "> 0.9". The target IS this implementation's measured cost, so anything
      // short of 1.0 means the target was set from arithmetic instead of measurement.
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
    180_000,
  );
});

/**
 * THE PROPERTY THE FIRST LIVE PILOT FAILED, now asserted offline for free.
 *
 * Every task must have headroom above the obvious algorithm, or two arms can never
 * disagree on it. The band is (0.10, 0.95): the lower edge says a standard solution
 * earns real partial credit rather than nothing, because a task where only the best
 * answer scores is a pass/fail bit wearing a continuous scale; the upper edge says
 * the best answer is meaningfully better than the first idea anyone has.
 *
 * Run A scored 7 of 7 at 1.0000 against a live model. This is the check that would
 * have been red before that run, at no cost and with no credential.
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
    180_000,
  );
});

/**
 * The property the whole tier is FOR: partial progress earns a partial score.
 *
 * A pass/fail bit gives a search nothing to climb — on binary tasks MCTS
 * degenerates toward best-of-n — so a scale whose only reachable values are 0 and 1
 * would have all of this design's cost and none of its benefit. Three merge
 * algorithms of strictly increasing quality are submitted to the same task, and the
 * scores must ORDER them. That is a stronger claim than "a partial score exists":
 * it says the number ranks.
 *
 * This ran on `hard-sort-total` until that task was removed for having no headroom:
 * a merge sort scored 0.9938 there, and even a best sitting exactly on
 * ceil(log2(1500!)) would have left it 0.9934, so the three sorts it ranked were
 * two sorts and a rounding error. `hard-merge-two` has the separation sorting
 * lacked — a linear merge, a per-element binary search and Hwang-Lin are three
 * genuinely different costs on one instance.
 */
describe('the score is continuous, not a bit in disguise', () => {
  const task = HARD_TASKS.find((t) => t.id === 'hard-merge-two');
  if (!task) throw new Error('hard-merge-two is missing from the corpus');

  test('three merges of increasing quality receive strictly increasing scores', async () => {
    // The linear merge is this task's own seeded reference, so the bottom of the
    // scale is read from the corpus rather than retyped as a constant here.
    const linear = await asReference(task);
    const binary = await scoreWith(task, STANDARD_BY_ID.get(task.id) ?? '');
    const best = await scoreWith(task, BEST_BY_ID.get(task.id) ?? '');

    for (const scored of [linear, binary, best]) {
      expect(scored.detail, `a candidate did not produce a measurement: ${scored.detail}`)
        .not.toContain('no usable solution');
    }
    expect(linear.measured.candOps).toBeGreaterThan(binary.measured.candOps);
    expect(binary.measured.candOps).toBeGreaterThan(best.measured.candOps);

    // The middle one is the point. If the scale collapsed to {0, 1} this is the
    // assertion that would fail, and with it the reason for the whole design.
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
  }, 180_000);
});

describe('every task can score zero by a real failure', () => {
  // One task, not all seven: these exercise the substrate's failure paths, which
  // are shared by construction (`trial` in the harness prologue). Running them
  // seven times would measure the same code seven times and cost a minute.
  const task = HARD_TASKS[0];
  if (!task) throw new Error('HARD_TASKS is empty');

  test('a solution that throws scores 0 and says so', async () => {
    const scored = await scoreWith(task, 'export function solve() { throw new Error("nope"); }\n');
    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('no usable solution');
    expect(scored.detail).toContain('nope');
  }, 120_000);

  test('a solution that does not parse scores 0 rather than taking the harness down', async () => {
    const scored = await scoreWith(task, 'export function solve( {{{ \n');
    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('import failed');
  }, 120_000);

  test('a module exporting no `solve` scores 0 and names what was missing', async () => {
    const scored = await scoreWith(task, 'export const notSolve = 1;\n');
    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('exports no');
  }, 120_000);

  test('a cheap WRONG answer scores 0 — correctness gates the ratio', async () => {
    const scored = await scoreWith(task, 'export function solve(input) { return input.tokens[0]; }\n');
    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('wrong answer');
    expect(scored.measured.candOps).toBe(0);
  }, 120_000);

  test('a runaway is stopped by its own oracle budget, not by a timeout', async () => {
    const scored = await scoreWith(task, `export function solve(input, oracle) {
  const t = input.tokens;
  for (;;) oracle.compare(t[0], t[1]);
}
`);
    expect(scored.score).toBe(0);
    expect(scored.detail).toContain('oracle budget');
    // The budget is a multiple of the MEASURED reference, so the runaway is
    // bounded by the instance and not by a constant somebody has to maintain.
    expect(scored.measured.candOps).toBeGreaterThan(scored.measured.refOps);
  }, 120_000);
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
    // Destructured rather than optional-chained. `row.measured?.refOps` against
    // `row.measured?.targetOps ?? 0` passes vacuously when `measured` is absent on
    // ONE side and fails confusingly when it is absent on both, which is how this
    // read as an intermittent flake to a sibling running the suite mid-edit. An
    // absent `measured` is a real defect — the raw counts are what makes a ratio
    // re-derivable — so it must be its own named failure.
    const measured = row.measured;
    expect(measured, 'the outcome row carries no measured counts, so its ratio cannot be '
      + 're-derived from the record').toBeDefined();
    expect(measured?.refOps).toBeGreaterThan(measured?.targetOps ?? Number.POSITIVE_INFINITY);
  }, 120_000);
});
