/**
 * The vendor contract the steer chain stands on, proven over real sockets: a
 * user row appended via `addMessages` from INSIDE a live turn (exactly what
 * recordLandedSteers does) must become durable, reach a CONNECTED client by
 * turn end, and sit between the user turn and the assistant answer. The bun
 * suite proves ActorAgent's steer methods call this seam correctly; only this
 * layer can prove the seam holds — `addMessages` skips its broadcast inside
 * the inference loop by design, and the turn-end full-list broadcast is what
 * drops the chat pane's steer bubble (the 2026-08-19 stuck-bubble incident).
 */
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

const DEADLINE_MS = 15_000;
const POLL_MS = 50;

// Real wall-clock poll, deliberately: workerd integration tests await REAL
// platform conditions (socket frames, a blocked tool) where fake timers do not
// exist; the wait is condition-bound and the deadline only bounds a broken run.
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > DEADLINE_MS) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe('a mid-turn addMessages row, observed from a real connection', () => {
  it('lands as a durable user row the connected client is told about, in order', async () => {
    const stub = env.STEER_PROBE.get(env.STEER_PROBE.idFromName('probe-1'));

    // A real WebSocket, the same path the chat pane uses.
    const response = await stub.fetch('https://probe/agents/steer-probe/probe-1', {
      headers: { Upgrade: 'websocket' },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error('no socket on the 101 response');
    const frames: string[] = [];
    socket.accept();
    socket.addEventListener('message', (event) => {
      // The chat protocol is all text frames; a binary frame is out of contract.
      const text = v.safeParse(v.string(), event.data);
      if (text.success) frames.push(text.output);
    });

    // The turn, sent as the real chat frame.
    socket.send(JSON.stringify({
      id: 'req-1',
      type: 'cf_agent_use_chat_request',
      init: {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'start the work' }] }],
          trigger: 'submit-message',
        }),
      },
    }));

    // Deterministic mid-turn window: the model called `wait` and is blocked.
    const engaged = await until(() => stub.waitEngaged(), (value) => value === true);
    if (!engaged) {
      const snapshot = await stub.debugSnapshot();
      throw new Error(
        `turn never engaged the wait tool; do=${JSON.stringify(snapshot)} frames=${JSON.stringify(frames.map((frame) => frame.slice(0, 160)))}`,
      );
    }

    // What recordLandedSteers does at this seam, while the turn is live.
    const steerId = 'steer-probe-1';
    await stub.recordSteerRow(steerId, 'also check staging');

    await stub.releaseWait();

    // The client's view, decoded from the frames it actually received.
    const ChatMessagesFrame = v.object({
      type: v.literal('cf_agent_chat_messages'),
      messages: v.array(v.looseObject({ id: v.string(), role: v.string() })),
    });
    const lastMessageList = () => {
      const lists = frames
        .map((frame) => v.safeParse(ChatMessagesFrame, JSON.parse(frame)))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.output);
      return lists.at(-1)?.messages ?? [];
    };

    // The turn-end broadcast must carry the steer row to this connection.
    const messages = await until(lastMessageList, (list) =>
      list.some((message) => message.id === steerId) &&
      list.some((message) => message.role === 'assistant'));
    if (!messages.some((message) => message.id === steerId)) {
      const snapshot = await stub.debugSnapshot();
      throw new Error(
        `steer row never reached the client; do=${JSON.stringify(snapshot)} frames=${JSON.stringify(frames.map((frame) => frame.slice(0, 160)))}`,
      );
    }

    // The durable row carries the id the bubble already tracks — that equality
    // is what drops the bubble — and sits between the user turn and the answer.
    const ids = messages.map((message) => message.id);
    const userAt = ids.indexOf('u1');
    const steerAt = ids.indexOf(steerId);
    const assistantAt = messages.findIndex((message) => message.role === 'assistant');
    expect(messages[steerAt]?.role).toBe('user');
    expect(userAt).toBeGreaterThanOrEqual(0);
    expect(steerAt).toBeGreaterThan(userAt);
    expect(assistantAt).toBeGreaterThan(steerAt);

    socket.close();
  });
});
