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
  AgentRuntime, EvalCase, LLMProviderConfig, RunEvent,
} from '../../packages/core/src/index.js';
import { RunEventRecorder, initWorkspaceSchema } from '../../packages/core/src/index.js';
import { createWorkspace } from '../../packages/core/src/identity/index.js';
import { LocalAgentSession } from '../../packages/cli-backend/src/local-session.js';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open.js';
import { makeSql, makeWorkspaceSchemaSql } from '../../packages/cli-backend/src/runtime.js';
import { scoreTrajectory, type EvalArmState, type EvalScoreRow } from '@proteus/test-utils';

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

/** Project the persisted rows onto the wire shape. Fresh literals, so the
 *  index-signature target is satisfied without a cast. */
function toScoreJson(rows: readonly EvalScoreRow[]): BehaviourScoreJson[] {
  return rows.map((row) => ({
    name: row.name, asserts: row.asserts, eligible: row.eligible,
    passed: row.passed, rate: row.rate, detail: row.detail,
  }));
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
  /** Why a turn produced nothing. A degenerate run that cannot say why is a dead
   *  end for whoever reads the record: "0 tool calls" is equally consistent with
   *  a model that declined to act and a provider that rejected every request. */
  failures: string[];
}

function readLedgerTotals(db: Database): LedgerTotals {
  const recorder = new RunEventRecorder(makeSql(db));
  const events: RunEvent[] = recorder.listRuns(10_000)
    .flatMap((run) => recorder.read(run.runId, { limit: 100_000 }));
  let turns = 0, toolCalls = 0, tokensIn = 0, tokensOut = 0;
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
    } else if (event.type === 'error') {
      failures.push(event.message);
    } else if (event.type === 'run_end' && event.error != null && event.error !== '') {
      failures.push(`run_end: ${event.error}`);
    }
  }
  return { turns, toolCalls, toolNames, tokensIn, tokensOut, failures };
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
  const { rt } = await openWorkspaceCLI(db, dbPath, { llm: opts.llm });

  // Before anything is driven or spent: a runtime that cannot execute is not a
  // measurement of an agent that can.
  requireExecutorSurface(task.id, rt);

  // Seeded through the OPENED runtime's filesystem: the workspace the agent
  // reads is the one this runtime owns, not the inline VFS birth returned.
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

  const totals = readLedgerTotals(db);

  // DESIGN C — upstream of both `task.meta.eval` writers, because it throws
  // before `run(...)` returns. A degenerate trajectory is `inert`, never a zero.
  if (totals.turns === 0 || totals.toolCalls === 0) {
    throw new DegenerateRunError(task.id, totals.turns, totals.toolCalls, totals.failures);
  }

  return {
    taskId: task.id,
    turns: totals.turns,
    toolCalls: totals.toolCalls,
    toolNames: totals.toolNames,
    scores: toScoreJson(scoreTrajectory(makeSql(db))),
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
  };
}
