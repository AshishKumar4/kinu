/**
 * Operator cancellation reaches a hosted swarm node: the search's abort is bridged onto the node actor's own
 * session abort, the claim settles `aborted` and the journal records it. Scaffold code cannot run here (the
 * loader is a workerd binding), so mid-step cuts are proven by core's head-inference abort tests.
 */
import { describe, expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import {
  runNodeAgent,
  HeadJournal,
  type NodeAgentInput,
} from '@kinu.run/core';
import { buildNodeDeps } from '../../core/src/strategy/swarm-setup';
import { createRecordingLogger } from '@kinu.run/core/obs';
import { scriptedTurnModel, sqlOver } from '@kinu.run/test-utils';
import { hostNodeSeat } from '../src/exploration-hosting';
import { orchestratorHarness } from './helpers/actor-harness';

const NODE_ID = 'node-1';

function nodeInput(nodeId: string): NodeAgentInput {
  return {
    nodeId,
    rootId: 'root-1',
    parentId: null,
    depth: 1,
    task: 'answer the direct angle',
    rationale: 'the direct angle',
    base: 'You are a node under test.',
    messages: [{ role: 'user', content: 'Answer the task.' }],
    inherited: [],
    context: 'fresh',
    mode: 'build',
    settle: 'best',
    arbitrate: null,
  };
}

/** Uses the production seat factory, so the run is the backend's own wiring. */
async function hostedSearch(signal?: AbortSignal) {
  const workspace = orchestratorHarness();
  const seams = workspace.agent.observeExplorationSeams();

  const journal: HeadJournal = new HeadJournal(
    sqlOver(workspace.db), workspace.agent.observeRuntime().actor,
  );

  return { workspace, seams, journal, signal };
}

function reportingModel(answer: string, calls: { count: number }): MockLanguageModelV3 {
  let call = 0;

  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-node',
    doGenerate: async () => {
      call += 1;
      calls.count = call;

      if (call > 1) {
        return {
          content: [{ type: 'text' as const, text: 'Reported.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      }

      return {
        content: [{
          type: 'tool-call' as const,
          toolCallId: 'report-1',
          toolName: 'report',
          input: JSON.stringify({ status: 'completed', content: answer }),
        }],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: {
          inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 7, text: 7, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

describe('cancelling a search reaches its hosted nodes', () => {
  test('a node seats as a hosted actor under the workspace loop', async () => {
    const search = await hostedSearch();
    const seat = await hostNodeSeat(search.seams, { nodeId: NODE_ID, rootId: 'root-1', depth: 1 });
    // The run is bridged onto this actor's session, so the seating (kind, store scoping, loop) is load-bearing.
    expect(seat.actor.record.kind).toBe('head');
    expect(seat.actor.record.parentActorId).toBe(search.workspace.agent.observeRuntime().actor.actorId);
  });

  test('a search already cancelled runs nothing and reports aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by operator'));
    const search = await hostedSearch(controller.signal);
    const calls = { count: 0 };

    const deps = buildNodeDeps({
      hostNode: (node) => hostNodeSeat(search.seams, node),
      model: reportingModel('the direct angle answers it', calls),
      journal: search.journal,
      logger: createRecordingLogger(),
      signal: controller.signal,
    });

    const run = await runNodeAgent(nodeInput(NODE_ID), deps);

    expect(run.report.status).toBe('aborted');
    expect(calls.count).toBe(0);
    expect(search.journal.readHeadView(NODE_ID)).toMatchObject({ status: 'aborted' });
  });
});
