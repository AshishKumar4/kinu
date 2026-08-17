#!/usr/bin/env bun
// Graded-corpus generation — the evolution reward signal, produced on purpose.
//
//   bun scripts/graded-corpus.ts --workspace <name> [--only <id,id>] [--keep]
//
// What this is for, and why it is not scripts/bench.ts: bench.ts MEASURES (an
// A/B between variants on seeded repo defects, every attempt in its own
// throwaway home, so no ledger survives the attempt). This GENERATES — one
// persistent workspace, many acting turns, and a `turn_outcomes` ledger left
// behind for evolution to learn from. Different output, so it is a different
// script; the statistics still live in packages/core/src/bench/ and nothing
// here computes a p-value.
//
// The defect it exists to prevent recurring: a CL-Bench run fired evolution 14
// times and every event read `Turn outcome: ungraded (no follow-up) | 0 tool
// calls | 1 steps`, ending at scaffoldVersion 0 / searchNodeCount 0 /
// craftedToolCount 0. The grading path was never broken — `executionVerdict`
// returns null when a turn made no non-lookup tool call, which is the honest
// answer for a task that hands the agent no environment to act on. So the
// corpus is the artifact under construction, and a task that cannot be acted
// on is not a task.
//
// Every task therefore carries three things and is rejected without them:
//   • a writable workspace seeded with real files,
//   • a prompt that cannot be answered without touching them,
//   • `verify`, a command whose exit code is the GROUND TRUTH, run by this
//     script out-of-band. The agent's own claim about its work is never read.
//
// The corpus deliberately contains tasks that FAIL. `buildOutcomeEvalSplit`
// refuses a split with no negatives (evolution/control.ts:484) — a corpus of
// nothing but successes cannot train anything, because there is no failure to
// optimise toward.
//
// THE LIMIT THIS SCRIPT MEASURES, AND DOES NOT HIDE. `verify` is ground truth
// about the WORK; the ledger outcome is the environment's verdict on the
// AGENT'S LAST ACTION. They are different facts and they disagree. Measured on
// a 5-task flash run: 3 tasks verified, 4 turns graded, and only 2 of those 4
// grades agreed with the verifier — one task passed verification while the turn
// graded `corrected` (a stray failing call after the work landed), and one
// failed verification while the turn graded `accepted` (the agent never ran the
// check at all). So both columns are reported side by side and neither is
// allowed to overwrite the other. Making the verifier itself the recorded
// outcome needs a new `verifier` source, a machine-verdict predicate beside
// `isUserVerdictSource`, and a surface for an external harness to attach a
// verdict to a turn id — named as follow-up, deliberately not smuggled in here.
//
// Admissibility is asserted BEFORE any number is printed, and it throws:
//   1. the measured set equals the governed set — every declared task ran,
//   2. it can fail loudly — a zero-task or zero-tool-call run is an error,
//      never a clean report,
//   3. a run that fails publishes no number,
//   4. the assertion sits upstream of the summary, not inside it.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as v from 'valibot';
import { tolerate } from '../packages/core/src/obs/expected-failure.js';
import { agentDbPath } from '../packages/cli/src/config.js';
import { Database } from 'bun:sqlite';

/** The slice of the `--json` event stream this reads. Parsed rather than cast:
 *  the stream carries every event type and a corpus report must not be built
 *  on a shape nobody checked. */
const EventSchema = v.object({
  type: v.optional(v.string()),
  message: v.optional(v.string()),
  data: v.optional(v.object({
    graded: v.optional(v.boolean()),
    outcome: v.optional(v.string()),
  })),
});

/** One corpus task: files to seed, a prompt that must touch them, and the
 *  command whose exit code decides whether the work actually landed. */
interface CorpusTask {
  readonly id: string;
  readonly seed: Readonly<Record<string, string>>;
  readonly prompt: string;
  readonly verify: string;
  /** Tasks whose verification can NEVER pass, kept on purpose so the ledger
   *  carries negatives. A run where one of these PASSES is a corpus bug: the
   *  guaranteed negative is gone and the split can degenerate. Caught once
   *  already — an `assert value() == 1` / `assert value() == 2` pair looks
   *  contradictory and is not, because the two calls are sequential and a
   *  counter satisfies both. */
  readonly alwaysFails?: true;
}

const PY_SUITE = (body: string) => `import sys\n${body}\nprint("ALL PASS")\n`;

const TASKS: readonly CorpusTask[] = [
  {
    id: 'fix-arithmetic',
    seed: {
      'calc.py': 'def add(a, b):\n    return a - b\n\ndef mul(a, b):\n    return a + b\n',
      'test_calc.py': PY_SUITE('from calc import add, mul\nassert add(2, 3) == 5\nassert mul(2, 3) == 6'),
    },
    prompt: 'In your current working directory, calc.py has two bugs: add() subtracts and mul() '
      + 'adds. Fix both functions by editing calc.py, then run "python3 test_calc.py" and confirm '
      + 'it prints ALL PASS.',
    verify: 'python3 test_calc.py',
  },
  {
    id: 'off-by-one',
    seed: {
      'window.py': 'def last_n(items, n):\n    return items[-n - 1:]\n',
      'test_window.py': PY_SUITE('from window import last_n\nassert last_n([1,2,3,4,5], 2) == [4,5]\nassert last_n([1,2,3], 3) == [1,2,3]'),
    },
    prompt: 'In your current working directory, window.py has an off-by-one bug in last_n. Fix it '
      + 'by editing window.py, then run "python3 test_window.py" and confirm it prints ALL PASS.',
    verify: 'python3 test_window.py',
  },
  {
    id: 'missing-guard',
    seed: {
      'ratio.py': 'def ratio(a, b):\n    return a / b\n',
      'test_ratio.py': PY_SUITE('from ratio import ratio\nassert ratio(6, 3) == 2\nassert ratio(1, 0) is None'),
    },
    prompt: 'In your current working directory, ratio.py crashes on a zero denominator. Make '
      + 'ratio(1, 0) return None instead by editing ratio.py, then run "python3 test_ratio.py" '
      + 'and confirm it prints ALL PASS.',
    verify: 'python3 test_ratio.py',
  },
  {
    id: 'create-parser',
    seed: {
      'test_parse.py': PY_SUITE('from parse import parse_kv\nassert parse_kv("a=1,b=2") == {"a": "1", "b": "2"}\nassert parse_kv("") == {}'),
    },
    prompt: 'In your current working directory, write a new file parse.py containing parse_kv(text), '
      + 'which turns "a=1,b=2" into {"a": "1", "b": "2"} and an empty string into {}. Then run '
      + '"python3 test_parse.py" and confirm it prints ALL PASS.',
    verify: 'python3 test_parse.py',
  },
  // The deliberate negative: `preflight.py` exits 3 unconditionally, so no edit
  // can make it pass, and the agent is told to diagnose rather than repair —
  // a real thing an operator asks for. This is the case that proves the reward
  // channel can go DOWN: the turn ends on `Error (exit 3)` and grades
  // `corrected` at quality 0.30, where before the executionVerdict fix it
  // graded `accepted` at 0.70.
  //
  // `alwaysFails` says only that `verify` can never pass. It does NOT guarantee
  // a negative OUTCOME, and the first version of this task proved why: with no
  // "current working directory" in the prompt the agent went hunting with
  // ls/find/cat, never ran the check at all, and graded `accepted` while
  // verification still reported FAIL. The outcome follows the agent's last
  // action, not the task's ground truth — which is exactly the limit recorded
  // at the head of this file.
  {
    id: 'diagnose-failing-check',
    seed: {
      'preflight.py': 'import sys\n\nprint("checking release preconditions")\nprint("signing key absent", file=sys.stderr)\nsys.exit(3)\n',
    },
    prompt: 'In your current working directory there is a file preflight.py. Run exactly '
      + '"python3 preflight.py" and tell me its exit code and what it reported. Do NOT edit any '
      + 'file and do NOT try to make it pass — I only want the diagnosis.',
    verify: 'python3 preflight.py',
    alwaysFails: true,
  },
];

/** What one task's run produced. `outcomes` are the ledger rows the turn
 *  actually wrote; `verified` is this script's own out-of-band ground truth. */
interface TaskResult {
  readonly id: string;
  readonly graded: number;
  readonly ungraded: number;
  readonly toolCalls: number;
  readonly outcomes: readonly string[];
  readonly verified: boolean;
}

/** The `turn_outcomes` ledger, which is what evolution actually reads.
 *
 *  Deliberately NOT parsed out of the `--json` event stream: the CLI's writer
 *  emits the `Turn outcome: …` line as a human `message` and carries no `data`,
 *  so counting grades from the stream reads 0 on a perfectly graded run. This
 *  script measured 38 tool calls and 0 graded turns that way while the ledger
 *  held 10 rows. The number that matters is the row evolution consumes. */
function ledgerOutcomes(since: number): string[] {
  return db.query<{ outcome: string }, [number]>(
    'SELECT outcome FROM turn_outcomes WHERE rowid > ? ORDER BY rowid',
  ).all(since).map((r) => r.outcome);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const workspaceArg = arg('workspace');
if (!workspaceArg) throw new Error('--workspace <name> is required');
const workspace: string = workspaceArg;
const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const declared = only ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
if (declared.length === 0) throw new Error(`--only matched no task ids; known: ${TASKS.map((t) => t.id).join(', ')}`);

const root = join(process.env.GRADED_CORPUS_ROOT ?? '/tmp', `graded-corpus-${process.pid}`);
const cliEntry = join(import.meta.dir, '../packages/cli/bin/cli.ts');
/** Read-only: this script measures the ledger, it never writes to it. */
const db = new Database(agentDbPath(workspace), { readonly: true });

/** Run one task in its own seeded directory, then read the ledger it wrote and,
 *  separately, the verifier's exit code. The agent's prose is never consulted. */
function runTask(task: CorpusTask): TaskResult {
  const dir = join(root, task.id);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(task.seed)) writeFileSync(join(dir, name), body);

  const before = db.query<{ n: number }, []>('SELECT COALESCE(MAX(rowid), 0) AS n FROM turn_outcomes').get()?.n ?? 0;
  const run = spawnSync(
    'bun',
    ['run', cliEntry, 'exec', '--workspace', workspace, '--json', task.prompt],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  let toolCalls = 0;
  let turns = 0;
  for (const line of (run.stdout ?? '').split('\n')) {
    if (!line.startsWith('{')) continue;
    const parsed = v.safeParse(EventSchema, tolerate(() => JSON.parse(line), 'malformed-input'));
    if (!parsed.success) continue;
    const event = parsed.output;
    if (event.type === 'tool_call') toolCalls++;
    if (event.type === 'evolution' && event.message?.startsWith('Turn outcome:')) turns++;
  }
  const outcomes = ledgerOutcomes(before);

  // Ground truth, out-of-band. The turn's own verdict and this are separate
  // facts and are reported separately; nothing here overwrites the ledger.
  const check = spawnSync('sh', ['-c', task.verify], { cwd: dir, encoding: 'utf8' });
  return {
    id: task.id,
    graded: outcomes.length,
    ungraded: Math.max(0, turns - outcomes.length),
    toolCalls,
    outcomes,
    verified: check.status === 0,
  };
}

const results: TaskResult[] = [];
for (const task of declared) {
  const result = runTask(task);
  results.push(result);
  console.log(
    `${result.verified ? 'PASS' : 'FAIL'}  ${task.id.padEnd(22)}`
    + ` graded=${result.graded} ungraded=${result.ungraded} tools=${result.toolCalls}`
    + ` outcomes=[${result.outcomes.join(',')}]`,
  );
}

// ── Admissibility, upstream of every number below ────────────────
const ranIds = results.map((r) => r.id).sort();
const declaredIds = declared.map((t) => t.id).sort();
if (ranIds.join(',') !== declaredIds.join(',')) {
  throw new Error(`measured set != governed set: declared [${declaredIds.join(',')}], ran [${ranIds.join(',')}]`);
}
const totalGraded = results.reduce((n, r) => n + r.graded, 0);
const totalTools = results.reduce((n, r) => n + r.toolCalls, 0);
if (totalTools === 0) {
  throw new Error('0 tool calls across the whole corpus — no turn acted, so no turn is gradable. '
    + 'This is the C14 shape: check the tasks hand over a writable environment.');
}
if (totalGraded === 0) {
  throw new Error(`0 graded turns across ${results.length} task(s) despite ${totalTools} tool call(s). `
    + 'executionVerdict graded nothing — the corpus is inert and must not be reported as evidence.');
}
const negatives = results.flatMap((r) => r.outcomes).filter((o) => o !== 'accepted').length;
const leaked = results.filter((r, i) => declared[i]?.alwaysFails && r.verified);
if (leaked.length > 0) {
  throw new Error(`task(s) that can never pass PASSED verification: ${leaked.map((r) => r.id).join(', ')} — `
    + 'the corpus no longer contains a guaranteed negative and the split can degenerate.');
}

console.log(`\ncorpus: ${results.length} tasks, ${totalGraded} graded turns, ${negatives} negative,`
  + ` ${totalTools} tool calls, ${results.filter((r) => r.verified).length} verified by ground truth`);
if (negatives === 0) {
  console.log('warning: no negative outcomes — buildOutcomeEvalSplit will refuse this ledger (no_negatives)');
}
if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
