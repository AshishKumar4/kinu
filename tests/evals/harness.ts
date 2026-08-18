/**
 * The behaviour harness: run one task through the real turn spine, then read
 * what the ledger recorded about HOW it was done.
 *
 * WHY THIS DRIVES `LocalAgentSession` IN-PROCESS. Every mechanism this tier
 * measures — steering, the craft loop, the completion gate, the context budget,
 * the file ledger, execution recovery — writes its `run_events` row when a TURN
 * CLOSES, from `closeTurnRun` (core/src/orchestrator/turn-lifecycle.ts:64-116).
 * A bare `generateText` call never closes a turn, so a harness built on one
 * would report a zero denominator for all eight scorers and read as a pass. This
 * is the same spine `proteus exec` uses, with no subprocess and no stdout
 * parsing.
 *
 * WHY IT SEEDS THE VFS AND NOT THE DISK. The workspace filesystem is durable
 * storage, not a directory: `createCLIRuntime` builds the Nimbus workspace
 * filesystem over the agent's own SQLite (`cli-backend/src/runtime.ts:298`), and
 * `WorkspaceBirthConfig` has no `cwd` at all. The `file` tool reads that VFS.
 * Seeding a temp directory on disk would leave the agent looking at an empty
 * workspace and produce exactly the zero-denominator corpus this tier exists to
 * detect — so the tree is written through `rt.storage.vfs`, which is what the
 * tool actually sees, and through the OPENED runtime's copy of it.
 *
 * WHY IT THROWS RATHER THAN RETURNING A ZERO. This is the load-bearing design
 * decision and it is not stylistic. `vitest-evals` writes `task.meta.eval` from
 * exactly two places — `applyAutomaticJudges` (dist/index.mjs:1393) and
 * `appendJudgeScore`, the explicit `toSatisfyJudge` path (:1447) — and BOTH are
 * reachable only from a result `run(...)` handed back. `clearRecordedTaskMeta`
 * (:1229) blanks the metadata at the start of every run, and the catch branch
 * (:1236-1272) writes only `meta.harness` before rethrowing. So a harness that
 * THROWS leaves no score in the emitted artifact, whereas an assertion in the
 * test body executes strictly after both writers and fixes only the verdict.
 *
 * That distinction is the difference between a red test and a clean number: an
 * agent that did nothing must not contribute a score to the pool a downstream
 * average or min-pass-rate gate reads. A failed case contributing the best
 * number in the pool is inverted contamination, not noise. Measured both ways
 * on the emitted JSON — a throwing harness yields `meta.eval` ABSENT with
 * `meta.harness` still PRESENT, so the diagnostic record survives and only the
 * score is withheld.
 *
 * The precondition itself is the one CL-Bench needed: 14 evolution events over
 * 14 turns, every one "ungraded (no follow-up) | 0 tool calls | 1 steps", with
 * 500 steps available and one used. That corpus was inert and its mean_gain of
 * -0.2 read as a measurement.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import type { JsonValue } from '@vitest-evals/core';

import type {
  AgentRuntime, EvalCase, LLMProviderConfig, RunEvent, SeekCursor, Shell,
} from '../../packages/core/src/index';
import {
  RunEventRecorder, initWorkspaceSchema, listRuns, resolveMaxSteps,
} from '../../packages/core/src/index';
import { createWorkspace } from '../../packages/core/src/identity/index';
import { LocalAgentSession } from '../../packages/cli-backend/src/local-session';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import { makeSql, makeWorkspaceSchemaSql } from '../../packages/cli-backend/src/runtime';
import {
  hardTaskFor, recordLiveModelEpisode, scoreTrajectory, seedHardTask, verifyHardTask,
  type EvalArmState, type EvalScoreRow, type HardTask,
} from '@proteus/test-utils';

/**
 * What one task run produced, as the WIRE shape a judge receives.
 *
 * Structurally JSON — mutable fields and an index signature — because
 * `vitest-evals` constrains a harness output to its own `JsonValue`, and a judge
 * that cannot receive the scores cannot report them. `EvalScoreRow` in
 * `eval-run.ts` is the deliberately readonly PERSISTED shape, and this is the
 * projection of it; the two are kept apart so `eval-run.ts` stays free of any
 * `vitest-evals` import. That is what makes the runner one deletable wrapper
 * rather than a dependency threaded through the record and the statistics.
 *
 * It is JSON-shaped for a second reason: the harness is the only thing holding
 * the workspace's SQLite, so scoring happens there and every judge is pure over
 * this — no database handle escapes into the suite.
 */
export interface BehaviourScoreJson {
  name: string;
  asserts: string;
  eligible: number;
  passed: number;
  rate: number | null;
  detail: string;
  [key: string]: JsonValue;
}

export interface BehaviourOutput {
  taskId: string;
  turns: number;
  toolCalls: number;
  toolNames: string[];
  scores: BehaviourScoreJson[];
  tokensIn: number;
  tokensOut: number;
  [key: string]: JsonValue;
}

/**
 * Project the persisted rows onto the wire shape. Fresh literals, so the
 * index-signature target is satisfied without a cast.
 *
 * `measured` IS carried, and that is not cosmetic. This projection originally
 * dropped it, so the raw counts behind every ratio — the reference the candidate
 * was divided by, the target, the floor — reached the run record only inside the
 * `detail` STRING. The first live pilot's numbers had to be recovered by parsing
 * English out of a sentence. A ratio whose baseline does not survive beside it is
 * a ratio nobody can re-derive, which is the whole reason `measured` exists.
 */
function toScoreJson(rows: readonly EvalScoreRow[]): BehaviourScoreJson[] {
  return rows.map((row) => {
    const json: BehaviourScoreJson = {
      name: row.name, asserts: row.asserts, eligible: row.eligible,
      passed: row.passed, rate: row.rate, detail: row.detail,
    };
    return row.measured === undefined ? json : { ...json, measured: { ...row.measured } };
  });
}

/**
 * A small source tree in the agent's VFS, so a task has somewhere to act.
 *
 * `broken.ts` is wrong on purpose and `broken.test.ts` fails against it:
 * `ws-fix-broken` and `ws-recover-cmd` need the first obvious command to FAIL,
 * because execution recovery cannot be measured on a workspace where nothing
 * goes wrong. The TODOs exist so `ws-find-todo` has something real to find
 * rather than confirming an empty result.
 */
export async function seedWorkspaceTree(rt: AgentRuntime): Promise<void> {
  const { vfs } = rt.storage;
  await vfs.mkdir('src', { recursive: true });
  await vfs.writeFile('src/greet.ts', [
    'export function greet(name: string): string {',
    '  // TODO: support a locale argument',
    '  return `Hello, ${name}`;',
    '}',
  ].join('\n') + '\n');
  await vfs.writeFile('src/main.ts', [
    "import { greet } from './greet.ts';",
    '',
    '// TODO: read the name from argv',
    'console.log(greet("world"));',
    '',
    'export const VERSION = 1;',
  ].join('\n') + '\n');
  await vfs.writeFile('src/broken.ts', [
    'export function add(a: number, b: number): number {',
    '  return a - b;',
    '}',
  ].join('\n') + '\n');
  await vfs.writeFile('src/broken.test.ts', [
    "import { test, expect } from 'bun:test';",
    "import { add } from './broken.ts';",
    '',
    "test('add sums', () => { expect(add(2, 3)).toBe(5); });",
  ].join('\n') + '\n');
}

/** Turn and tool-call counts plus token usage, read through the recorder so
 *  every payload is validated by the canonical union rather than by a shape
 *  written here. Limits are far above any corpus: the defaults (50 runs, 200
 *  events) would silently truncate a multi-turn task into a smaller
 *  denominator, which reads as an agent that acted less rather than a reader
 *  that stopped looking. */
/** What the ledger says one episode did. */
interface LedgerTotals {
  turns: number;
  toolCalls: number;
  toolNames: string[];
  tokensIn: number;
  tokensOut: number;
  /** Model steps the episode closed, counted from `step_finish`. Compared against
   *  the pre-registered step cap to decide whether the episode was TRUNCATED —
   *  which is the one number that keeps a cap from silently changing what a run
   *  measured. */
  steps: number;
  /** Why a turn produced nothing. A degenerate run that cannot say why is a dead
   *  end for whoever reads the record: "0 tool calls" is equally consistent with
   *  a model that declined to act and a provider that rejected every request. */
  failures: string[];
}

function readLedgerTotals(db: Database): LedgerTotals {
  const recorder = new RunEventRecorder(makeSql(db));
  // A WALK, not a window. This is the whole ledger of a trial and a truncated
  // one would understate the trial's own totals — the previous `listRuns(10_000)`
  // was a guess that it would never be reached, which is the assumption the page
  // contract exists to stop anyone having to make.
  const events: RunEvent[] = [];
  let cursor: SeekCursor | null = null;
  for (;;) {
    const page = listRuns(recorder, cursor);
    for (const run of page.items) events.push(...recorder.read(run.runId, { limit: 100_000 }));
    if (page.status === 'end') break;
    cursor = page.next;
  }
  let turns = 0, toolCalls = 0, tokensIn = 0, tokensOut = 0, steps = 0;
  const toolNames: string[] = [];
  // Why a turn produced nothing. A degenerate run that cannot say why is a dead
  // end for whoever reads the record: "0 tool calls" is equally consistent with
  // a model that declined to act and a provider that rejected every request.
  const failures: string[] = [];
  for (const event of events) {
    if (event.type === 'turn_end') {
      turns += 1;
      // FIELD RENAME ONLY (turn_end.tokenUsage -> turn_end.usage). The `?? 0`
      // collapse is EvalsInfra's to remove: it makes "the turn reported no usage"
      // indistinguishable from "the turn used zero tokens". The agreed
      // replacement is addUsage/usageReported over a `Usage`, plus a count of
      // unreported turns. Left in place because these records are theirs and
      // mid-flight; this edit only keeps the build green.
      tokensIn += event.usage?.input ?? 0;
      tokensOut += event.usage?.output ?? 0;
    } else if (event.type === 'tool_call_end') {
      toolCalls += 1;
      toolNames.push(event.name);
      if (event.error != null && event.error !== '') failures.push(`${event.name}: ${event.error}`);
    } else if (event.type === 'step_finish') {
      steps += 1;
    } else if (event.type === 'error') {
      failures.push(event.message);
    } else if (event.type === 'run_end' && event.error != null && event.error !== '') {
      failures.push(`run_end: ${event.error}`);
    }
  }
  return { turns, toolCalls, toolNames, tokensIn, tokensOut, steps, failures };
}

/**
 * The pre-registered step cap, recorded as a COVARIATE.
 *
 * WHY A CAP AT ALL. A prior paired run had arm B billing 7.1x arm A, because the
 * mechanism under test is itself a token consumer. Dividing the effect by tokens
 * would have changed the estimand; the successor design is a cap applied
 * IDENTICALLY to both arms, with the rate at which it bites reported as data. A
 * cap whose bite is unmeasured is a silent change to what the run measured.
 *
 * WHY IT IS A SCORE ROW AND NOT A NEW FIELD. `EvalScoreRow` already flows through
 * persistence, the comparator and admissibility, and `isCovariateRow` is a total
 * rule — anything not named `task_outcome` is a covariate — so putting the cap
 * here makes it MECHANICALLY unable to reach a headline, rather than merely
 * conventionally. A new observation field would have needed a schema bump and
 * would still have been eligible for a headline somebody assembled by hand.
 *
 * The cap is read from the same `resolveMaxSteps` the session drives its own
 * `stopWhen` from (local-session.ts:1658), so the number compared against here
 * cannot drift from the number enforced.
 */
function stepCapRow(steps: number): EvalScoreRow {
  const cap = resolveMaxSteps(process.env.PROTEUS_MAX_STEPS);
  const reached = steps >= cap;
  return {
    name: 'step_cap_reached',
    asserts: 'the episode consumed its entire pre-registered step budget, so its work was '
      + 'truncated rather than finished',
    eligible: 1,
    passed: reached ? 1 : 0,
    rate: reached ? 1 : 0,
    detail: `${String(steps)} of ${String(cap)} steps closed`
      + (reached ? ' — TRUNCATED by the cap' : ''),
  };
}

export interface BehaviourHarnessOptions {
  readonly dir: string;
  readonly model: LanguageModel;
  readonly llm: LLMProviderConfig;
  readonly arm: EvalArmState;
  /** Databases opened so far. The suite closes them in teardown rather than the
   *  harness closing eagerly, because the run record is written last and reads
   *  these stores after every task has finished. */
  readonly opened: Database[];
}

/** Thrown when a trajectory recorded nothing gradable. A distinct type so the
 *  suite can record the observation as `inert` rather than `errored` — "the
 *  agent did nothing" and "the harness broke" are different facts and the run
 *  record must not conflate them. */
export class DegenerateRunError extends Error {
  constructor(
    readonly taskId: string, readonly turns: number, readonly toolCalls: number,
    readonly failures: readonly string[],
  ) {
    super(`degenerate run for ${taskId}: ${String(turns)} closed turns, `
      + `${String(toolCalls)} tool calls — not a result. No mechanism could have been `
      + 'exercised, so this contributes no score.'
      + (failures.length > 0 ? ` Recorded failures: ${failures.join(' | ')}` : ''));
    this.name = 'DegenerateRunError';
  }
}

/**
 * Thrown when the runtime handed to a task cannot reach an executor at all.
 *
 * NOT a {@link DegenerateRunError}, deliberately: that type means the AGENT did
 * nothing and is recorded as `inert`, and a runtime with no executors is the
 * HARNESS being broken, which is `errored` (behaviour.eval.ts:281). Conflating
 * them would file a harness fault as an agent observation.
 *
 * This exists because the failure it catches is SILENT by construction.
 * `execute_tools` is built from `router?.getProviders() ?? []`
 * (core/src/tools/builtins.ts:373), so a runtime with no router yields a tool
 * with an empty provider surface and no complaint — every `workspace.*` and
 * `codemode.*` call then fails with `is not a function`, which the ledger
 * records as an ordinary tool result. Two full live runs were graded that way
 * and reported 0.817 and 0.903 tool_outcomes over it.
 *
 * It is checked BEFORE the model is driven, so a broken runtime costs nothing
 * rather than being discovered after a paid episode.
 */
export class DegenerateRuntimeError extends Error {
  constructor(readonly taskId: string, readonly reason: string) {
    super(`degenerate runtime for ${taskId}: ${reason}. The eval must not run: `
      + '`execute_tools` would be built with an empty provider surface, so every '
      + '`workspace.*`/`codemode.*` call fails with "is not a function" and scores '
      + 'as an ordinary tool result. Open the workspace through `openWorkspaceCLI` '
      + '(cli-backend/src/open.ts), which registers the inline ExecutorProvider — '
      + 'the runtime `createWorkspace` returns is the BIRTH runtime and registers none.');
    this.name = 'DegenerateRuntimeError';
  }
}

/**
 * Refuse a runtime that cannot execute anything.
 *
 * The assertion sits upstream of every write path: it throws before a session
 * exists, so there is no turn, no ledger row and no record to publish. A check
 * that fails publishes no number.
 */
export function requireExecutorSurface(taskId: string, rt: AgentRuntime): void {
  const router = rt.executionRouter;
  if (!router) throw new DegenerateRuntimeError(taskId, 'rt.executionRouter is absent');
  const providers = router.getProviders();
  if (providers.length === 0) {
    throw new DegenerateRuntimeError(taskId, 'rt.executionRouter has zero registered providers');
  }
}

/** Executor kinds an episode may be measured on: planes whose filesystem is
 *  not the developer's. An allowlist rather than a `laptop` denylist, so a
 *  plane added later is refused until someone decides it is isolated. */
const SANDBOXED_EXECUTOR_KINDS: readonly string[] = ['workspace'];

/**
 * Thrown when the runtime handed to an episode can execute on the developer's
 * own machine.
 *
 * NOT a {@link DegenerateRunError}: this is the harness being misconfigured, so
 * it is `errored` rather than an observation about the agent
 * (behaviour.eval.ts:347).
 *
 * The escape it catches was measured, not imagined. A live run left
 * `scratch-add/{add.js,add.test.js}` in a worktree ROOT and `report.txt` /
 * `todos.txt` in the repo root, and the commit that swept them up was refused by
 * `gate:typecheck-coverage`. `createCLIRuntime` registers a `laptop`
 * ExecutorProvider rooted at `process.cwd()` unless told not to, and an episode
 * reaches every registered provider through `execute_tools` — so the harness
 * that omitted `hostRoot: null` handed each episode the developer's filesystem.
 */
export class UnsandboxedRuntimeError extends Error {
  constructor(readonly taskId: string, readonly executor: string) {
    super(`unsandboxed runtime for ${taskId}: executor \`${executor}\` runs on the `
      + 'developer\'s own machine. The eval must not run: an episode reaches every '
      + 'registered provider through `execute_tools`, and a corpus task that writes '
      + 'files then writes them into the repo the harness was launched from. Open the '
      + 'workspace with `hostRoot: null` (cli-backend/src/open.ts) — re-rooting the '
      + 'provider is not enough, because `laptop.writeFile` passes an absolute path '
      + 'through and `laptop.exec` can `cd` anywhere.');
    this.name = 'UnsandboxedRuntimeError';
  }
}

/**
 * Refuse a runtime that can reach outside the episode's sandbox.
 *
 * Reads `listExecutors()` rather than `getProviders()` because the codemode
 * surface deliberately drops `kind` (execution/router.ts:38-52), and the kind is
 * the whole question — a name is a namespace, not a claim about which machine
 * runs the command.
 *
 * Checked before the model is driven, beside {@link requireExecutorSurface}: the
 * refusal costs nothing, and discovering it afterwards costs a paid run plus
 * whatever the episode wrote.
 */
export function requireSandboxedExecutors(taskId: string, rt: AgentRuntime): void {
  for (const executor of rt.executionRouter?.listExecutors() ?? []) {
    if (!SANDBOXED_EXECUTOR_KINDS.includes(executor.kind)) {
      throw new UnsandboxedRuntimeError(taskId, executor.name);
    }
  }
}

/**
 * Refuse a runtime that cannot run a command, for a task whose ground truth IS a
 * command.
 *
 * Separate from {@link requireExecutorSurface} because it is a different fact:
 * `executionRouter` is what the agent's tools reach, and `rt.shell` is what the
 * VERIFIER reaches. A hard task on a shell-less runtime would score every attempt
 * zero for a reason that has nothing to do with the agent, and a corpus of
 * unearned zeros is as useless as one of unearned ones. Checked before the model
 * is driven, so the misconfiguration costs nothing.
 */
function requireVerifierShell(taskId: string, rt: AgentRuntime): Shell {
  const shell = rt.shell;
  if (!shell) {
    throw new DegenerateRuntimeError(taskId,
      'rt.shell is absent, so this task\'s verifier could not run its measurement harness '
      + 'and every attempt would score zero for a reason that is not about the agent');
  }
  return shell;
}

/**
 * Run `task`, score the ledger, and refuse to return an inert trajectory.
 *
 * WHY IT OPENS THE WORKSPACE INSTEAD OF RUNNING THE ONE `createWorkspace`
 * RETURNS. `createWorkspace` is the BIRTH path — production calls it once, from
 * `proteus agent create` (cli/src/agent-create.ts:187), and the runtime it hands
 * back is what `cli-backend/src/open.ts:49-50` calls "degraded inline
 * VFS/Memory/Executor". Every surface that actually RUNS a turn — the chat
 * client, the daemon, `evolve` — goes through `openWorkspaceCLI`, which builds
 * the real one. The difference is not cosmetic: the degraded runtime registers
 * NO `ExecutorProvider`, so it has no `executionRouter` at all, and every
 * `execute_tools` block fails with `workspace.createTool is not a function`.
 * Measured both ways on the same scripted episode — degraded: no `craft_cycle`
 * row and `craft_reuse` eligible 0; opened: `crafted:["doubleIt"]`,
 * `reused:["doubleIt"]`, eligible 1. Three flash runs blamed that zero on the
 * corpus. `initWorkspaceSchema` between the two is what `agent-create.ts:189`
 * does, and without it the workspace is missing tables (`head_journal`, per
 * agent-evals.ts:120-122).
 *
 * WHY `oneShot: true`. It is the literal contract — this harness hands over one
 * task and grades what it leaves behind, with nobody reading the answer — and it
 * is the ONLY thing that arms the completion gate (local-session.ts:1514). An
 * interactive declaration made `completion_honesty` structurally unscoreable.
 *
 * `session.send` is awaited to completion because every row this reads is
 * written on settle: reading before settle would produce the zero denominator
 * this tier exists to eliminate, from a turn that was merely still running. The
 * gate's confirming turn is enqueued AFTER send resolves and runs on the pump,
 * so `settleBackgroundWork` is what lets that turn close and write its row.
 */
export async function runBehaviourTask(
  task: EvalCase, opts: BehaviourHarnessOptions,
): Promise<BehaviourOutput> {
  const workDir = join(opts.dir, task.id);
  mkdirSync(workDir, { recursive: true });

  const dbPath = join(workDir, 'agent.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  opts.opened.push(db);

  await createWorkspace(db, {
    name: `behaviour-${task.id}`,
    purpose: 'A senior engineer working in the given workspace. Prefer real tool calls '
      + 'over describing what you would do, and break independent work apart.',
    llm: opts.llm,
  });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  // `hostRoot: null`: no `laptop` executor, so the episode's only filesystem is
  // the workspace one this runtime owns. The default plane is rooted at
  // `process.cwd()` — the repo the suite was launched from.
  const { rt } = await openWorkspaceCLI(db, dbPath, { llm: opts.llm, hostRoot: null });

  // Before anything is driven or spent: a runtime that cannot execute is not a
  // measurement of an agent that can, and one that can execute on the
  // developer's machine is not a measurement either.
  requireExecutorSurface(task.id, rt);
  requireSandboxedExecutors(task.id, rt);

  // Seeded through the OPENED runtime's filesystem: the workspace the agent
  // reads is the one this runtime owns, not the inline VFS birth returned.
  const hard: HardTask | undefined = hardTaskFor(task);
  const shell = hard === undefined ? undefined : requireVerifierShell(task.id, rt);
  if (hard !== undefined) await seedHardTask(hard, rt.storage.vfs);
  if (task.tags?.includes('workspace')) await seedWorkspaceTree(rt);

  const session = new LocalAgentSession({
    rt, db, model: opts.model, onEvent: () => {},
    // The arm, not a convenience default: a run whose evolution was off is not a
    // measurement of evolution, and the run record says which it was.
    noAutoEvolve: !opts.arm.evolution,
    oneShot: true,
  });
  await session.send(task.task);
  await session.settleBackgroundWork();

  // WHAT THIS EPISODE COST, registered BEFORE the degenerate check below, because
  // a trajectory that produced nothing gradable still burned the tokens it took
  // to produce nothing: an `inert` episode whose spend is dropped on the throw is
  // the same lie in a smaller font. This suite drives a session rather than
  // calling `generateText`, so the store is the only place its usage exists —
  // `recordLiveModelEpisode` reads it through the workspace-spend seam, which is
  // why the behavioural tier no longer reports `0 model call(s)` over an episode
  // that spent hundreds of thousands of neurons.
  recordLiveModelEpisode(makeSql(db));

  const totals = readLedgerTotals(db);

  // DESIGN C — upstream of both `task.meta.eval` writers, because it throws
  // before `run(...)` returns. A degenerate trajectory is `inert`, never a zero.
  if (totals.turns === 0 || totals.toolCalls === 0) {
    throw new DegenerateRunError(task.id, totals.turns, totals.toolCalls, totals.failures);
  }

  // The OUTCOME, measured over the workspace the agent left behind and nothing
  // else — no trajectory, no model, no judge. It goes in the same `scores` array
  // as the mechanism covariates because `task_outcome` is a row NAME rather than a
  // parallel mechanism, which is what lets it inherit persistence, the paired
  // comparator and admissibility without a second statistics path.
  //
  // Measured AFTER `readLedgerTotals` on purpose: the verifier runs commands
  // through `rt.shell`, and reading the ledger first keeps the turn and tool-call
  // counts a property of the agent's episode rather than of its grading.
  const outcome: EvalScoreRow[] = hard === undefined || shell === undefined
    ? []
    : [await verifyHardTask(hard, {
      vfs: rt.storage.vfs,
      exec: (command) => shell.exec(command),
    })];

  return {
    taskId: task.id,
    turns: totals.turns,
    toolCalls: totals.toolCalls,
    toolNames: totals.toolNames,
    scores: toScoreJson([...outcome, stepCapRow(totals.steps), ...scoreTrajectory(makeSql(db))]),
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
  };
}
