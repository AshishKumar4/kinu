/**
 * The behaviour harness's WIRING, against a scripted model.
 *
 * Three of the eight behaviour scorers reported `0 eligible` across both live
 * flash runs, and "the corpus never created the opportunity" and "the mechanism
 * is not wired in the path the harness builds" predict that same zero. This
 * suite is what tells them apart, and it costs nothing: no credential, no model
 * call, no skip. The corpus cannot answer the question because a zero from a
 * corpus gap and a zero from a dead dependency look identical in a run record.
 *
 * WHAT EACH TEST GUARDS, stated plainly because a test whose failure mode is
 * unclear gets deleted by the next person:
 *
 *   craft_reuse         the harness runs the OPENED runtime, not the degraded
 *                       one `createWorkspace` returns. Revert that and every
 *                       `execute_tools` block fails with `workspace.createTool
 *                       is not a function`, and this test goes red.
 *   completion_honesty  the harness declares `oneShot`, the only thing that arms
 *                       the gate, and settles the pump so the gate's confirming
 *                       turn can close and write its row.
 *   spill_retrieval     the budget ledger reaches the scorer at all. This one
 *                       fires in either runtime — it is the reachability floor
 *                       for the scorer, not a guard on the runtime swap.
 */
import { describe, test, expect, afterAll, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import * as v from 'valibot';

import type { AgentRuntime, EvalCase, LLMProviderConfig, RunEvent, SeekCursor } from '../../packages/core/src/index';
import {
  censusToolFailures, classifyToolFailure, DefaultExecutionRouter, initWorkspaceSchema,
  listRuns, RunEventRecorder,
} from '../../packages/core/src/index';
import { DIGEST_LIMIT, JsonObjectSchema } from '../../packages/core/src/utils/json';
import { createWorkspace } from '../../packages/core/src/identity/index';
import { makeSql, makeWorkspaceSchemaSql } from '../../packages/cli-backend/src/runtime';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import {
  HARD_TASKS, liveModelSpend, recordLiveModelEpisode, resetLiveModelSpend,
  REFERENCE_FILE, SOLUTION_FILE, hardTaskCases, type EvalArmState,
} from '@proteus/test-utils';

import {
  DegenerateRunError, DegenerateRuntimeError, requireExecutorSurface,
  requireSandboxedExecutors, runBehaviourTask, UnsandboxedRuntimeError,
  type BehaviourScoreJson,
} from './harness';
import { parseSpend, renderSpend } from '../../scripts/eval-spend';

const LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const ARM: EvalArmState = {
  evolution: true,
  settle: 'none',
  tools: ['execute_tools', 'run', 'file', 'agents', 'memory', 'tasks', 'web', 'report'],
};

/**
 * One scripted tool call. Spelled as a union over the two tools these fixtures
 * drive rather than an open dictionary, so a typo in an argument name is a
 * compile error instead of a tool call the spine rejects at runtime — which
 * would read as the mechanism being unwired, the exact confusion this suite
 * exists to resolve.
 */
type ScriptedStep =
  | { readonly tool: 'execute_tools'; readonly input: { readonly code: string } }
  | { readonly tool: 'run'; readonly input: { readonly command: string } }
  | {
      readonly tool: 'file';
      readonly input: {
        readonly action: 'read' | 'write' | 'edit';
        readonly path: string;
        readonly content?: string;
        readonly edits?: ReadonlyArray<{ readonly old_text: string; readonly new_text: string }>;
      };
    };

/**
 * The model contract this fake implements, and the stream parts that go with it.
 *
 * BOTH derived from the same branch of `LanguageModel` — the type
 * `runBehaviourTask` actually accepts — because that union spans TWO spec
 * versions (`LanguageModelV3 | LanguageModelV2`). Mixing them does not
 * typecheck: `@proteus/test-utils`'s exported `ModelStreamPart` is derived from
 * the whole union, so it is a cross-spec part union that satisfies neither
 * branch on its own. Naming one branch here keeps the model and its parts in
 * agreement by construction, and needs no assertion.
 *
 * v2 rather than v3 because that is what the spine drives today and what every
 * other fake in this repo implements (`TestLanguageModelV2`).
 */
type ModelV2 = Extract<LanguageModel, { specificationVersion: 'v2' }>;
type StreamPartV2 =
  Awaited<ReturnType<ModelV2['doStream']>>['stream'] extends ReadableStream<infer Part>
    ? Part
    : never;

/**
 * A model that issues one tool call per step, in order, then answers.
 *
 * One turn, many steps, nobody replying — the long-episode shape in miniature,
 * which is the only shape in which the in-episode craft loop can close.
 */
function scripted(steps: readonly ScriptedStep[]): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let index = 0;
  const model: ModelV2 = {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('scripted model streams only')),
    doStream: () => {
      const step = steps[index];
      index += 1;
      return Promise.resolve({
        stream: new ReadableStream<StreamPartV2>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            if (step) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: `call-${String(index)}`,
                toolName: step.tool,
                input: JSON.stringify(step.input),
              });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            }
            controller.close();
          },
        }),
        response: { headers: {} },
      });
    },
  };
  return model;
}

const dir = mkdtempSync(join(tmpdir(), 'harness-wiring-'));
const opened: Database[] = [];

// The harness hands back every store it opened and closes none of them, because
// the live suite reads them after the last task. Nothing else closes these, so a
// plain close is correct and a swallowed failure here would hide a leak.
//
// The meter is cleared for a different reason: every case in this file drives a
// real episode against a SCRIPTED model, and `bun test ./tests/` shares one
// process — and therefore one meter — with the live suites. Left in place, these
// fake tokens would be claimed by whichever live suite reported next and would
// land in the tier's published cost. Measured before this line existed: the
// skipped `Delegation Evals` teardown printed this file's `42 model call(s),
// 210 in / 294 out`.
afterAll(() => {
  resetLiveModelSpend();
  for (const db of opened) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function scoreOf(scores: readonly BehaviourScoreJson[], name: string): BehaviourScoreJson {
  const found = scores.find((s) => s.name === name);
  if (!found) throw new Error(`no ${name} score — scoreTrajectory stopped reporting it`);
  return found;
}

async function runCase(
  task: EvalCase, steps: readonly ScriptedStep[],
): Promise<readonly BehaviourScoreJson[]> {
  const out = await runBehaviourTask(task, {
    dir, model: scripted(steps), llm: LLM, arm: ARM, opened,
  });
  return out.scores;
}

/** `tags` reaches `runBehaviourTask`, which seeds the source tree only for a
 *  `workspace` case — an unseeded tree makes a `file` refusal read `missing`
 *  (the path is not there) instead of the contract reason under test. */
async function run(
  id: string, steps: readonly ScriptedStep[], tags?: readonly string[],
): Promise<readonly BehaviourScoreJson[]> {
  return runCase(tags ? { id, task: 'do the task', tags: [...tags] } : { id, task: 'do the task' }, steps);
}

const CREATE_DOUBLE =
  'await workspace.createTool("doubleIt", "doubles a number", "async (n) => n * 2"); return "made";';

describe('behaviour harness wiring — the three scorers that read zero live', () => {
  test('craft_reuse: the harness binds the workspace provider, so a tool crafted mid-turn is callable', async () => {
    const scores = await run('wiring-craft', [
      { tool: 'execute_tools', input: { code: CREATE_DOUBLE } },
      { tool: 'execute_tools', input: { code: 'return await codemode.doubleIt(21);' } },
    ]);

    const craft = scoreOf(scores, 'craft_reuse');
    // The denominator is the whole point: on the degraded runtime this is 0
    // because `workspace.createTool` is undefined, and a 0/0 reads as "the
    // corpus never asked" rather than "the dependency is missing".
    expect(craft.eligible).toBeGreaterThan(0);
    expect(craft.passed).toBe(craft.eligible);

    // And the loop really closed rather than the row merely existing.
    expect(craft.detail).toContain('1/1 crafted tools reused');
  }, 30_000);

  test('completion_honesty: a one-shot task turn arms the gate and the confirming turn closes', async () => {
    const scores = await run('wiring-gate', [
      { tool: 'file', input: { action: 'write', path: 'notes.txt', content: 'done' } },
    ]);

    const honesty = scoreOf(scores, 'completion_honesty');
    // Armed only by `oneShot` (local-session.ts:1514), and the row is written
    // only once the gate's own confirming turn closes — which happens after
    // `send` resolves, so it needs the pump settled.
    expect(honesty.eligible).toBeGreaterThan(0);
  }, 30_000);

  test('spill_retrieval: bulk output the budget spilled reaches the scorer with a readable address', async () => {
    // Written and read back in the same turn, so the fixture carries its own
    // bulk rather than depending on what a corpus environment happens to seed.
    const bulk = 'x'.repeat(400_000);
    const scores = await run('wiring-spill', [
      { tool: 'file', input: { action: 'write', path: 'huge.txt', content: bulk } },
      { tool: 'file', input: { action: 'read', path: 'huge.txt' } },
    ]);

    const spill = scoreOf(scores, 'spill_retrieval');
    // `referenced` is the denominator — a trip whose payload stayed addressable.
    // A read that omits nothing produces 0 here, which is why the corpus's
    // ~150-char files could never score it.
    expect(spill.eligible).toBeGreaterThan(0);
    expect(spill.detail).toContain('readable spills');
  }, 30_000);

  test('the harness REFUSES a runtime with no executor surface, before spending anything', async () => {
    // The positive direction is covered by the three tests above: they all run,
    // which means the real harness path satisfies the precondition. What this
    // pins is that the precondition can actually FAIL — a refusal that cannot
    // fire is the silent zero it exists to replace.
    const rt = await createWorkspace(new Database(':memory:'), {
      name: 'no-executor', purpose: 'birth runtime', llm: LLM,
    });

    // The exact runtime two live runs were graded on.
    expect(rt.executionRouter).toBeUndefined();
    expect(() => requireExecutorSurface('probe', rt)).toThrow(DegenerateRuntimeError);

    // A router that exists but registered nothing is the same hazard, and the
    // one `router?.getProviders() ?? []` hides rather than reports.
    const empty: AgentRuntime = { ...rt, executionRouter: new DefaultExecutionRouter() };
    expect(empty.executionRouter?.getProviders()).toHaveLength(0);
    expect(() => requireExecutorSurface('probe', empty)).toThrow(/zero registered providers/);

    // And it is NOT filed as an inert agent — that bucket means the agent did
    // nothing, not that the harness was broken (behaviour.eval.ts:281).
    expect(new DegenerateRuntimeError('t', 'r')).not.toBeInstanceOf(DegenerateRunError);
  }, 30_000);
});

/**
 * EPISODE ISOLATION — an episode may not reach the developer's own filesystem.
 *
 * A live run left `scratch-add/{add.js,add.test.js}` in a worktree ROOT and two
 * committed stray files (`report.txt`, `todos.txt`) in the repo root, and
 * `gate:typecheck-coverage` refused the commit that swept them up. The cause is
 * not the corpus: `createCLIRuntime` registered a `laptop` ExecutorProvider
 * rooted at `process.cwd()` (cli-backend/src/runtime.ts:380 before this change),
 * so every episode the harness opened could write anywhere the developer can.
 *
 * WHY THE PLANE HAS TO BE ABSENT RATHER THAN RE-ROOTED. `laptop.writeFile`
 * resolves its argument with `resolve(cwd, path)`, which passes an ABSOLUTE path
 * straight through, and `laptop.exec` runs a real shell that can `cd` anywhere.
 * Rooting that provider at the episode's temp directory would contain neither.
 * Containment on the host plane needs a sandbox the CLI does not have, so an
 * eval episode gets no host plane at all and works in the workspace filesystem
 * — which is what the harness header already says it measures.
 */
describe('episode isolation — no plane outside the episode sandbox', () => {
  test('an episode that tries to write on the host writes nothing and is refused', async () => {
    // An ABSOLUTE path under the developer's cwd, which is what escaped. Cleaned
    // up front so a leftover from a previous red run cannot pass this.
    const probe = join(process.cwd(), '.eval-host-escape-probe');
    rmSync(probe, { recursive: true, force: true });

    await run('wiring-isolation', [
      { tool: 'execute_tools', input: { code:
        `await laptop.writeFile(${JSON.stringify(join(probe, 'add.js'))}, "escaped"); return "wrote";` } },
      { tool: 'execute_tools', input: { code:
        `return await laptop.exec(${JSON.stringify(`mkdir -p ${probe} && echo escaped > ${join(probe, 'add.test.js')}`)});` } },
    ]);

    // The assertion the stray files would have failed.
    expect(existsSync(probe)).toBe(false);

    // And it failed for the RIGHT reason: the episode really issued both calls
    // and both were refused, rather than the fixture never reaching the host.
    const db = opened[opened.length - 1];
    if (!db) throw new Error('the harness opened no store');
    const rows = toolCallRows(db).filter((r) => r.name === 'execute_tools');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // An absent binding comes back as a result the tool called an error, not
      // as a thrown call — the `returned_error` class named in
      // read-models/tool-failures.ts:230-232. Asserting the class rather than a
      // string keeps this from passing on a call that never ran.
      expect(classifyToolFailure(row)?.reason).toBe('returned_error');
      expect(JSON.stringify(row.result)).toContain('laptop');
    }
  }, 30_000);

  test('the harness REFUSES a runtime carrying a host plane, before spending anything', async () => {
    const dbPath = join(dir, 'unsandboxed.db');
    const db = new Database(dbPath);
    opened.push(db);
    await createWorkspace(db, { name: 'unsandboxed', purpose: 'host plane probe', llm: LLM });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));

    // The default — what every interactive CLI surface wants and what the
    // harness used to get by omission. `listExecutors` is the read that carries
    // `kind`; the codemode surface drops it (execution/router.ts:38-52).
    const hosted = await openWorkspaceCLI(db, dbPath, { llm: LLM });
    expect(hosted.rt.executionRouter?.listExecutors().map((e) => e.kind)).toContain('laptop');
    expect(() => requireSandboxedExecutors('probe', hosted.rt)).toThrow(UnsandboxedRuntimeError);

    // What the harness asks for, and what the cases above prove still executes:
    // the workspace plane, and no host plane.
    const sandboxed = await openWorkspaceCLI(db, dbPath, { llm: LLM, hostRoot: null });
    expect(sandboxed.rt.executionRouter?.listExecutors().map((e) => e.kind)).toEqual(['workspace']);
    expect(sandboxed.rt.executionRouter?.getProviders().map((p) => p.name)).toEqual(['workspace']);
    expect(() => requireSandboxedExecutors('probe', sandboxed.rt)).not.toThrow();

    // A misconfigured harness is not an inert agent (behaviour.eval.ts:347).
    expect(new UnsandboxedRuntimeError('t', 'laptop')).not.toBeInstanceOf(DegenerateRunError);
  }, 30_000);
});

/**
 * ATTRIBUTION, END TO END ON A REAL TURN.
 *
 * The three tests above prove the harness reaches an executor. These prove the
 * ledger can say WHY a call failed, which is a different claim and was the one
 * that could not be answered: run flash-a published 23 failures out of 126 calls
 * and could not name a single tool, action or reason behind them.
 *
 * Deliberately read off the RETAINED STORE rather than off the scorer's string,
 * through `RunEventRecorder` — the canonical union — so what is asserted is that
 * `args` survived the real sink on a real turn. A unit test over hand-built rows
 * cannot show that: `tool_call_end` carried no `args` column at all, and
 * `tool_call_start`, the type every earlier counter read, is emitted by nothing.
 */
function toolCallRows(db: Database): Extract<RunEvent, { type: 'tool_call_end' }>[] {
  const recorder = new RunEventRecorder(makeSql(db));
  // A walk, for the same reason readLedgerTotals walks: an episode's rows are
  // the whole assertion, and a window over them would make a missing `args`
  // indistinguishable from a row the read never reached.
  const events: RunEvent[] = [];
  let cursor: SeekCursor | null = null;
  for (;;) {
    const page = listRuns(recorder, cursor);
    for (const run of page.items) events.push(...recorder.read(run.runId, { limit: 100_000 }));
    if (page.status === 'end') break;
    cursor = page.next;
  }
  return events.filter(
    (e): e is Extract<RunEvent, { type: 'tool_call_end' }> => e.type === 'tool_call_end',
  );
}

describe('tool-failure attribution over a real turn', () => {
  test('every failure is attributed to its tool, action and reason, split three ways', async () => {
    // One episode covering all three classes, so the split is proven by
    // CONTRAST rather than by three runs that each show one bucket.
    await run('attrib-mixed', [
      // (1) A CORRECT REFUSAL: edit before read. The read-before-write contract
      // — the caller does not know what it would discard.
      { tool: 'file', input: {
        action: 'edit', path: 'src/greet.ts',
        edits: [{ old_text: 'Hello', new_text: 'Hi' }],
      } },
      // (2) A CORRECT REFUSAL of a different reason: read first, then an anchor
      // that is not in the file, so a splice would be a guess at where to write.
      { tool: 'file', input: { action: 'read', path: 'src/greet.ts' } },
      { tool: 'file', input: {
        action: 'edit', path: 'src/greet.ts',
        edits: [{ old_text: 'no such anchor anywhere', new_text: 'x' }],
      } },
      // (3) THE WORK FAILING: a command that RAN and exited non-zero. `node` is
      // present on this path (`which node` => /usr/local/bin/node), so this is
      // an honest stand-in for a failing suite. `bun test …` would NOT be:
      // `bun` is absent here and exits 127, which is class (4). That is not a
      // transient — bun is registered only by the HOSTED Nimbus session and has
      // no installable runtime package — and it is why `ws-fix-broken`'s
      // failures are a platform gap rather than the agent finding a broken test.
      { tool: 'run', input: { command: 'node -e "process.exit(1)"' } },
      // (4) THE WORKSPACE HAS NO SUCH PROGRAM: the shell's own 127. Nothing ran
      // the work, and nothing is broken — the program was never there.
      { tool: 'run', input: { command: 'definitely-not-a-real-command --x' } },
    ], ['workspace']);

    const db = opened[opened.length - 1];
    if (!db) throw new Error('the harness opened no store');
    const rows = toolCallRows(db);
    const census = censusToolFailures(rows);
    // The published pairs, indexed for lookup — asserted on the shape the run
    // record actually carries rather than on a recomputed one.
    const keys: Record<string, number> = Object.fromEntries(census.byKey);

    // ARGS SURVIVED THE SINK. Without this the rest is unreachable: an action is
    // read from the call's own args, and a row without them attributes `file×N`
    // with a null action. A dispatcher call is a handful of short scalars, so
    // `digestJsonValue` keeps it a QUERYABLE OBJECT rather than a string — the
    // action is read as a field, and the bound still holds.
    const fileRows = rows.filter((r) => r.name === 'file');
    expect(fileRows.length).toBeGreaterThan(0);
    for (const row of fileRows) {
      const args = v.parse(JsonObjectSchema, row.args);
      expect(args.action).toBeTypeOf('string');
      expect(JSON.stringify(args).length).toBeLessThanOrEqual(DIGEST_LIMIT + 1);
    }

    // (1) and (2): named by ACTION, not just by tool — `file·edit·…`, never
    // `file×2`, which is what a ledger built on the tool name alone reported.
    expect(keys['file·edit·unread']).toBe(1);
    expect(keys['file·edit·not_found']).toBe(1);

    // (3) the work failing and (4) the tool never running it are DIFFERENT rows
    // with different reasons, both under `run`, which has no action.
    expect(keys['run·exit_1']).toBe(1);
    expect(keys['run·command_not_found']).toBe(1);

    // THE SPLIT, four disjoint ways. Pooling these into "4 failures" is what
    // made a working FAIL-loudly contract read as four defects — and folding the
    // 127 into `broke` would have blamed the tool for a workspace that simply
    // has no such program.
    expect(census.refused).toBe(2);
    expect(census.workFailed).toBe(1);
    expect(census.runtimeMissing).toBe(1);
    expect(census.broke).toBe(0);
    // Disjoint and exhaustive by construction — the property the report relies on.
    expect(census.refused + census.workFailed + census.runtimeMissing + census.broke)
      .toBe(census.failures.length);

    // And the successful read is NOT counted: a census of failures, not of calls.
    // This is the exact defect in the published histogram, which summed to
    // `eligible` because it was built over every row.
    expect(census.failures.length).toBe(4);
    expect(rows.length).toBeGreaterThan(census.failures.length);
  }, 60_000);
});

/**
 * The hard-task seam, end to end through the real harness, with a scripted model.
 *
 * `hard-tasks.test.ts` proves the VERIFIER: what a solution scores, and that five
 * distinct failures score zero. This proves the WIRING around it — that
 * `EvalCase.env` resolves to a task, that the task's files land in the workspace
 * the agent actually reads, and that the verdict comes back as the primary-metric
 * row — and it proves it before a single paid episode, because the cost of
 * discovering this from a live run is a live run.
 *
 * The cheapest task by target cost is used and is chosen at runtime: the seam is
 * identical for all of them, and naming one here would make a corpus edit fail in
 * a file that is about wiring.
 */
describe('hard-task wiring — env resolves to a seeded task and a scored outcome', () => {
  const task = HARD_TASKS.reduce((cheapest, t) =>
    (t.problem.targetOps < cheapest.problem.targetOps ? t : cheapest));
  const evalCase = hardTaskCases().find((c) => c.id === task.id);
  if (!evalCase) throw new Error(`${task.id} produced no eval case`);
  const reference = task.seed.find((f) => f.path === REFERENCE_FILE);
  if (!reference) throw new Error(`${task.id} seeds no reference`);

  test('the reference is readable, the stub is replaceable, and the result is measured', async () => {
    // Content taken from the task, never retyped: if the seeded reference and the
    // one the harness measures against could differ, this test would be the place
    // the difference hid. The read of SOLUTION_FILE is not decoration — the file
    // tool's read-before-write gate refuses a blind overwrite, which is exactly
    // what a real agent has to do too, and what the prompt now says.
    const scores = await runCase(evalCase, [
      { tool: 'file', input: { action: 'read', path: REFERENCE_FILE } },
      { tool: 'file', input: { action: 'read', path: SOLUTION_FILE } },
      { tool: 'file', input: { action: 'write', path: SOLUTION_FILE, content: reference.content } },
    ]);

    const outcome = scoreOf(scores, 'task_outcome');
    // Zero is the CORRECT score for matching the reference. What proves the seam
    // is that the candidate was measured at all: a broken seam reports "no usable
    // solution" with candOps 0, and this reports the reference's own cost.
    expect(outcome.rate).toBe(0);
    expect(outcome.detail).toMatch(/^(\d+) oracle calls vs reference \1 \(1\.00x\)/);

    // The raw counts must survive as STRUCTURE, not only inside the sentence.
    // `toScoreJson` dropped `measured` originally, so the first live pilot's
    // numbers had to be recovered by parsing English out of `detail`. A ratio
    // whose baseline does not survive beside it cannot be re-derived.
    expect(outcome.measured).toMatchObject({
      refOps: expect.any(Number),
      candOps: expect.any(Number),
      targetOps: task.problem.targetOps,
      lowerBoundOps: task.problem.lowerBoundOps,
    });
  }, 60_000);

  test('leaving the seeded stub in place scores 0 with the reason, not a missing row', async () => {
    const scores = await runCase(evalCase, [
      { tool: 'file', input: { action: 'write', path: 'notes.txt', content: 'thinking about it' } },
    ]);

    const outcome = scoreOf(scores, 'task_outcome');
    expect(outcome.rate).toBe(0);
    // The stub the task seeds throws, so the zero names the agent's omission
    // rather than the harness's.
    expect(outcome.detail).toContain('not implemented');
  }, 60_000);

  test('a case with no env carries NO task_outcome — an unverified pair, not a loss', async () => {
    const scores = await run('wiring-unverified', [
      { tool: 'file', input: { action: 'write', path: 'notes.txt', content: 'x' } },
    ]);
    // The comparator drops such a pair BY NAME (`baseline-unverified`). Charging
    // it as a zero would turn a missing verifier into a fact about the agent.
    expect(scores.find((s) => s.name === 'task_outcome')).toBeUndefined();
  }, 30_000);

  test('step_cap_reached counts real steps, so the pre-registered cap is measurable', async () => {
    const scores = await run('wiring-stepcap', [
      { tool: 'file', input: { action: 'write', path: 'a.txt', content: '1' } },
      { tool: 'file', input: { action: 'write', path: 'b.txt', content: '2' } },
    ]);

    const cap = scoreOf(scores, 'step_cap_reached');
    expect(cap.eligible).toBe(1);
    // `step_finish` is emitted at local-session.ts:560. A covariate that reports 0
    // of N steps forever is the "declared and emitted by nothing" failure, and
    // this is the assertion that would catch it.
    expect(cap.detail).toMatch(/^[1-9]\d* of \d+ steps closed/);
    // Nowhere near the default 500-step budget, so this episode was not truncated.
    expect(cap.passed).toBe(0);
  }, 30_000);
});

/**
 * WHAT THE EPISODE COST, proven on a scripted model so the proof itself is free.
 *
 * The behavioural tier used to report `0 model call(s), unreported in / unreported
 * out tokens` for runs that spent hundreds of thousands of neurons — one measured
 * live run cost ~584,751 and had to be recomputed by hand out of `turn_end.usage`
 * in the retained stores. The cause was structural rather than arithmetic:
 * `recordLiveModelSpend` is fed by the five suites that call `generateText`
 * themselves and hold the SDK result, and this tier drives a `LocalAgentSession`
 * instead, so nothing ever reached the meter and `calls` was pinned at 0 by
 * construction.
 *
 * These assert the two halves that make that unrepeatable: an episode's spend
 * arrives in the meter from the store the session wrote, and a zero can no longer
 * be produced by silence. Both run on `scripted()`, whose steps report a fixed
 * usage, so the numbers below are arithmetic on a known input rather than a live
 * bill — the whole point being that discovering this from a live run costs a live
 * run.
 */
describe('episode spend — the meter is fed by the session, not by silence', () => {
  // Every case above drove an episode into the same process-global meter, so this
  // block starts from a known zero and asserts ABSOLUTES. Delta arithmetic against
  // whatever the file happened to have accumulated would make these assertions
  // weaker the more cases the file grew.
  beforeAll(() => { resetLiveModelSpend(); });

  test('a driven episode contributes its real measured usage to the meter', async () => {
    await run('wiring-spend', [
      { tool: 'file', input: { action: 'write', path: 'a.txt', content: '1' } },
      { tool: 'file', input: { action: 'write', path: 'b.txt', content: '2' } },
    ]);
    const spent = liveModelSpend();

    // THE REGRESSION, in one line: this was 0 for every behavioural episode ever
    // run. Not a fixed count — the session closes a step per scripted tool call
    // plus the answering step, and a bound rather than an equality keeps this
    // asserting "the spend arrived" instead of pinning the turn loop's step
    // shape, which is not what this file is about.
    expect(spent.calls).toBeGreaterThan(0);

    // `scripted()` reports inputTokens 5 / outputTokens 7 on every step, so the
    // tokens are the step count times a known rate: the meter is carrying the
    // provider's own numbers through, not a placeholder that happens to be
    // non-zero.
    expect(spent.usage.input).toBe(spent.calls * 5);
    expect(spent.usage.output).toBe(spent.calls * 7);

    // Every step of a scripted episode reports usage, so nothing here is a floor
    // and nothing is unaccounted. Those two are what a real provider's silence
    // would move, and they must be quiet when it does not.
    expect(spent.callsWithoutUsage).toBe(0);
    expect(spent.episodesUnmeasured).toBe(0);
  }, 30_000);

  test('an episode that spends and reports nothing is labelled, never a clean 0', () => {
    const callsBefore = liveModelSpend().calls;
    // A store with the FULL workspace schema and no model-call rows in it. Not a
    // schema-less file: an unreadable store is a broken workspace and would throw,
    // and the shape this has to catch is the one the whole bug wore — a store that
    // reads cleanly and answers "nothing" for both "cost nothing" and "was never
    // wired to the meter".
    const empty = new Database(join(dir, 'unaccounted.db'));
    opened.push(empty);
    initWorkspaceSchema(makeWorkspaceSchemaSql(empty));
    recordLiveModelEpisode(makeSql(empty));
    const spent = liveModelSpend();

    // The episode did NOT silently add a zero to the call count...
    expect(spent.calls).toBe(callsBefore);
    // ...it is on the books as a hole, which is the sentence `calls: 0` could
    // never say on its own.
    expect(spent.episodesUnmeasured).toBe(1);
  });

  /**
   * THE SURFACE THE OWNER READS: the meter -> the JSONL line a suite teardown
   * appends -> the rendered tier cost. Run LAST in this block on purpose, so it
   * renders the accumulation of the measured episode above PLUS the unaccounted
   * one — the mixed state a live run actually arrives in, and the state whose
   * rendering was previously a bare `0`.
   *
   * Rendered from the in-memory meter rather than by calling
   * `reportLiveModelSpend` and reading its file: that would publish this file's
   * scripted tokens into whatever `PROTEUS_EVAL_SPEND_FILE` the eval tier has
   * exported, which is the tier's real cost report. The `JSON.stringify` here IS
   * the line `reportLiveModelSpend` writes, so the serialization is still under
   * test — without a test writing to the run's ledger of what it spent.
   */
  test('the rendered tier cost states both the measured spend and the hole', () => {
    const total = liveModelSpend();
    // Named as a precondition rather than left to fail as a render bug: this case
    // reads the state the two above left behind, so if the block is ever
    // reordered the failure says so instead of pointing at `renderSpend`.
    expect(total.calls, 'the measured episode must have run before this case')
      .toBeGreaterThan(0);
    expect(total.episodesUnmeasured, 'the unaccounted episode must have run before this case')
      .toBe(1);

    const line = JSON.stringify({ suite: 'Behaviour Evals', ...total });
    const rendered = renderSpend(parseSpend(`${line}\n`));
    // Printed so the run's own output is the evidence: this block is what
    // `bun scripts/eval-spend.ts` puts in front of the owner.
    console.log(`\n${rendered}\n`);

    // The measured tokens survived the JSONL round trip — a `usage` that failed to
    // serialize would render as `unreported` while the meter held real numbers, so
    // its presence is asserted before its value is used to search the output.
    const measuredInput = total.usage.input;
    expect(measuredInput, 'the measured episode reported input tokens').toBeDefined();
    expect(rendered).toContain(`${String(total.calls)} model call(s)`);
    expect(rendered).toContain(`${String(measuredInput)} input`);
    // And the hole is named on both the suite line and the total. `not.toContain`
    // on the zero was tried here and removed: `40 model call(s)` contains the
    // substring `0 model call(s)`, so it would have gone red on an episode that
    // happened to close a multiple of ten steps. The clean zero is refused by a
    // fixed-input case in scripts/eval.test.ts, where the count cannot drift.
    expect(rendered).toContain('1 EPISODE(S) UNACCOUNTED');
    expect(rendered).toContain('NOT A TOTAL');
  });
});
