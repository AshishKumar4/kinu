/**
 * Operator cancellation reaches a HOSTED swarm node.
 *
 * A node runs in the search's own isolate over its own hosted actor — there is
 * no facet, no RPC for the run to be pending on, and no instance to evict. So
 * the transport verbs this suite's predecessor pinned (`subAgent` handing back
 * a stub, `abortSubAgent` rejecting the in-flight `runAsNode`, `deleteSubAgent`
 * reclaiming the storage) are gone with the facet: deleting a database that no
 * longer exists would be the leak family re-enacted as theatre.
 *
 * What replaces them is one path, and it is the same path every actor kind
 * cancels through. The search's abort signal is bridged onto the node actor's
 * OWN session abort inside `runHeadInference`: the step in flight is cut rather
 * than waited for, the durable claim settles `aborted` rather than being left
 * open, and the search's journal row records the aborted report. Cancellation
 * is an explicit caller stop and nothing else — a socket close, a request
 * abort or an evicted isolate never reaches it, which is why an unsettled
 * claim is the record that work is owed rather than a reason to cancel it.
 *
 * WHAT THIS SUITE CAN AND CANNOT RUN. A hosted node inherits its loop, so its
 * turn runs scaffold code — and scaffold code cannot execute in this harness
 * (the loader that runs it is a workerd binding; measured: the runtime
 * executor answers every call with a loader error). A mid-step cut therefore
 * has no step to cut here: no model call is ever issued, and a test that waits
 * for one hangs rather than fails. The mid-step cut and the finished-untouched
 * cases are proven where the loop runs model-driven — core's head-inference
 * abort tests — and what is proven HERE is the hosted half those cannot see:
 * seating a node under the workspace's loop, and a cancelled search running
 * nothing while still reporting `aborted` to the journal.
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
/** A search over one workspace, with the production seat factory: each node is
 *  acquired from the workspace's one host, so the run under test is the
 *  backend's own wiring rather than a re-declaration of it. */
async function hostedSearch(signal?: AbortSignal) {
  const workspace = orchestratorHarness();
  const seams = workspace.agent.observeExplorationSeams();
  const journal: HeadJournal = new HeadJournal(
    sqlOver(workspace.db), workspace.agent.observeRuntime().actor,
  );
  return { workspace, seams, journal, signal };
}

/** A model that reports on its first step, the way a settled node does. */
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
    // The hosted half the loop tests cannot see: the run below is bridged
    // onto THIS actor's session, so the seating — kind, store scoping,
    // inherited loop — is load-bearing rather than incidental.
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
