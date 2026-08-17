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
import { describe, test, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';

import type { AgentRuntime, EvalCase, LLMProviderConfig } from '../../packages/core/src/index.js';
import { DefaultExecutionRouter } from '../../packages/core/src/index.js';
import { createWorkspace } from '../../packages/core/src/identity/index.js';
import type { EvalArmState } from '@proteus/test-utils';

import {
  DegenerateRunError, DegenerateRuntimeError, requireExecutorSurface,
  runBehaviourTask, type BehaviourScoreJson,
} from './harness.js';

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
  | {
      readonly tool: 'file';
      readonly input: {
        readonly action: 'read' | 'write';
        readonly path: string;
        readonly content?: string;
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
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function scoreOf(scores: readonly BehaviourScoreJson[], name: string): BehaviourScoreJson {
  const found = scores.find((s) => s.name === name);
  if (!found) throw new Error(`no ${name} score — scoreTrajectory stopped reporting it`);
  return found;
}

async function run(id: string, steps: readonly ScriptedStep[]): Promise<readonly BehaviourScoreJson[]> {
  const task: EvalCase = { id, task: 'do the task' };
  const out = await runBehaviourTask(task, {
    dir, model: scripted(steps), llm: LLM, arm: ARM, opened,
  });
  return out.scores;
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
