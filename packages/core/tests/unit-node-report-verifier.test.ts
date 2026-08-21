/**
 * THE REPORT CONTRACT: where the objective is verifiable, the verifier RUNS INSIDE the
 * report call and blocks it, and its errors go back to the node.
 *
 * The owner asked for this directly: *"let node subagents have a tool for reporting
 * their results/progress/code whatever, and have that be judged. If it's something that
 * is verifiable, run and compute the metric/results — and block the report tool until
 * it runs successfully, else return the error to the agent."*
 *
 * What shipped was the first half. A node's `report` captured its content and returned
 * `{received:true}` unconditionally; the instrument ran LATER, engine-side, at scoring
 * time. So a node whose answer the instrument could not run at all — it did not parse,
 * it named nothing the executor could execute — learnt nothing, could fix nothing, and
 * arrived at the barrier as an unmeasurable candidate. The information existed and was
 * never delivered to the one agent that could act on it.
 *
 * WHAT THE GATE DECIDES, precisely, and it is not the score. It asks whether the
 * instrument RAN — "until it runs successfully" — and a node that reports a working but
 * mediocre answer passes it and is scored low. Grading stays engine-side, because *No
 * self-grading* means a node never supplies the quantity it would have to lie about.
 *
 * WHAT BOUNDS THE RETRY is the node's own step budget, which already exists. No retry
 * count is declared here: a node that cannot satisfy the instrument runs out of steps
 * and ends unreported, which the search already reads as a member that produced nothing.
 *
 * Specified by docs/EXPLORATION.md — "The report contract".
 */
import { describe, expect, test } from 'bun:test';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { initHeadsTables } from '../src/heads/schema';
import { runNodeAgent } from '../src/strategy/node-agent';
import type { NodeAgentDeps, NodeAgentInput } from '../src/strategy/node-agent';

const NODE_STEPS = 8;
const STALL_MS = 4_000;

/** What the gate says when it refuses, as the node sees it. */
const UNRUNNABLE = 'the candidate did not parse: unexpected token at line 1';

/**
 * A model that reports a broken answer, then reports a working one.
 *
 * Which attempt it is on is read off the conversation rather than off a counter, so the
 * fixture cannot get out of step with the loop: the refusal it is answering is in the
 * transcript, and its presence IS the signal to try again.
 */
function reportTwice(seen: string[]): NodeAgentDeps['model'] {
  return scriptedTurnModel({
    modelId: 'fake-reporter',
    doGenerate: ({ prompt }) => {
      const text = JSON.stringify(prompt);
      const refused = text.includes(UNRUNNABLE);
      const accepted = text.includes('"received":true');
      seen.push(refused ? 'saw-refusal' : accepted ? 'saw-acceptance' : 'first');
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
  const { rt } = createTestRuntime();
  initHeadsTables(rt.storage.execRaw, rt.storage.sql);
  const journal = new HeadJournal(rt.storage.sql);
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
    rt, model: over.model, journal,

    maxWallClockMs: 60_000,
    logger: createRecordingLogger(),
    callTimeoutMs: STALL_MS,
  };
  if (over.gradeReport !== undefined) deps.gradeReport = over.gradeReport;
  return { input, deps };
}

describe('the verifier blocks the report and answers the node', () => {
  test('a report the instrument cannot run does NOT land, and the node is told why', async () => {
    // The red case. Before the gate existed the first report landed, the node stopped,
    // and the failure surfaced at the barrier as an unmeasurable candidate with the
    // node long gone.
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

    // BOTH candidates reached the instrument, in order, which is what "blocks until it
    // runs" means operationally: the first was refused, the second was measured.
    expect(graded).toEqual(['functi0n f(){', 'function f(){ return 1 }']);
    // The node SAW the refusal and acted on it. Without the errors coming back, the
    // second attempt has no reason to differ from the first.
    expect(seen).toContain('saw-refusal');
    // And what the search takes out is the answer that passed, never the one that
    // did not.
    expect(run.reportedItself).toBe(true);
    expect(run.candidate).toBe('function f(){ return 1 }');
  });

  test('a node that never satisfies the instrument reports NOTHING', async () => {
    // The terminal the search already knows how to read. No retry count is declared:
    // the node's own step budget bounds it, so a node that cannot fix its answer runs
    // out of steps and arrives as a member that produced nothing — which is a different
    // fact from a member that produced something unmeasurable, and the honest one.
    const { input, deps } = fixture({
      model: reportOnceBroken(),
      gradeReport: () => Promise.resolve(UNRUNNABLE),
    });

    const run = await runNodeAgent(input, deps);

    expect(run.reportedItself).toBe(false);
    expect(run.candidate).not.toContain('functi0n');
  });

  test('with no instrument the report lands unchanged', async () => {
    // A judged run has nothing to gate on, and the gate is ABSENT rather than a
    // function that always accepts: an absent key is a different fact from a check that
    // passed, and the report path must not grow a second shape for the judged case.
    const seen: string[] = [];
    const { input, deps } = fixture({ model: reportTwice(seen) });

    const run = await runNodeAgent(input, deps);

    expect(run.reportedItself).toBe(true);
    expect(run.candidate).toBe('functi0n f(){');
    expect(seen).not.toContain('saw-refusal');
  });
});
