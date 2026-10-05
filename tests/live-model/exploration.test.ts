/**
 * Behavioural eval for exploration: handed a task that warrants it and the tool to do it with, does the model
 * reach for it? Model-dependent by nature: a recorded baseline converted 0% of eligible turns until a mechanical
 * nudge reached 24%, so it is reported as a RATE over a stated denominator rather than asserted per attempt.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateText, stepCountIs, type LanguageModel, type ToolSet, type StepResult } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

import {
  type LLMProviderConfig,
} from '../../packages/core/src/index';
import { type CLIRuntime } from '../../packages/cli-backend/src/runtime';
import {
  buildEvalAgentSurface, recordRequestSurface,
  type EvalAgentSurface,
} from './harness';
import { provisionLocalTarget, type LocalTarget } from './target-local';
import {
  liveChatModel, liveModelTarget, recordLiveModelSpend,
  reportLiveModelSpend, UNCONFIGURED_LLM,
} from '@kinu.run/test-utils';

const TARGET = liveModelTarget('Exploration Evals');

const liveTest = test.skipIf(!TARGET);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'kinu-eval-exploration-' + String(Date.now()));

/**
 * A task with several genuinely different defensible approaches and no obvious
 * winner — the shape the doctrine tells the model to fork on. Deliberately not
 * a puzzle with one right answer: a task the model can just solve is not a task
 * that warrants exploration, and asserting it forks on one would be asserting
 * the wrong behaviour.
 */
const EXPLORATION_TASK =
  'We need to cut the p99 latency of a read-heavy JSON API that currently reads '
  + 'straight from SQLite on every request. There are several defensible designs '
  + '(in-process cache, a read replica, materialised views, a CDN edge cache) and '
  + 'the right one is not obvious — they trade freshness, memory and operational '
  + 'cost differently. Compare the competing approaches and recommend one.';

describe('Exploration evals — the agent reaches for exploration', () => {
  let rt: CLIRuntime;
  let target: LocalTarget;
  let model: LanguageModel;

  /** The eval agent's surface from the PRODUCTION actor root. Assembling
   *  `buildActorTools` here with a hand-rolled `agents.fork` — the same shape,
   *  minus every dep production passes — makes the surface a near-miss of the
   *  product's and leaves this file one drift away from scoring its own
   *  construction. */
  let surface: EvalAgentSurface;

  beforeAll(async () => {
    // Provisioned through the seam: birth, the whole schema, open, the
    // executor-surface and sandbox guards and the pre-turn profile — the same
    // sequence every live suite drives, once. The runtime `createWorkspace`
    // returns is what open.ts:49-50 calls "degraded inline
    // VFS/Memory/Executor", and its `spawnBranch` is a HARDCODED MOCK whose
    // every branch resolves to the literal string 'exploration result'
    // (workspace-birth.ts:57-68). A search suite driving that stub is scoring
    // the stub, not exploration. `initWorkspaceSchema` is also what makes
    // `head_journal` exist at all, which this suite's settle-visibility
    // assertion requires of both halves. Binding no directory keeps every
    // executor off the repo this suite launched from, asserted rather than trusted
    // because this suite spends real money to find out.
    target = await provisionLocalTarget({
      dir: TEST_DIR,
      workspace: 'exploration-eval',
      purpose: 'An architecture advisor that compares competing designs before recommending one.',
      llm: LLM_CONFIG,
    });
    rt = target.runtime;
    // The model first, then the surface through the shared production
    // construction (`buildEvalAgentSurface`, harness.ts): same factory, same
    // crafted-tool source, same codemode providers, same fork-deps shape.
    model = liveChatModel(LLM_CONFIG);
    surface = buildEvalAgentSurface({ rt, model, llm: LLM_CONFIG });
  });

  afterAll(async () => {
    reportLiveModelSpend('Exploration Evals');
    // Teardown owns the store and the directory.
    target?.teardown();
  });

  test('the agent is actually offered the delegation tool', async () => {
    // Credential-free, and the precondition every eval below rests on. Without
    // it "the model did not fork" would be indistinguishable from "the model
    // could not fork", and the delegation rate would be measuring the harness.
    expect(Object.keys(surface.tools)).toContain('agents');
    // And the prompt names it: a tool the model is never told about is not
    // offered in any sense that matters (PRD §9.5 — production prompt AND tool
    // projection). The tool index is the one prompt text about delegation.
    const { system } = await surface.request([{ role: 'user', content: EXPLORATION_TASK }]);
    expect(system).toContain('- **agents**:');
  });

  test('the issued request carries the runtime facts the system prompt no longer states', async () => {
    // Credential-free: a scripted model stands in for the provider, and the recorder reads what it was sent.
    const recorder = recordRequestSurface(new MockLanguageModelV3({ doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: undefined }, warnings: [],
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
    }) }));

    const { system, messages } = await surface.request([{ role: 'user', content: EXPLORATION_TASK }]);
    await generateText({ model: recorder.model, system, messages, tools: surface.tools });

    expect(recorder.evidence().runtimeFacts).toBe(true);
    expect(JSON.stringify(messages)).toContain(`- Model: ${LLM_CONFIG.model}`);
  });

  liveTest('AUTONOMOUS: the model reaches for exploration on a task that warrants it', async () => {
    const calls: string[] = [];
    // PRD §9.5: the turn runs the PRODUCTION projection and the PRODUCTION tool
    // surface. `system: soul` — the workspace SOUL file alone, which never
    // mentions delegation — over a ToolSet that cannot hold `agents` measures
    // something, but not the product's conversion behaviour: it scores the model
    // on reaching for a capability it was neither offered nor told about.
    const recorder = recordRequestSurface(model);
    const { system, messages } = await surface.request([{ role: 'user', content: EXPLORATION_TASK }]);

    const result = await generateText({
      model: recorder.model,
      system,
      messages,
      tools: surface.tools,
      stopWhen: stepCountIs(12),
      onStepFinish: (step: StepResult<ToolSet>) => {
        for (const call of step.toolCalls ?? []) calls.push(call.toolName);
      },
    });

    recordLiveModelSpend(result.usage);

    const reached = calls.filter((name) => name === 'agents').length;
    console.log(`    tools called: ${calls.join(', ') || '(none)'}`);
    console.log(`    delegation-tool reaches: ${String(reached)} of ${String(calls.length)} calls`);

    // REQUEST EVIDENCE, per §9.5. A zero below now arrives with the proof of
    // what the provider was actually asked with, so "the model declined" and
    // "the harness never asked" can never again be the same observation. The
    // evidence itself is asserted because it is harness fact, not model
    // behaviour: if this fails the wiring is broken and no conversion number in
    // the run means anything.
    const evidence = recorder.evidence();
    console.log(`    request evidence: ${String(evidence.calls)} call(s), tools offered `
      + `${evidence.toolsOffered.join(', ')}, agents=${String(evidence.agentsOffered)}, `
      + `agents indexed=${String(evidence.agentsIndexed)}, `
      + `system ${String(evidence.systemChars)} chars`);
    expect(evidence.calls).toBeGreaterThan(0);
    expect(evidence.toolsOffered).toEqual(Object.keys(surface.tools).sort());
    expect(evidence.agentsOffered).toBe(true);
    expect(evidence.agentsIndexed).toBe(true);
    expect(evidence.runtimeFacts).toBe(true);

    // The denominator is one eligible turn, stated. This is a SAMPLE of a rate,
    // not the rate: a single turn cannot measure a conversion percentage, and
    // the aggregate lives in the delegation eval over run_events.
    //
    // What is asserted is the part that is not model-dependent: the turn
    // completed and produced observable tool traffic, so a zero above is the
    // model declining rather than the harness failing to ask. A run where the
    // model called nothing at all cannot distinguish those two — but with the
    // request evidence above, at least the offer itself is proven.
    expect(calls.length).toBeGreaterThan(0);
  }, 0);
});
