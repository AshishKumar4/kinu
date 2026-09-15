/**
 * The hosted root's chat transport, over the real SDK primitives it composes
 * (`ResumableStream` on bun:sqlite, `ResumeHandshake`, `StreamAccumulator`,
 * `parseProtocolMessage`, `reconcileMessages`).
 *
 * What these cases pin is the wire the React hook reads: a chat request is
 * handed to the loop under the client's own id — the transport writes no row,
 * the loop does when it opens the turn or lands the splice — and is answered
 * with the done frame the hook waits on; a turn's chunks reach every
 * connection under the request that started it and are stored for resume; a
 * reconnecting client is told what is resuming and gets the stored chunks
 * replayed; the accumulated answer is what the transcript persists.
 */
import { describe, expect, test } from 'bun:test';
import type { UIMessage, UIMessageChunk } from 'ai';
import * as v from 'valibot';
import { createTestSql } from '@kinu.run/test-utils';
import type { SendLanding, SessionEvent } from '@kinu.run/core';
import type { Connection } from 'agents';
import { ChatWireTransport, type ChatWire } from '../src/chat-transport';

const FrameSchema = v.looseObject({ type: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()), landed: v.optional(v.string()), replay: v.optional(v.boolean()) });

/** The loop's side of the wire, as a fixture: a send lands where the harness
 *  says, and what the loop holds — the rows a turn wrote, the reservations a
 *  splice keeps — is what `admitted` answers from. A send the loop refuses
 *  rejects, as the real loop's does. */
interface HarnessRefusal { readonly refuse: string; }

function isRefusal(landing: SendLanding | HarnessRefusal): landing is HarnessRefusal {
  return v.is(v.object({ refuse: v.string() }), landing);
}

function harness(landing: SendLanding | HarnessRefusal = 'turn') {
  const { sql, db } = createTestSql();
  const broadcasts: Array<{ frame: v.InferOutput<typeof FrameSchema>; exclude: string[] | undefined }> = [];
  const history: UIMessage[] = [];
  /** The ids the loop holds a reservation for: every send accepted mid-turn. */
  const reserved = new Set<string>();
  const sent: Array<{ text: string; files: readonly { url: string }[]; id: string; mode: string }> = [];
  let interrupts = 0;
  let clears = 0;
  const connections = new Map<string, Connection>();
  const frames = new Map<string, string[]>();

  /** A socket the SDK's protocol helpers can drive. */
  const connection = (id: string): Connection => {
    const sent: string[] = [];
    frames.set(id, sent);

    const partialSocket: Pick<Connection, 'id' | 'send'> = { id, send: (frame: string) => { sent.push(frame); } };
    // SAFETY: this constructed fixture implements `id` and `send`. The SDK
    // helpers the transport composes (`sendIfOpen`, the resume handshake) read
    // no other member of a connection.
    const socket = partialSocket as Connection;
    connections.set(id, socket);

    return socket;
  };

  const wire: ChatWire = {
    sql,
    broadcast: (message, exclude) => { broadcasts.push({ frame: v.parse(FrameSchema, JSON.parse(message)), exclude }); },
    getConnection: (id) => connections.get(id),
    history: () => [...history],
    admitted: (id) => history.some((row) => row.id === id) || reserved.has(id),
    send: (input) => {
      if (isRefusal(landing)) return Promise.reject(new Error(landing.refuse));
      sent.push(input);

      if (landing === 'mid-turn') reserved.add(input.id);

      return Promise.resolve(landing);
    },
    interrupt: () => { interrupts += 1; },
    clear: () => {
      clears += 1;
      history.length = 0;

      return Promise.resolve();
    },
  };

  const transport = new ChatWireTransport(wire);

  const chunkRows = () => db.query<{ body: string }, []>('SELECT body FROM cf_ai_chat_stream_chunks ORDER BY chunk_index').all().map((row) => row.body);

  return {
    transport, broadcasts, history, reserved, sent, connection, chunkRows, db,
    interrupts: () => interrupts, clears: () => clears,
    responses: () => broadcasts.filter((b) => b.frame.type === 'cf_agent_use_chat_response').map((b) => b.frame),
    connectionFrames: (id: string): string[] => frames.get(id) ?? [],
  };
}

function chatRequest(id: string, text: string, file?: { url: string; mediaType: string; filename: string }): string {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request', id,
    init: { method: 'POST', body: JSON.stringify({
      messages: [{ id: `input-${id}`, role: 'user', parts: [
        ...(file ? [{ type: 'file', ...file }] : []), { type: 'text', text },
      ], metadata: { kinuMode: 'plan' } }],
      trigger: 'submit-message',
    }) },
  });
}

function chunks(parts: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } });
}

const turnStart = (turnId: string, messageId: string): SessionEvent =>
  ({ type: 'turn-start', kind: 'user', text: 'x', workMode: 'build', turnId, messageId });

describe('ChatWireTransport', () => {
  test('a chat request hands the message to the loop under its own id and writes no row; a splice answers at once', async () => {
    const h = harness('mid-turn');
    const conn = h.connection('c1');
    const file = { url: 'data:text/plain;base64,aGk=', mediaType: 'text/plain', filename: 'note.txt' };

    expect(await h.transport.onMessage(conn, chatRequest('req-1', 'hello', file))).toBe(true);
    // The loop was asked, with the id the client renders the message by; the
    // transcript holds nothing the transport wrote — the loop's drain writes
    // the row when the splice lands, with the stamps that say where.
    expect(h.sent).toEqual([{ text: 'hello', files: [file], id: 'input-req-1', mode: 'plan' }]);
    expect(h.history).toEqual([]);
    expect(h.broadcasts).toEqual([{ frame: { type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true, landed: 'mid-turn' }, exclude: undefined }]);
    // A replay of the same request — the reservation the loop holds is what
    // says the message was taken — carries nothing new and asks for no turn.
    await h.transport.onMessage(conn, chatRequest('req-1', 'hello', file));
    expect(h.sent).toHaveLength(1);
    expect(h.responses()).toHaveLength(2);
  });

  test('a send the loop refuses closes the request with the refusal, and nothing is written', async () => {
    const h = harness({ refuse: 'send requires the message text' });
    const conn = h.connection('c1');

    await h.transport.onMessage(conn, chatRequest('req-1', '   '));
    expect(h.responses()).toEqual([{ type: 'cf_agent_use_chat_response', id: 'req-1', body: 'send requires the message text', done: true, error: true }]);
    expect(h.history).toEqual([]);
    expect(h.broadcasts.filter((b) => b.frame.type === 'cf_agent_chat_messages')).toEqual([]);
  });

  test("a client's claim to another request's input is never accepted: the message is admitted under its own id", async () => {
    const h = harness('turn');
    const conn = h.connection('c1');

    // The body carries a forged token beside the message. Nothing reads it: the
    // admission is the message's own id, persisted before the loop is asked.
    const forged = JSON.stringify({
      type: 'cf_agent_use_chat_request', id: 'req-forged',
      init: { method: 'POST', body: JSON.stringify({
        messages: [{ id: 'input-mine', role: 'user', parts: [{ type: 'text', text: 'mine' }] }],
        trigger: 'submit-message', kinuRequestId: 'somebody-else',
      }) },
    });

    await h.transport.onMessage(conn, forged);

    expect(h.sent).toEqual([{ text: 'mine', files: [], id: 'input-mine', mode: 'build' }]);
  });

  test('each frame is admitted whole before the next is read, so two arriving together bind their own messages', async () => {
    const h = harness('turn');
    const conn = h.connection('c1');

    const a = h.transport.onMessage(conn, chatRequest('req-a', 'a'));
    const b = h.transport.onMessage(conn, chatRequest('req-b', 'b'));
    await Promise.all([a, b]);

    expect(h.sent.map((input) => [input.id, input.text])).toEqual([['input-req-a', 'a'], ['input-req-b', 'b']]);
  });

  test('a full browser history admits only what is new: neither a stored row nor a message the loop still holds, however alike the text', async () => {
    const h = harness('mid-turn');
    const conn = h.connection('c1');
    // A row the transcript already holds, and a message an earlier request
    // sent — accepted into a running turn, its row not yet landed — with the
    // same text as the new one.
    h.history.push({ id: 'old', role: 'user', parts: [{ type: 'text', text: 'old' }] });
    await h.transport.onMessage(conn, JSON.stringify({
      type: 'cf_agent_use_chat_request', id: 'req-pending',
      init: { method: 'POST', body: JSON.stringify({
        messages: [{ id: 'pending', role: 'user', parts: [{ type: 'text', text: 'same text' }] }], trigger: 'submit-message',
      }) },
    }));

    await h.transport.onMessage(conn, JSON.stringify({
      type: 'cf_agent_use_chat_request', id: 'req-new',
      init: { method: 'POST', body: JSON.stringify({
        messages: [
          { id: 'old', role: 'user', parts: [] },
          { id: 'pending', role: 'user', parts: [{ type: 'text', text: 'same text' }] },
          { id: 'new', role: 'user', parts: [{ type: 'text', text: 'same text' }] },
        ],
        trigger: 'submit-message',
      }) },
    }));

    expect(h.sent.map((input) => input.id)).toEqual(['pending', 'new']);
  });

  test("a turn's chunks are broadcast under its request, stored for resume, and accumulate into the answer", async () => {
    const h = harness('turn');
    const conn = h.connection('c1');
    await h.transport.onMessage(conn, chatRequest('req-1', 'hello'));
    expect(h.responses()).toEqual([]);

    // The loop wrote the opening row and opened the turn: every tab reads the
    // transcript with the operator's message in it.
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    expect(h.broadcasts.at(-1)).toMatchObject({ frame: { type: 'cf_agent_chat_messages', messages: [{ id: 'input-req-1' }] }, exclude: undefined });
    await h.transport.observe(chunks([
      { type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'hel' }, { type: 'text-delta', id: 't', delta: 'lo' },
      { type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish' },
    ]));
    h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'hello', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });

    const frames = h.responses();
    expect(frames.map((f) => f.id)).toEqual(Array<string>(9).fill('req-1'));
    expect(frames.slice(0, 8).map((f) => JSON.parse(f.body ?? '{}').type)).toEqual([
      'start', 'start-step', 'text-start', 'text-delta', 'text-delta', 'text-end', 'finish-step', 'finish',
    ]);
    // The start chunk carries the id the row is persisted under.
    expect(JSON.parse(frames[0]?.body ?? '{}').messageId).toBe('msg-1');
    expect(frames[8]).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });
    // Stored for resume: the SDK packs flushed chunks into segment rows, so
    // the count is of segments, and the completed stream is what a late ACK
    // is replayed from (the resume case below reads the bodies back).
    expect(h.chunkRows().length).toBeGreaterThan(0);
    expect(h.transport.answer('msg-1')).toEqual({ id: 'msg-1', role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'hello', state: 'done' }] });
    expect(h.transport.answer('msg-1')).toBeNull();
    expect(h.broadcasts.at(-1)?.frame.type).toBe('cf_agent_chat_messages');
  });

  test('a reconnecting client is told what is resuming and gets the stored chunks replayed', async () => {
    const h = harness('turn');
    const first = h.connection('c1');
    await h.transport.onMessage(first, chatRequest('req-1', 'hello'));
    h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    // The first delta flushes the store; the turn is still live.
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'par' }]));
    expect(h.chunkRows().length).toBeGreaterThan(0);

    const second = h.connection('c2');
    h.transport.onConnect(second);
    expect(JSON.parse(h.connectionFrames('c2')[0] ?? '{}')).toEqual({ type: 'cf_agent_stream_resuming', id: 'req-1' });
    await h.transport.onMessage(second, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'req-1' }));
    const replayed = h.connectionFrames('c2').slice(1).map((frame) => v.parse(FrameSchema, JSON.parse(frame)));
    expect(replayed.slice(0, 3).map((f) => [JSON.parse(f.body ?? '{}').type, f.replay])).toEqual([['start', true], ['text-start', true], ['text-delta', true]]);
    expect(replayed.at(-1)).toMatchObject({ done: false, replay: true });
  });

  test('cancel interrupts the loop; clear resets the store and tells the other tabs', async () => {
    const h = harness('turn');
    const conn = h.connection('c1');
    await h.transport.onMessage(conn, JSON.stringify({ type: 'cf_agent_chat_request_cancel', id: 'req-1' }));
    expect(h.interrupts()).toBe(1);
    await h.transport.onMessage(conn, JSON.stringify({ type: 'cf_agent_chat_clear' }));
    expect(h.clears()).toBe(1);
    expect(h.broadcasts.at(-1)).toEqual({ frame: { type: 'cf_agent_chat_clear' }, exclude: ['c1'] });
    expect(await h.transport.onMessage(conn, JSON.stringify({ type: 'rpc', id: 'x', method: 'getAgentStatus' }))).toBe(false);
  });
});
