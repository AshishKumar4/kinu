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
import { minimumPairsForSignificance } from '../../core/src/index.js';
import { createWorkspace } from '../../core/src/identity/index.js';
import { initWorkspaceSchema, type LLMProviderConfig } from '../../core/src/index.js';
import { openWorkspaceCLI, makeWorkspaceSchemaSql } from '../../cli-backend/src/index.js';
import { TASK_OUTCOME, type VerifierContext } from '../src/eval-outcome.js';
import {
  HARD_TASKS, HARD_TASK_ENV, REFERENCE_FILE, SOLUTION_FILE,
  hardTaskCases, hardTaskFor, scoreRatio, seedHardTask, verifyHardTask,
  type HardTask, type RatioMeasurement,
} from '../src/hard-tasks/index.js';

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
 * A known-optimal solution per task, keyed by id.
 *
 * These are the evidence that each target is REACHABLE, and they are written out
 * in full rather than generated because the point is that a human-recognizable
 * textbook algorithm hits the number. A generated solution proving a generated
 * target would prove nothing.
 */
const OPTIMAL = {
  'hard-select-kth': `export function solve(input, oracle) {
  const a = input.tokens.slice();
  let lo = 0; let hi = a.length - 1; const k = input.k;
  for (;;) {
    if (lo >= hi) return a[lo];
    const p = a[lo + Math.floor(Math.random() * (hi - lo + 1))];
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
  'hard-topk-smallest': `export function solve(input, oracle) {
  const t = input.tokens; const k = input.k; const win = [];
  for (const x of t) {
    if (win.length < k) {
      let i = win.length - 1;
      while (i >= 0 && oracle.compare(win[i], x) > 0) { win[i + 1] = win[i]; i -= 1; }
      win[i + 1] = x;
    } else if (oracle.compare(x, win[k - 1]) < 0) {
      let i = k - 2;
      while (i >= 0 && oracle.compare(win[i], x) > 0) { win[i + 1] = win[i]; i -= 1; }
      win[i + 1] = x;
    }
  }
  return win;
}
`,
  'hard-minmax-pair': `export function solve(input, oracle) {
  const t = input.tokens;
  let min; let max; let i;
  if (t.length % 2 === 1) { min = t[0]; max = t[0]; i = 1; }
  else if (oracle.compare(t[0], t[1]) < 0) { min = t[0]; max = t[1]; i = 2; }
  else { min = t[1]; max = t[0]; i = 2; }
  for (; i + 1 < t.length; i += 2) {
    let lo = t[i]; let hi = t[i + 1];
    if (oracle.compare(lo, hi) > 0) { lo = t[i + 1]; hi = t[i]; }
    if (oracle.compare(lo, min) < 0) min = lo;
    if (oracle.compare(hi, max) > 0) max = hi;
  }
  if (i < t.length) {
    if (oracle.compare(t[i], min) < 0) min = t[i];
    if (oracle.compare(t[i], max) > 0) max = t[i];
  }
  return { min, max };
}
`,
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
  'hard-sort-total': `export function solve(input, oracle) {
  const merge = (a, b) => {
    const out = []; let i = 0; let j = 0;
    while (i < a.length && j < b.length) {
      if (oracle.compare(a[i], b[j]) <= 0) { out.push(a[i]); i += 1; } else { out.push(b[j]); j += 1; }
    }
    while (i < a.length) { out.push(a[i]); i += 1; }
    while (j < b.length) { out.push(b[j]); j += 1; }
    return out;
  };
  const sort = (xs) => {
    if (xs.length < 2) return xs;
    const mid = xs.length >> 1;
    return merge(sort(xs.slice(0, mid)), sort(xs.slice(mid)));
  };
  return sort(input.tokens.slice());
}
`,
  'hard-boundary-batch': `export function solve(input, oracle) {
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
  'hard-classes-partition': `export function solve(input, oracle) {
  const reps = []; const sizes = [];
  for (const x of input.tokens) {
    let placed = false;
    for (let i = 0; i < reps.length; i += 1) {
      if (oracle.equals(x, reps[i])) { sizes[i] += 1; placed = true; break; }
    }
    if (!placed) { reps.push(x); sizes.push(1); }
  }
  return sizes.sort((a, b) => b - a);
}
`,
} satisfies Record<string, string>;

/** Looked up by a runtime id rather than indexed, so `OPTIMAL` keeps its literal
 *  keys and a task added without a solution reads as `undefined` here instead of
 *  needing a cast at every call site. */
const OPTIMAL_BY_ID = new Map<string, string>(Object.entries(OPTIMAL));

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

describe('every task is solvable — a textbook algorithm reaches its target', () => {
  test.each(HARD_TASKS.map((t) => [t.id, t] as const))(
    '%s: the known-optimal solution scores near 1 and stays above the floor',
    async (_id, task) => {
      const source = OPTIMAL_BY_ID.get(task.id);
      expect(source, `${task.id} has no known-optimal solution, so its target is unevidenced`)
        .toBeString();
      const scored = await scoreWith(task, source ?? '');

      expect(
        scored.score,
        `${task.id}: ${scored.detail} — the target is not reachable by the intended algorithm, `
        + 'so the task is impossible rather than hard',
      ).toBeGreaterThan(0.9);
      expect(
        scored.measured.candOps,
        `${task.id}: a correct solution below the certificate floor would be scored a cheat`,
      ).toBeGreaterThanOrEqual(scored.measured.lowerBoundOps);

      // Printed, not just asserted. These four numbers are the whole calibration —
      // what a task costs, what it targets, what the intended algorithm achieves —
      // and a calibration nobody can read is one that lives in its author's memory.
      console.log(
        `  ${task.id.padEnd(24)} ref ${String(scored.measured.refOps).padStart(8)}`
        + `  optimal ${String(scored.measured.candOps).padStart(8)}`
        + `  target ${String(scored.measured.targetOps).padStart(7)}`
        + `  floor ${String(scored.measured.lowerBoundOps).padStart(6)}`
        + `  score ${scored.score.toFixed(4)}`,
      );
    },
    120_000,
  );
});

/**
 * The property the whole tier is FOR: partial progress earns a partial score.
 *
 * A pass/fail bit gives a search nothing to climb — on binary tasks MCTS
 * degenerates toward best-of-n — so a scale whose only reachable values are 0 and 1
 * would have all of this design's cost and none of its benefit. Three sorting
 * algorithms of strictly increasing quality are submitted to the same task, and the
 * scores must ORDER them. That is a stronger claim than "a partial score exists":
 * it says the number ranks.
 */
describe('the score is continuous, not a bit in disguise', () => {
  const task = HARD_TASKS.find((t) => t.id === 'hard-sort-total');
  if (!task) throw new Error('hard-sort-total is missing from the corpus');

  // n*n/2 comparisons: strictly worse than the insertion-sort reference, and inside
  // the 4x budget so it is measured rather than cut off.
  const BUBBLE = `export function solve(input, oracle) {
  const a = input.tokens.slice();
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < a.length - 1 - i; j += 1) {
      if (oracle.compare(a[j], a[j + 1]) > 0) { const t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; }
    }
  }
  return a;
}
`;

  // About 2*n*log2(n): asymptotically optimal but with twice merge sort's constant,
  // which is exactly the "real but incomplete progress" a binary metric cannot see.
  const HEAP = `export function solve(input, oracle) {
  const a = input.tokens.slice();
  const sift = (root, end) => {
    for (;;) {
      let child = 2 * root + 1;
      if (child > end) return;
      if (child + 1 <= end && oracle.compare(a[child], a[child + 1]) < 0) child += 1;
      if (oracle.compare(a[root], a[child]) >= 0) return;
      const t = a[root]; a[root] = a[child]; a[child] = t;
      root = child;
    }
  };
  for (let i = (a.length - 2) >> 1; i >= 0; i -= 1) sift(i, a.length - 1);
  for (let end = a.length - 1; end > 0; end -= 1) {
    const t = a[0]; a[0] = a[end]; a[end] = t;
    sift(0, end - 1);
  }
  return a;
}
`;

  test('three sorts of increasing quality receive strictly increasing scores', async () => {
    const bubble = await scoreWith(task, BUBBLE);
    const heap = await scoreWith(task, HEAP);
    const merge = await scoreWith(task, OPTIMAL_BY_ID.get(task.id) ?? '');

    for (const scored of [bubble, heap, merge]) {
      expect(scored.detail, `a candidate did not produce a measurement: ${scored.detail}`)
        .not.toContain('no usable solution');
    }
    expect(bubble.measured.candOps).toBeGreaterThan(heap.measured.candOps);
    expect(heap.measured.candOps).toBeGreaterThan(merge.measured.candOps);

    // The middle one is the point. If the scale collapsed to {0, 1} this is the
    // assertion that would fail, and with it the reason for the whole design.
    expect(heap.score, `heapsort scored ${heap.score.toFixed(4)}: ${heap.detail}`)
      .toBeGreaterThan(0);
    expect(heap.score).toBeLessThan(1);
    expect(bubble.score, 'worse than the reference is the bottom of the scale').toBe(0);
    expect(heap.score).toBeGreaterThan(bubble.score);
    expect(merge.score).toBeGreaterThan(heap.score);

    console.log(
      `  continuity: bubble ${bubble.score.toFixed(4)} (${String(bubble.measured.candOps)} ops)`
      + ` < heap ${heap.score.toFixed(4)} (${String(heap.measured.candOps)})`
      + ` < merge ${merge.score.toFixed(4)} (${String(merge.measured.candOps)})`,
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
    await ctx.vfs.writeFile(SOLUTION_FILE, OPTIMAL_BY_ID.get(task.id) ?? '');
    const row = await verifyHardTask(task, ctx);

    expect(row.name).toBe(TASK_OUTCOME);
    expect(row.rate).toBeGreaterThan(0.9);
    expect(row.passed).toBeLessThanOrEqual(row.eligible);
    expect(row.measured?.refOps).toBeGreaterThan(row.measured?.targetOps ?? 0);
  }, 120_000);
});
