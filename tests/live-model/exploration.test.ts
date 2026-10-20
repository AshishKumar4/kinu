/**
 * Behavioural eval for exploration: handed a task that warrants it and the tool to do it with, does the model
 * reach for it? Model-dependent by nature: a recorded baseline converted 0% of eligible turns until a mechanical
 * nudge reached 24%, so it is reported as a RATE over a stated denominator rather than asserted per attempt.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  type LLMProviderConfig,
} from '../../packages/core/src/index';
import { evalSession, scriptedEvalModel, type EvalSession } from './harness';
import { provisionLocalTarget, type LocalTarget } from './target-local';
import {
  liveModelTarget, recordLiveModelEpisode,
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
  let target: LocalTarget;

  /** The product's own session over the workspace, as `kinu` runs it: its prompt, its tool surface and its turn gates.
   *  A surface assembled here would leave this file one drift away from scoring its own construction. */
  let agent: EvalSession;

  beforeAll(async () => {
    // Provisioned through the seam: birth, the whole schema, open, the executor-surface and sandbox guards and the
    // pre-turn profile, the same sequence every live suite drives, once. Binding no directory keeps every executor off
    // the repo this suite launched from, asserted rather than trusted.
    target = await provisionLocalTarget({
      dir: TEST_DIR,
      workspace: 'exploration-eval',
      purpose: 'An architecture advisor that compares competing designs before recommending one.',
      llm: LLM_CONFIG,
    });
  });

  afterAll(async () => {
    await agent?.end();
    reportLiveModelSpend('Exploration Evals');
    // Teardown owns the store and the directory.
    target?.teardown();
  });

  test('the agent is offered the delegation tool, named in its prompt, and its request carries the runtime facts', async () => {
    // Credential-free, and the precondition every eval below rests on: without it "the model did not fork" would be
    // indistinguishable from "the model could not fork". A scripted model answers, in a workspace of its own so its
    // calls are no part of the live run's spend; the recorder reads what it was sent.
    const own = await provisionLocalTarget({
      dir: `${TEST_DIR}-scripted`, workspace: 'exploration-scripted', purpose: 'An architecture advisor.', llm: LLM_CONFIG,
    });

    const scripted = evalSession({ rt: own.runtime, db: own.db, model: scriptedEvalModel([{ text: 'ok' }]) });

    try {
      await scripted.turn(EXPLORATION_TASK);
      const evidence = scripted.requests.evidence();

      // Offered, and named in the prompt's tool index: a tool the model is never told about is not offered in any sense
      // that matters (PRD §9.5). The system prompt no longer states the runtime facts; the request's dynamic block does.
      expect({ offered: evidence.agentsOffered, indexed: evidence.agentsIndexed, runtimeFacts: evidence.runtimeFacts })
        .toEqual({ offered: true, indexed: true, runtimeFacts: true });
    } finally {
      await scripted.end();
      own.teardown();
    }
  });

  liveTest('AUTONOMOUS: the model reaches for exploration on a task that warrants it', async () => {
    // PRD §9.5: the turn runs the product's own projection and tool surface, through its session.
    agent = evalSession({ rt: target.runtime, db: target.db, llm: LLM_CONFIG });
    const { calls } = await agent.turn(EXPLORATION_TASK);

    recordLiveModelEpisode(target.runtime.storage.sql, target.runtime.actor);

    const reached = calls.filter((call) => call.name === 'agents').length;
    console.log(`    tools called: ${calls.map((call) => call.name).join(', ') || '(none)'}`);
    console.log(`    delegation-tool reaches: ${String(reached)} of ${String(calls.length)} calls`);

    // REQUEST EVIDENCE, per §9.5. A zero above arrives with the proof of what the provider was actually asked with, so
    // "the model declined" and "the harness never asked" are never the same observation. The evidence is asserted
    // because it is harness fact, not model behaviour: if it fails the wiring is broken and no conversion number means
    // anything.
    const evidence = agent.requests.evidence();
    console.log(`    request evidence: ${String(evidence.calls)} call(s), tools offered `
      + `${evidence.toolsOffered.join(', ')}, agents=${String(evidence.agentsOffered)}, `
      + `agents indexed=${String(evidence.agentsIndexed)}, `
      + `system ${String(evidence.systemChars)} chars`);
    expect(evidence.calls).toBeGreaterThan(0);
    expect(evidence.agentsOffered).toBe(true);
    expect(evidence.agentsIndexed).toBe(true);
    expect(evidence.runtimeFacts).toBe(true);

    // The denominator is one eligible turn, stated: a SAMPLE of a rate, not the rate; the aggregate lives in the
    // delegation eval over run_events. What is asserted is the part that is not model-dependent: the turn completed and
    // produced observable tool traffic, so a zero above is the model declining rather than the harness failing to ask.
    expect(calls.length).toBeGreaterThan(0);
  }, 0);
});
