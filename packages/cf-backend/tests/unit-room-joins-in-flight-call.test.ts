/**
 * A tab that joins a room while its actor's tool call runs is told the call, and hears it end once: the workspace's
 * own room and a hired agent's alike, one replay for both. Defends the eval's helper rooms (2026-10-03, ForwardPrimate):
 * a room opened after a helper's call started heard nothing of it, so the watch read a working helper as hung.
 */
import { expect, test } from 'bun:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import type { Connection } from 'agents';
import * as v from 'valibot';
import { AwaitedList } from '@kinu.run/test-utils';
import { actorConnectionTag } from '@kinu.run/core';
import { gatewayWorkspace, rosterOver, wakeForDelegatedTask, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';
import { socketConnection } from './helpers/bindings';

const FrameSchema = v.looseObject({
  type: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()), replayComplete: v.optional(v.boolean()),
});

type Frame = v.InferOutput<typeof FrameSchema>;

const ChunkSchema = v.looseObject({ type: v.string(), toolCallId: v.optional(v.string()) });

const CONNECT = { request: new Request('https://agent/connect') };

const ASK = 'Run the gated check, then say done.';

const CALL = 'eval_gated';

/** The call waits here until the case lets it go, so a tab can join while it runs. */
const GATE = 'kinu.test.in-flight-gate';

const CODE = `await globalThis[Symbol.for('${GATE}')](); return 'released';`;

/** The owner's message from another tab, under the request's own id as our clients send it. */
function chatRequest(id: string): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id,
    init: { method: 'POST', body: JSON.stringify({ messages: [{ id, role: 'user', parts: [{ type: 'text', text: ASK }] }], trigger: 'submit-message' }) },
  });
}

/** One call to the gated `eval`, then the answer once its result is in. */
function gatedCall() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  Object.assign(globalThis, {
    [Symbol.for(GATE)]: () => {
      entered.resolve();

      return release.promise;
    },
  });

  const gateway = stubAiBinding((run) => {
    if (!openingOf(run).includes(ASK)) return chatCompletion(run, 'ok');

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'done')
      : toolCallCompletion(run, { tool: 'eval', args: { code: CODE } }, CALL);
  });

  return { gateway, entered: entered.promise, release: () => { release.resolve(); } };
}

/** A tab on `room` (null is the workspace's own) that asks what resumes as it opens, as the SDK's hook does, and then
 *  acks the stream it is told of once, though it is told on connect and again on its request. */
function tab(agent: HarnessOrchestratorAgent, room: string | null) {
  const heard = new AwaitedList<Frame>();
  const fanout = agent.broadcast.bind(agent);
  const id = `joiner-${room ?? 'root'}`;

  const socket: Connection = socketConnection({
    id, tags: room === null ? [] : [actorConnectionTag(room)],
    send: (raw: string) => { hear(raw); },
  });

  function hear(raw: string): void {
    const frame = v.parse(FrameSchema, JSON.parse(raw));
    heard.push(frame);
  }

  /** The stream this tab was told resumes, or null. */
  const resumed = (): string | null => heard.items.find((frame) => frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING)?.id ?? null;

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (exclude === undefined || !exclude.includes(id)) hear(message);
      fanout(message, exclude);
    },
  });

  return {
    join: async (): Promise<void> => {
      await agent.onConnect(socket, CONNECT);
      await agent.onMessage(socket, JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST }));
      const stream = resumed();

      if (stream !== null) await agent.onMessage(socket, JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: stream }));
    },
    resumed,
    /** Each chunk `stream` carried for the call, in order. */
    chunks: (stream: string): string[] => heard.items.flatMap((frame) => {
      if (frame.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE || frame.id !== stream || frame.body === undefined || frame.body === '') return [];
      const chunk = v.safeParse(ChunkSchema, JSON.parse(frame.body));

      return chunk.success && chunk.output.toolCallId === CALL ? [chunk.output.type] : [];
    }),
    ended: (stream: string) => heard.until((frames) => frames.some((frame) => frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.id === stream && frame.done === true)),
  };
}

/** The call's chunks a joiner hears, from its join to the turn's end. */
async function joinedMidCall(room: 'root' | 'helper'): Promise<{ resumed: boolean; chunks: string[] }> {
  const gated = gatedCall();
  const workspace = gatewayWorkspace(gated.gateway);
  let actor: string | null = null;
  // A request is answered when the turn it opens ends, so it is awaited after the release.
  let sending: Promise<unknown> = Promise.resolve();

  if (room === 'root') {
    const sender = socketConnection({ id: 'sender', send: () => {} });
    sending = Promise.resolve(workspace.agent.onMessage(sender, chatRequest(crypto.randomUUID())));
  } else {
    const child = await workspace.agent.actorDirectory({ action: 'register', creationId: 'lead', name: 'lead', origin: 'agent', lifetime: 'durable' });

    rosterOver(workspace.db).create({
      name: 'lead', actorReference: child.reference, birth: null, deleteRequested: false,
      status: 'working', currentTask: ASK, createdAt: Date.now(), dismissedAt: null, lifetime: 'durable', taskEventId: null,
    });
    actor = child.reference.actorId;
    await wakeForDelegatedTask(workspace, actor, ASK);
  }

  await gated.entered;
  const joiner = tab(workspace.agent, actor);
  await joiner.join();
  const stream = joiner.resumed();

  gated.release();
  await sending;

  if (stream !== null) await joiner.ended(stream);
  await joinHarnessFibers();

  return { resumed: stream !== null, chunks: stream === null ? [] : joiner.chunks(stream) };
}

test.each(['root', 'helper'] as const)("a tab joining the %s's room mid-call is told the call, then hears it end once", async (room) => {
  expect(await joinedMidCall(room)).toEqual({ resumed: true, chunks: ['tool-input-start', 'tool-input-delta', 'tool-input-available', 'tool-output-available'] });
});
