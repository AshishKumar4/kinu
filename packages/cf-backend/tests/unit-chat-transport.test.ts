/**
 * The hosted root's chat transport over the real SDK primitives, pinning the wire the React hook reads.
 * The transport writes no row: the loop does, when it opens the turn or lands the splice.
 */
import { describe, expect, test } from 'bun:test';
import type { UIMessage, UIMessageChunk } from 'ai';
import * as v from 'valibot';
import { AwaitedList, createTestSql } from '@kinu.run/test-utils';
import { INTERRUPTED_TURN, type SendLanding, type SessionEvent } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { Connection } from 'agents';
import { ChatWireTransport, type ChatWire } from '../src/chat-transport';
import { socketConnection } from './helpers/bindings';

const FrameSchema = v.looseObject({ type: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()), landed: v.optional(v.string()), replay: v.optional(v.boolean()) });

/** The loop's side of the wire: a refused send rejects with the loop's classified error, a faulting one
 *  with whatever broke underneath. */
interface HarnessRefusal { readonly refuse: string; readonly fault?: true; }

function isRefusal(landing: HarnessLanding): landing is HarnessRefusal {
  return v.is(v.object({ refuse: v.string() }), landing);
}

type HarnessLanding = SendLanding | HarnessRefusal | Promise<SendLanding>;

function harness(landing: HarnessLanding = 'turn', loadHistory?: () => Promise<UIMessage[]>) {
  const { sql, db } = createTestSql();
  const broadcasts: Array<{ frame: v.InferOutput<typeof FrameSchema>; exclude: string[] | undefined }> = [];
  const history: UIMessage[] = [];
  /** The ids the loop holds a reservation for: every send accepted mid-turn. */
  const reserved = new Set<string>();
  const sent = new AwaitedList<{ text: string; files: readonly { url: string }[]; id: string; mode: string }>();
  let interrupts = 0;
  let clears = 0;
  const connections = new Map<string, Connection>();
  const frames = new Map<string, string[]>();

  /** A socket the SDK's protocol helpers can drive; every other platform-socket member throws, so a reach past them names itself. */
  const connection = (id: string): Connection => {
    const socketFrames: string[] = [];
    frames.set(id, socketFrames);
    const socket = socketConnection({ id, send: (frame: string) => { socketFrames.push(frame); } });
    connections.set(id, socket);

    return socket;
  };

  const wire: ChatWire = {
    sql,
    broadcast: (message, exclude) => { broadcasts.push({ frame: v.parse(FrameSchema, JSON.parse(message)), exclude }); },
    getConnection: (id) => connections.get(id),
    history: loadHistory ?? (async () => [...history]),
    admitted: (id) => history.some((row) => row.id === id) || reserved.has(id),
    send: (input) => {
      if (isRefusal(landing)) return Promise.reject(landing.fault === true ? new Error(landing.refuse) : new KinuError('bad_input', landing.refuse));
      sent.push(input);
      reserved.add(input.id);

      return landing instanceof Promise ? landing : Promise.resolve(landing);
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
    transport, broadcasts, history, reserved, sent: sent.items, taken: (count: number) => sent.until((items) => items.length >= count), connection, chunkRows, db,
    interrupts: () => interrupts, clears: () => clears,
    responses: () => broadcasts.filter((b) => b.frame.type === 'cf_agent_use_chat_response').map((b) => b.frame),
    connectionFrames: (id: string): string[] => frames.get(id) ?? [],
  };
}

/** A request to an idle loop, answered once its turn has run; tests drive the turn's events, then settle the landing last. */
function openRequest(landing: SendLanding | HarnessRefusal = 'turn', loadHistory?: () => Promise<UIMessage[]>) {
  const settled = Promise.withResolvers<SendLanding>();
  const h = harness(settled.promise, loadHistory);

  return {
    ...h,
    async open(conn: Connection, id: string, text: string): Promise<{ answered: Promise<boolean> }> {
      const answered = h.transport.onMessage(conn, chatRequest(id, text));
      await h.taken(h.sent.length + 1);

      return { answered };
    },
    async land(answered: Promise<boolean>): Promise<void> {
      if (isRefusal(landing)) throw new Error('a refusal is answered at admission, not landed');
      settled.resolve(landing);
      expect(await answered).toBe(true);
    },
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

test('history materialization finishes before connect publication and chat admission', async () => {
  const pending = Promise.withResolvers<UIMessage[]>();
  const h = harness('turn', () => pending.promise);
  const connection = h.connection('waiting-history');
  const connected = h.transport.onConnect(connection);
  const admitted = h.transport.onMessage(connection, chatRequest('replayed', 'already stored'));

  expect(h.connectionFrames(connection.id)).toEqual([]);
  expect(h.sent).toEqual([]);
  h.history.push({ id: 'input-replayed', role: 'user', parts: [{ type: 'text', text: 'already stored' }] });
  pending.resolve([...h.history]);
  await Promise.all([connected, admitted]);
  expect(h.sent).toEqual([]);
  const frames = h.connectionFrames(connection.id).map((text) => v.parse(FrameSchema, JSON.parse(text)));
  expect(frames).toContainEqual({ type: 'cf_agent_chat_messages', messages: [{ id: 'input-replayed', role: 'user', parts: [{ type: 'text', text: 'already stored' }] }] });
});

test('turn completion waits for materialized history before publishing done', async () => {
  const pending = Promise.withResolvers<UIMessage[]>();
  const h = harness('turn', () => pending.promise);
  await h.transport.openTurn({ turnId: 'background', messageId: 'answer', userTurn: false, carried: [] });
  const closing = h.transport.closeTurn();

  expect(h.responses()).toEqual([]);
  pending.resolve([{ id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'settled' }] }]);
  await closing;
  expect(h.responses()).toHaveLength(1);
  expect(h.responses()[0]).toMatchObject({ done: true });
  expect(h.broadcasts.at(-1)).toMatchObject({ frame: { type: 'cf_agent_chat_messages', messages: [{ id: 'answer' }] } });
});

function chunks(parts: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } });
}

const turnStart = (turnId: string, messageId: string, carried: readonly string[] = []): SessionEvent =>
  ({ type: 'turn-start', kind: 'user', text: 'x', workMode: 'build', turnId, messageId, carried });

describe('ChatWireTransport', () => {
  test('a chat request hands the message to the loop under its own id and writes no row; a splice answers at once', async () => {
    const h = harness('mid-turn');
    const conn = h.connection('c1');
    const file = { url: 'data:text/plain;base64,aGk=', mediaType: 'text/plain', filename: 'note.txt' };

    expect(await h.transport.onMessage(conn, chatRequest('req-1', 'hello', file))).toBe(true);
    // The loop's drain writes the row when the splice lands, never the transport.
    expect(h.sent).toEqual([{ text: 'hello', files: [file], id: 'input-req-1', mode: 'plan' }]);
    expect(h.history).toEqual([]);
    expect(h.broadcasts).toEqual([{ frame: { type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true, landed: 'mid-turn' }, exclude: undefined }]);
    // The loop's reservation says the message was taken, so a replay asks for no turn.
    await h.transport.onMessage(conn, chatRequest('req-1', 'hello', file));
    expect(h.sent).toHaveLength(1);
    expect(h.responses()).toHaveLength(2);
  });

  test('a message the running turn ended before reading is answered by its rerun, under the request that sent it', async () => {
    const landing = Promise.withResolvers<SendLanding>();
    const h = harness(landing.promise);
    const conn = h.connection('c1');
    const admitted = h.transport.onMessage(conn, chatRequest('req-1', 'one more thing'));
    await h.taken(1);

    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'one more thing' }] });
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    expect(h.responses()).toEqual([]);
    await h.transport.observe(chunks([
      { type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'the tools are' },
      { type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish' },
    ]), { index: 0 });
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'one more thing', assistantResponse: 'the tools are', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    landing.resolve('turn');
    expect(await admitted).toBe(true);

    // Never a `mid-turn` verdict at admission, which would claim a turn read words it never saw.
    expect(h.responses().filter((frame) => frame.done === true)).toEqual([
      { type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true },
    ]);
    expect(h.responses().filter((frame) => frame.landed !== undefined)).toEqual([]);
  });

  test('two messages the rerun merged into one turn are both answered when it closes', async () => {
    // Leftovers rerun as one turn under the first id, so the shared turn's close answers the second request.
    const landing = Promise.withResolvers<SendLanding>();
    const h = harness(landing.promise);
    const conn = h.connection('c1');
    const first = h.transport.onMessage(conn, chatRequest('req-a', 'first'));
    await h.taken(1);
    const second = h.transport.onMessage(conn, chatRequest('req-b', 'second'));
    await h.taken(2);

    h.history.push({ id: 'input-req-a', role: 'user', parts: [{ type: 'text', text: 'first\n\nsecond' }] });
    await h.transport.deliver(turnStart('input-req-a', 'msg-1', ['input-req-b']));
    expect(h.responses().filter((frame) => frame.done === true)).toEqual([]);
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'first\n\nsecond', assistantResponse: 'both', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    landing.resolve('turn');
    expect(await first).toBe(true);
    expect(await second).toBe(true);

    expect(h.responses().filter((frame) => frame.done === true)).toEqual([
      { type: 'cf_agent_use_chat_response', id: 'req-a', body: '', done: true },
      { type: 'cf_agent_use_chat_response', id: 'req-b', body: '', done: true },
    ]);
  });

  test('a send the loop refuses closes the request with the refusal, and nothing is written', async () => {
    const h = harness({ refuse: 'send requires the message text' });
    const conn = h.connection('c1');

    await h.transport.onMessage(conn, chatRequest('req-1', '   '));
    expect(h.responses()).toEqual([{ type: 'cf_agent_use_chat_response', id: 'req-1', body: 'send requires the message text', done: true, error: true }]);
    expect(h.history).toEqual([]);
    expect(h.broadcasts.filter((b) => b.frame.type === 'cf_agent_chat_messages')).toEqual([]);
  });

  test('a send that faults underneath the loop is not a refusal: it propagates, and the request is not closed as one', async () => {
    const h = harness({ refuse: 'the send ledger is unreadable', fault: true });
    const conn = h.connection('c1');

    await expect(h.transport.onMessage(conn, chatRequest('req-1', 'hello'))).rejects.toThrow('the loop failed to take a client message');
    // A fault reads as a fault to the socket owner, never as the loop's answer.
    expect(h.responses()).toEqual([]);
  });

  test("a client's claim to another request's input is never accepted: the message is admitted under its own id", async () => {
    const h = harness('turn');
    const conn = h.connection('c1');

    // A forged token beside the message is never read: admission is the message's own id.
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
    const h = openRequest();
    const conn = h.connection('c1');
    const { answered } = await h.open(conn, 'req-1', 'hello');
    expect(h.responses()).toEqual([]);

    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    expect(h.broadcasts.at(-1)).toMatchObject({ frame: { type: 'cf_agent_chat_messages', messages: [{ id: 'input-req-1' }] }, exclude: undefined });
    await h.transport.observe(chunks([
      { type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'hel' }, { type: 'text-delta', id: 't', delta: 'lo' },
      { type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish' },
    ]), { index: 0 });
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'hello', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);

    const frames = h.responses();
    expect(frames.map((f) => f.id)).toEqual(Array<string>(9).fill('req-1'));
    expect(frames.slice(0, 8).map((f) => JSON.parse(f.body ?? '{}').type)).toEqual([
      'start', 'start-step', 'text-start', 'text-delta', 'text-delta', 'text-end', 'finish-step', 'finish',
    ]);
    expect(JSON.parse(frames[0]?.body ?? '{}').messageId).toBe('msg-1');
    expect(frames[8]).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });
    // The SDK packs flushed chunks into segment rows, so the count is of segments.
    expect(h.chunkRows().length).toBeGreaterThan(0);
    expect(h.transport.answer('msg-1')).toEqual({ id: 'msg-1', role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'hello', state: 'done' }] });
    expect(h.transport.answer('msg-1')).toBeNull();
    expect(h.broadcasts.at(-1)?.frame.type).toBe('cf_agent_chat_messages');
  });

  test('a relay that breaks mid-stream tells the tab, keeps its partial out of the transcript, and the turn still closes', async () => {
    const h = openRequest();
    const conn = h.connection('c1');
    const { answered } = await h.open(conn, 'req-1', 'hello');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));

    const broken = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: 'start' });
        controller.enqueue({ type: 'text-start', id: 't' });
        controller.enqueue({ type: 'text-delta', id: 't', delta: 'hel' });
        controller.error(new Error('the socket under the relay closed'));
      },
    });

    await h.transport.observe(broken, { index: 0 });

    expect(h.responses().at(-1)).toMatchObject({ id: 'req-1', done: false, error: true, body: expect.stringContaining('the socket under the relay closed') });
    // The transcript persists the loop's full text, so nothing offers the partial as the row.
    expect(h.transport.streamed('msg-1')).toBeNull();
    expect(h.transport.answer('msg-1')).toBeNull();

    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'hello', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);

    expect(h.responses().at(-1)).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });
    expect(h.transport.answer('msg-1')).toBeNull();
    expect(h.broadcasts.at(-1)?.frame.type).toBe('cf_agent_chat_messages');
  });

  test('a chunk the relay cannot place is a classified refusal to the tab, and the turn keeps its own record', async () => {
    // The delta names a call this relay never saw open; forwarded, the client's reader throws
    // ("Received tool-input-delta for missing tool call with ID ...") and the answer dies in the tab.
    const h = openRequest();
    const conn = h.connection('c1');
    const { answered } = await h.open(conn, 'req-1', 'hello');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));

    await h.transport.observe(chunks([
      { type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'reading it' }, { type: 'text-end', id: 't' },
      { type: 'tool-input-delta', toolCallId: 'call_01a0c7e6c17f', inputTextDelta: '{"path":' },
      { type: 'text-start', id: 'u' }, { type: 'text-delta', id: 'u', delta: 'never relayed' },
    ]), { index: 0 });

    const failed = h.responses().at(-1);
    expect(failed).toMatchObject({ id: 'req-1', done: false, error: true });
    expect(failed?.body).toContain('relaying the answer stream');
    expect(failed?.body).not.toContain('Ensure a "tool-input-start" chunk');
    // The relay stops rather than racing on with a stream the client cannot follow.
    const relayed = h.responses().filter((frame) => frame.error !== true).map((frame) => frame.body ?? '');
    expect(relayed.some((body) => body.includes('tool-input-delta'))).toBe(false);
    expect(relayed.some((body) => body.includes('never relayed'))).toBe(false);

    expect(h.transport.streamed('msg-1')).toBeNull();
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'reading it', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
    expect(h.responses().at(-1)).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });
    expect(h.broadcasts.at(-1)?.frame.type).toBe('cf_agent_chat_messages');
  });

  test('a reasoning delta the relay cannot place degrades it too, so the thought is not half-sent', async () => {
    // The client's reader throws on a `reasoning-delta` without its `reasoning-start`, and clears reasoning ids
    // on every `finish-step`, so this relay does too.
    const h = openRequest();
    const conn = h.connection('c1');
    const { answered } = await h.open(conn, 'req-1', 'hello');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));

    await h.transport.observe(chunks([
      { type: 'start' }, { type: 'start-step' },
      { type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: 'weighing it' },
      { type: 'finish-step' }, { type: 'start-step' },
      { type: 'reasoning-delta', id: 'r', delta: 'and again' },
    ]), { index: 0 });

    const failed = h.responses().at(-1);
    expect(failed).toMatchObject({ id: 'req-1', done: false, error: true });
    expect(failed?.body).toContain('relaying the answer stream');
    const relayed = h.responses().filter((frame) => frame.error !== true).map((frame) => frame.body ?? '');
    expect(relayed.some((body) => body.includes('and again'))).toBe(false);
    expect(relayed.some((body) => body.includes('weighing it'))).toBe(true);

    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: '', toolCalls: [], steps: 2, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
    expect(h.responses().at(-1)).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });
  });

  test("a turn's second provider call cannot rename the answer: one message, under the row's id", async () => {
    // A continuation after an output-limit cut is a second SDK stream whose `start` carries an SDK-minted
    // message id; honouring it would key the rest on an id the loop never persisted.
    const h = openRequest();
    const conn = h.connection('c1');
    const { answered } = await h.open(conn, 'req-1', 'hello');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));

    await h.transport.observe(chunks([
      { type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'first half' }, { type: 'text-end', id: 't' },
      { type: 'finish-step' }, { type: 'finish' },
    ]), { index: 0 });
    await h.transport.observe(chunks([
      { type: 'start', messageId: 'sdk-minted-2' }, { type: 'start-step' }, { type: 'text-start', id: 'u' },
      { type: 'text-delta', id: 'u', delta: ' and the rest' }, { type: 'text-end', id: 'u' },
      { type: 'finish-step' }, { type: 'finish' },
    ]), { index: 1 });

    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'first half and the rest', toolCalls: [], steps: 2, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);

    const answer = h.transport.answer('msg-1');
    expect(answer?.id).toBe('msg-1');
    expect(answer?.parts.filter((part) => part.type === 'text')).toEqual([
      { type: 'text', text: 'first half', state: 'done' },
      { type: 'text', text: ' and the rest', state: 'done' },
    ]);
  });

  test('a reconnecting client is told what is resuming and gets the stored chunks replayed', async () => {
    const h = openRequest();
    const first = h.connection('c1');
    const { answered } = await h.open(first, 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'par' }]), { index: 0 });
    expect(h.chunkRows().length).toBeGreaterThan(0);

    const second = h.connection('c2');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.onConnect(second);
    expect(JSON.parse(h.connectionFrames('c2')[0] ?? '{}')).toEqual({ type: 'cf_agent_stream_resuming', id: 'req-1' });
    expect(v.parse(v.looseObject({ type: v.string(), messages: v.array(v.object({ id: v.string() })) }), JSON.parse(h.connectionFrames('c2')[1] ?? '{}'))).toMatchObject({
      type: 'cf_agent_chat_messages', messages: [{ id: 'input-req-1' }],
    });
    await h.transport.onMessage(second, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'req-1' }));
    const replayed = h.connectionFrames('c2').slice(2).map((frame) => v.parse(FrameSchema, JSON.parse(frame)));
    expect(replayed.slice(0, 3).map((f) => [JSON.parse(f.body ?? '{}').type, f.replay])).toEqual([['start', true], ['text-start', true], ['text-delta', true]]);
    expect(replayed.at(-1)).toMatchObject({ done: false, replay: true });
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'hel', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
  });

  test('an interrupted turn closes with the abort chunk and no error frame; a failure still carries one', async () => {
    // A Stop is not a failure: the SDK client reads `error: true` as a stream error, so the abort chunk alone reports the cut.
    const h = openRequest();
    const conn = h.connection('c1');
    const { answered } = await h.open(conn, 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'abort' }]), { index: 0 });
    await h.transport.deliver({ type: 'error', message: INTERRUPTED_TURN });
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: '', toolCalls: [], steps: 0, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);

    const frames = h.responses();
    expect(frames.filter((f) => f.error === true)).toEqual([]);
    expect(frames.slice(0, 2).map((f) => JSON.parse(f.body ?? '{}').type)).toEqual(['start', 'abort']);
    expect(frames.at(-1)).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });

    const failed = openRequest();
    const tab = failed.connection('c1');
    const failing = await failed.open(tab, 'req-2', 'hello');
    await failed.transport.deliver(turnStart('input-req-2', 'msg-2'));
    await failed.transport.deliver({ type: 'error', message: 'the provider refused the request' });
    expect(failed.responses().at(-1)).toMatchObject({ id: 'req-2', done: false, error: true, body: 'the provider refused the request' });
    await failed.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: '', toolCalls: [], steps: 0, durationMs: 0, feedback: null, hadError: true, origin: 'user' } });
    await failed.land(failing.answered);
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
