/**
 * The report contract: where the objective is verifiable, the verifier runs inside the
 * report call and blocks it until the instrument runs, returning its errors to the node.
 * The gate asks whether the instrument ran, not the score (*No self-grading*); the node's
 * own step budget bounds retries.
 * Specified by docs/EXPLORATION.md — "The report contract".
 */
import { describe, expect, test } from 'bun:test';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { scriptedTurnModel, unobservedSpend } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { initHeadsTables } from '../src/heads/schema';
import { runNodeAgent } from '../src/strategy/node-agent';
import type { NodeAgentDeps, NodeAgentInput } from '../src/strategy/node-agent';

const UNRUNNABLE = 'the candidate did not parse: unexpected token at line 1';

/**
 * Reports a broken answer, then a working one. The attempt is read off the conversation:
 * the refusal's presence in the transcript is the signal to try again.
 */
function promptStage(refused: boolean, accepted: boolean): string {
  if (refused) return 'saw-refusal';

  if (accepted) return 'saw-acceptance';

  return 'first';
}

function reportTwice(seen: string[]): NodeAgentDeps['model'] {
  return scriptedTurnModel({
    modelId: 'fake-reporter',
    doGenerate: ({ prompt }) => {
      const text = JSON.stringify(prompt);
      const refused = text.includes(UNRUNNABLE);
      const accepted = text.includes('"received":true');
      seen.push(promptStage(refused, accepted));

      const content: LanguageModelV3Content[] = accepted
        ? [{ type: 'text', text: 'Reported.' }]
        : [{
          type: 'tool-call',
          toolCallId: refused ? 'report-2' : 'report-1',
          toolName: 'report',
          input: JSON.stringify({
            status: 'completed',
            content: refused ? 'function f(){ return 1 }' : 'functi0n f(){',
          }),
        }];

      return {
        content,
        finishReason: { unified: content[0]?.type === 'tool-call' ? 'tool-calls' as const : 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 4, text: 4, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

/** A model that reports a broken answer and never fixes it. */
function reportOnceBroken(): NodeAgentDeps['model'] {
  return scriptedTurnModel({
    modelId: 'fake-stubborn',
    doGenerate: ({ prompt }) => {
      const attempts = JSON.stringify(prompt).split(UNRUNNABLE).length - 1;

      const content: LanguageModelV3Content[] = attempts >= 2
        ? [{ type: 'text', text: 'I cannot fix it.' }]
        : [{
          type: 'tool-call',
          toolCallId: `report-${String(attempts)}`,
          toolName: 'report',
          input: JSON.stringify({ status: 'completed', content: 'functi0n f(){' }),
        }];

      return {
        content,
        finishReason: { unified: content[0]?.type === 'tool-call' ? 'tool-calls' as const : 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 4, text: 4, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

function fixture(over: {
  readonly model: NodeAgentDeps['model'];
  readonly gradeReport?: NodeAgentDeps['gradeReport'];
}) {
  const { rt, db } = createTestRuntime();
  initHeadsTables(rt.storage.execRaw);
  const journal = new HeadJournal(rt.storage.sql, rt.actor);
  // One hosted actor per node id, over this runtime's one database.
  const seats = hostedSeatsOver({ rt, db });

  const input: NodeAgentInput = {
    nodeId: 'n1', rootId: 'r1', parentId: null, depth: 1,
    task: 'Make the reference implementation cheaper.',
    rationale: 'the direct angle',
    base: 'You are a node under test.',
    messages: [{ role: 'user', content: 'Answer the task.' }],
    inherited: [],
    context: 'fresh',
    mode: 'build',
    settle: 'best',
    arbitrate: null,
  };

  const deps: NodeAgentDeps = {
    reportModelCall: unobservedSpend,
    hostNode: seats.hostNode, model: over.model, journal,
    logger: createRecordingLogger(),
  };

  if (over.gradeReport !== undefined) deps.gradeReport = over.gradeReport;

  return { input, deps };
}

describe('the verifier blocks the report and answers the node', () => {
  test('a report the instrument cannot run does NOT land, and the node is told why', async () => {
    // Without the gate the first report lands and the failure surfaces only at the barrier.
    const graded: string[] = [];
    const seen: string[] = [];

    const { input, deps } = fixture({
      model: reportTwice(seen),
      gradeReport: (candidate) => {
        graded.push(candidate);

        return Promise.resolve(candidate.includes('functi0n') ? UNRUNNABLE : null);
      },
    });

    const run = await runNodeAgent(input, deps);

    // Both candidates reached the instrument in order: the first refused, the second measured.
    expect(graded).toEqual(['functi0n f(){', 'function f(){ return 1 }']);
    // Without the errors coming back, the second attempt has no reason to differ.
    expect(seen).toContain('saw-refusal');
    expect(run.reportedItself).toBe(true);
    expect(run.candidate).toBe('function f(){ return 1 }');
  });

  test('a node that never satisfies the instrument reports NOTHING', async () => {
    // No retry count: a node that cannot fix its answer runs out of steps and arrives as a
    // member that produced nothing, not one that produced something unmeasurable.
    const { input, deps } = fixture({
      model: reportOnceBroken(),
      gradeReport: () => Promise.resolve(UNRUNNABLE),
    });

    const run = await runNodeAgent(input, deps);

    expect(run.reportedItself).toBe(false);
    expect(run.candidate).not.toContain('functi0n');
  });

  test('with no instrument the report lands unchanged', async () => {
    // A judged run has nothing to gate on, and the gate is absent rather than always-accepting:
    // an absent key differs from a check that passed.
    const seen: string[] = [];
    const { input, deps } = fixture({ model: reportTwice(seen) });

    const run = await runNodeAgent(input, deps);

    expect(run.reportedItself).toBe(true);
    expect(run.candidate).toBe('functi0n f(){');
    expect(seen).not.toContain('saw-refusal');
  });
});
