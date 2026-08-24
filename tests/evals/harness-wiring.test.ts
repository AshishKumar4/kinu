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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { generateText, stepCountIs, type LanguageModel } from 'ai';

import type { AgentRuntime, AgentsToolAction, EvalCase, LLMProviderConfig, RunEvent, SeekCursor } from '../../packages/core/src/index';
import {
  CRAFT_NEUTRAL_PRIOR,
  censusToolFailures, classifyToolFailure, compareSurface, DefaultExecutionRouter,
  initWorkspaceSchema, listRuns, observedActionEnum, renderConformanceFindings,
  RunEventRecorder,
} from '../../packages/core/src/index';
import { DIGEST_LIMIT, JsonObjectSchema } from '../../packages/core/src/utils/json';
import { createWorkspace } from '../../packages/core/src/identity/index';
import { makeSql, makeWorkspaceSchemaSql, type CLIRuntime } from '../../packages/cli-backend/src/runtime';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import {
  HARD_TASKS, liveModelSpend, recordLiveModelEpisode, resetLiveModelSpend,
  hardTaskCases, toolExecute, type EvalArmState,
} from '@kinu.run/test-utils';
// The two file names belong to the measurement substrate, which moved to core so a
// registered verifier kind resolves to code the tool surface can reach.
import { REFERENCE_FILE, SOLUTION_FILE } from '../../packages/core/src/index';

import {
  buildEvalAgentSurface, recordRequestSurface,
  DegenerateRunError, DegenerateRuntimeError, requireExecutorSurface,
  requireSandboxedExecutors, runBehaviourTask, UnsandboxedRuntimeError,
  type BehaviourScoreJson, type EvalAgentSurface,
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
 * typecheck: `@kinu.run/test-utils`'s exported `ModelStreamPart` is derived from
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

/**
 * A real workspace plus the eval agent's surface, built by the production actor
 * root. The scripted model is handed over because `buildEvalAgentSurface` needs
 * one — `agents` is built from deps that carry the model a search expands with —
 * and an empty script is enough: nothing here asks it to answer.
 */
async function openRuntimeProbe(name: string): Promise<{
  db: Database;
  rt: CLIRuntime;
  surface: EvalAgentSurface;
}> {
  const workDir = join(dir, name);
  mkdirSync(workDir, { recursive: true });
  const dbPath = join(workDir, 'agent.db');
  const db = new Database(dbPath, { create: true });
  opened.push(db);
  await createWorkspace(db, {
    name,
    purpose: 'Credential-free eval harness wiring probe.',
    llm: LLM,
  });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const { rt } = await openWorkspaceCLI(db, dbPath, { llm: LLM, hostRoot: null });
  requireSandboxedExecutors(name, rt);
  const surface = buildEvalAgentSurface({ rt, model: scripted([]), llm: LLM });
  return { db, rt, surface };
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

describe('crafted-tool discovery and execution use the production CLI adapter', () => {
  test('workspace.listTools exposes exactly the callable inherited craft set before reuse', async () => {
    const { rt, surface } = await openRuntimeProbe('crafted-production-set');
    const executeEntry = surface.tools.execute_tools;
    if (!executeEntry) throw new Error('the eval surface omitted execute_tools');
    const execute = toolExecute<{ code: string }, unknown>(executeEntry);

    const createDouble = await execute({ code: CREATE_DOUBLE });
    expect(createDouble).toEqual({
      result: { ok: true, name: 'doubleIt', action: 'created' },
    });
    const createIncrement = await execute({
      code: 'await workspace.createTool("increment", "adds one", "async (n) => n + 1"); return "made";',
    });
    expect(createIncrement).toEqual({
      result: { ok: true, name: 'increment', action: 'created' },
    });

    // Discovery first. The model-facing production prompt tells the agent to
    // call this before building from scratch; the proof must therefore reach
    // the same `workspace.listTools()` projection, not inspect CraftStore rows
    // alone and assume the namespace exposes them.
    const listed = v.parse(
      v.object({
        result: v.array(v.object({
          name: v.string(),
          description: v.string(),
          qualityScore: v.number(),
        })),
      }),
      await execute({ code: 'return await workspace.listTools();' }),
    );
    const listedTools = [...listed.result].sort((a, b) => a.name.localeCompare(b.name));
    expect(listedTools).toEqual([
      { name: 'doubleIt', description: 'doubles a number', qualityScore: CRAFT_NEUTRAL_PRIOR },
      { name: 'increment', description: 'adds one', qualityScore: CRAFT_NEUTRAL_PRIOR },
    ]);

    // Set equality with the production store authority: no listed tool is
    // missing from the callable set, and no stored tool is hidden from
    // discovery. This is stronger than a non-zero count.
    const storedNames = rt.craftStore.list().map((tool) => tool.name).sort();
    expect(listedTools.map((tool) => tool.name)).toEqual(storedNames);

    // Callable inherited craft, through the same adapter LocalAgentSession
    // wires. This is the assertion the old craft-cycle count never made: with
    // `craftedToolExecute` absent the metric still said 1/1 while this call
    // returned \"codemode.doubleIt is not a function\".
    expect(await execute({ code: 'return await codemode.doubleIt(21);' }))
      .toEqual({ result: 42 });
    expect(await execute({ code: 'return await tools.increment(41);' }))
      .toEqual({ result: 42 });
  }, 0);
});

/**
 * EVAL/PRODUCTION SET EQUALITY — the gate PRD §9.3 and §9.5 turn on, and the
 * reason the two suites that drive `generateText` directly can no longer be
 * quietly better- or worse-equipped than the product.
 *
 * Judged against `BACKEND_CONFORMANCE`, the repository's existing declaration of
 * which composition root wires which capability, rather than a list retyped
 * here. That matters in the observed-but-undeclared direction: the manifest's
 * `Record<BuiltinToolName, …>` cannot compile when a tool is added without a
 * per-root decision, so a capability that lands on the product and not on the
 * eval surface fails here instead of being discovered by a live run that reports
 * a zero.
 *
 * THE ONE SCOPED PLANE, stated rather than hidden. The manifest's `cli` rows for
 * `hire`/`ask`/`send`/`reply`/`list`/`dismiss` are observed from the HOSTED
 * path: LocalAgentHost installs the team roster and the peer transport after it
 * acquires a session (agent-host/host.ts:352 `setTeam`, :357 `setPeers`). The
 * eval drives the actor DIRECTLY — no daemon — which is the production shape of
 * an unhosted static-model session (`kinu exec`, one-shot): teamDeps and
 * peersDeps are null until a host installs them (local-session.ts:2524-2529), so
 * `agentsActionsFor` yields exactly `['swarm']`. Wiring fake team transports to
 * widen the enum would put actions on the surface that every dispatch throws on
 * — the phantom-surface class this repo gates against. Hosting the evals through
 * LocalAgentHost to measure the hosted surface is a real option and is recorded
 * in the ticket as a follow-up decision; until then this gate holds the tool
 * plane to FULL equality and the action plane to the unhosted resolution,
 * asserted structurally below rather than assumed.
 *
 * Credential-free on purpose. Every failure this gate exists to catch is a
 * WIRING fact, and paying a provider to discover a wiring fact is how three
 * flash runs came to blame a corpus for `craft_reuse eligible 0`.
 */

/** The six actions whose manifest row is observed from the hosted path. A
 *  capability leaves this list only by being wired here for real. */
const HOST_INSTALLED_ACTIONS: readonly AgentsToolAction[] =
  ['hire', 'ask', 'send', 'reply', 'list', 'dismiss'];

describe('the eval agent surface is set-equal to the production cli root', () => {
  test('its tools are exactly what the manifest declares, and its actions match the deps it carries', async () => {
    const { surface } = await openRuntimeProbe('parity-declared-surface');

    // TOOL plane: full set equality in both directions, no scoping. A tool the
    // manifest declares wired and the surface lacks fails here, as does any
    // tool the surface grew without a manifest row.
    const report = compareSurface({
      root: 'cli',
      planes: {
        tool: new Set(Object.keys(surface.tools)),
        'agents-action': observedActionEnum(surface.tools.agents),
      },
    });
    expect(report.findings.filter((f) => f.plane === 'tool')).toEqual([]);

    // ACTION plane: compared against the same enum minus exactly the six
    // host-installed rows named above, so a NEW manifest row cannot silently
    // join the exclusion — the compiler forces it into AgentsToolAction, and
    // this filter would then hide it from the comparison while the assertion
    // below still demands the surface resolve every non-host action it declares.
    const actionFindings = report.findings.filter((f) => f.plane === 'agents-action');
    const scoped = actionFindings
      .filter((f) => !HOST_INSTALLED_ACTIONS.some((action) => action === f.name));
    if (scoped.length > 0 || actionFindings.length > HOST_INSTALLED_ACTIONS.length) {
      console.log(renderConformanceFindings({ ...report, findings: actionFindings }));
    }
    expect(scoped).toEqual([]);

    // The structural half of the scoping claim: the surface carries fork deps
    // and nothing else, so `agentsActionsFor` MUST resolve to swarm alone. If
    // someone later wires team/peers into buildEvalAgentSurface, this exact-
    // equality fails and forces the exclusion list above to shrink with it.
    expect(observedActionEnum(surface.tools.agents)).toEqual(new Set(['swarm']));
    expect([...observedActionEnum(surface.tools.agents)].sort())
      .toEqual([...surface.agentsActions].sort());
    // `swarm` is the rung the exploration and delegation evals measure; its
    // absence would mean the eval had no delegation substrate at all.
    expect(surface.agentsActions).toContain('swarm');

    // The unmeasured planes are stated rather than left implicit: this harness
    // observes the MODEL-FACING surface, and the schema and producer planes
    // belong to a session's own construction. `compareSurface` reports them so
    // an unmeasured plane can never read as a conformant one.
    expect([...report.unmeasured].sort())
      .toEqual(['memory-action', 'producer', 'table']);
  }, 0);

  test('every codemode namespace production wires is reachable from execute_tools', async () => {
    const { surface } = await openRuntimeProbe('parity-codemode-namespaces');
    const executeEntry = surface.tools.execute_tools;
    if (!executeEntry) throw new Error('the eval surface omitted execute_tools');
    const execute = toolExecute<{ code: string }, unknown>(executeEntry);

    // A namespace is proven by CALLING it, not by finding its provider in a
    // list: an unbound namespace fails with `is not a function` at the first
    // call, which is exactly how the crafted-tool gap hid. One cheap read per
    // namespace, no network and no model.
    expect(await execute({ code: 'return typeof agents;' })).toEqual({ result: 'object' });
    expect(await execute({ code: 'return typeof web.search;' })).toEqual({ result: 'function' });
    // `tasks.list` resolves to `{ tasks: [...] }` (tasks-tool.ts:147-163), so the
    // assertion reads that shape rather than guessing an array.
    expect(await execute({ code: 'return Array.isArray((await tasks.list()).tasks);' }))
      .toEqual({ result: true });
    const saved = v.parse(
      v.object({ result: v.string() }),
      await execute({ code: 'await memory.save("parity", "reachable"); return "saved";' }),
    );
    expect(saved.result).toContain('saved');
  }, 0);

  test('the production prompt shows the model the delegation surface it is scored on', async () => {
    const { surface } = await openRuntimeProbe('parity-prompt-projection');
    const system = surface.systemPrompt();

    // The §9.5 precondition. `renderAgentStateSection` (core prompt.ts:236)
    // renders the ladder only when `agents` is on `availableTools`, so a prompt
    // assembled from a ToolSet that could not hold `agents` silently dropped it —
    // and the exploration eval then scored a model on reaching for a capability
    // its prompt never mentioned.
    expect(system).toContain('## Delegation');
    expect(system).toContain('action=swarm');
    // Every builtin on the surface is NAMED in the prompt's tool section, so the
    // two projections cannot disagree about what exists.
    for (const name of surface.builtinTools) expect(system).toContain(name);
  }, 0);

  test('the request evidence reports the tool list the provider actually received', async () => {
    const { rt, surface } = await openRuntimeProbe('parity-request-evidence');
    // `scripted` streams only, because LocalAgentSession drives streamText; this
    // probe drives generateText directly, so it needs the one-shot generate
    const answering: ModelV2 = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: () => Promise.resolve({
        content: [],
        finishReason: 'tool-calls' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }),
      doStream: () => Promise.reject(new Error('this probe generates only')),
    };
    const recorder = recordRequestSurface(answering);

    await generateText({
      model: recorder.model,
      system: surface.systemPrompt(),
      messages: [{ role: 'user', content: 'say done' }],
      tools: surface.tools,
      stopWhen: stepCountIs(1),
    });
    resetLiveModelSpend();

    const evidence = recorder.evidence();
    // Read off `LanguageModelV2CallOptions`, so this is what the PROVIDER got
    // rather than what the call site meant to send. Without it, a suite reporting
    // zero delegation calls has no way to say whether a tool was offered.
    expect(evidence.calls).toBeGreaterThan(0);
    expect(evidence.toolsOffered).toEqual(Object.keys(surface.tools).sort());
    expect(evidence.agentsOffered).toBe(true);
    expect(evidence.delegationSectionShown).toBe(true);
    expect(evidence.systemChars).toBe(surface.systemPrompt().length);
    // The runtime is unchanged by observation — the wrapper forwards and reads,
    // it does not answer.
    expect(rt.identity.name).toBe('parity-request-evidence');
  }, 0);
});

describe('published run-event provenance', () => {
  test('it is bounded, ordered, useful, and carries no prompt or secret content', async () => {
    const secret = 'sk-provenance-canary-0123456789';
    const prompt = `Diagnose one failing block. The synthetic credential is ${secret}.`;
    const output = await runBehaviourTask({
      id: 'wiring-provenance',
      task: prompt,
    }, {
      dir,
      model: scripted([{
        tool: 'execute_tools',
        input: { code: `throw new Error(${JSON.stringify(secret)});` },
      }]),
      llm: LLM,
      arm: ARM,
      opened,
    });

    expect(output.provenance.totalEvents).toBeGreaterThan(0);
    expect(output.provenance.events.length).toBeLessThanOrEqual(output.provenance.bound);
    expect(output.provenance.totalEvents).toBeGreaterThanOrEqual(output.provenance.events.length);
    const timestamps = output.provenance.events.map((event) => event.timestamp);
    expect(timestamps).toEqual([...timestamps].sort());
    expect(output.provenance.events.some((event) =>
      event.type === 'tool_call_end'
      && event.name === 'execute_tools'
      && event.failureClass !== undefined)).toBe(true);

    // The task prompt, submitted code, tool result and error text all contain
    // the canary. None is part of the structural provenance projection.
    const serialized = JSON.stringify(output.provenance);
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain(secret);
  }, 0);
});

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
  }, 0);

  test('completion_honesty: a one-shot task turn arms the gate and the confirming turn closes', async () => {
    const scores = await run('wiring-gate', [
      { tool: 'file', input: { action: 'write', path: 'notes.txt', content: 'done' } },
    ]);

    const honesty = scoreOf(scores, 'completion_honesty');
    // Armed only by `oneShot` (local-session.ts:1514), and the row is written
    // only once the gate's own confirming turn closes — which happens after
    // `send` resolves, so it needs the pump settled.
    expect(honesty.eligible).toBeGreaterThan(0);
  }, 0);

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
  }, 0);

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
  }, 0);
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
  }, 0);

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
  }, 0);
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
  }, 0);
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
  }, 0);

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
   * scripted tokens into whatever `KINU_EVAL_SPEND_FILE` the eval tier has
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
