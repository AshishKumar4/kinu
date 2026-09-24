/**
 * A search node's streamed words sit on the root turn's critical path (one DO, one input gate), so they may only
 * fan out and must never touch storage; the node's recorded steps are the durable trace. Driven as production
 * drives it: the owner's turn starts a search through the main actor's `agents` tool, every model call the
 * platform gateway's.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { catalogTurn, gatewayWorkspace, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import {
  chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun,
} from './helpers/platform-gateway';

const ASK = 'Find a way to speed up the parser.';

const ANSWER = 'Cache the token table between passes.';

const FrameSchema = v.object({
  type: v.literal('head_stream'),
  headId: v.string(),
  kind: v.picklist(['text', 'reasoning']),
  delta: v.string(),
});

function fromTheOwner(run: RecordedGatewayRun): boolean {
  return openingOf(run).includes(ASK);
}

function stepOf(run: RecordedGatewayRun): number {
  return requestOf(run).messages.filter((message) => message.role === 'tool').length;
}

/** The main actor starts a one-node search; the node runs code once, then answers. */
const searching = stubAiBinding((run) => {
  if (fromTheOwner(run)) {
    return stepOf(run) === 0
      ? toolCallCompletion(run, {
        tool: 'agents', args: { action: 'swarm', task: 'Name one way to tokenize faster.', preset: 'ideate', branches: 1, depth: 1 },
      }, 'swarm_0')
      : chatCompletion(run, 'Searching.');
  }

  return stepOf(run) === 0
    ? toolCallCompletion(run, { tool: 'eval', args: { code: 'return 6 * 7;' } }, 'eval_0')
    : chatCompletion(run, ANSWER);
});

function captureFrames(agent: HarnessOrchestratorAgent): unknown[] {
  const sent: unknown[] = [];
  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => { sent.push(JSON.parse(payload)); },
  });

  return sent;
}

test("a node's streamed words go out as frames the client validator accepts, and add no step to its trace", async () => {
  const { agent, db } = gatewayWorkspace(searching);
  const sent = captureFrames(agent);

  await catalogTurn(agent, ASK);
  await agent.harnessJoinDetachedFibers();

  const frames = sent.filter((frame) => v.is(v.looseObject({ type: v.literal('head_stream') }), frame))
    .map((frame) => v.parse(FrameSchema, frame));

  const steps = db.query<{ head_id: string }, []>('SELECT head_id FROM head_steps').all();

  expect(frames.map((frame) => frame.delta).join('')).toBe(ANSWER);
  expect(new Set(frames.map((frame) => frame.headId)).size).toBe(1);
  // Two model steps (the eval call, then the answer): the trace holds those, whatever the stream sent.
  expect(steps.filter((step) => step.head_id === frames[0]?.headId)).toHaveLength(2);
});
