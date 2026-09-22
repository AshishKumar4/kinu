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
import { AwaitedList, createTestSql } from '@kinu.run/test-utils';
import { INTERRUPTED_TURN, type SendLanding, type SessionEvent } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { Connection } from 'agents';
import { ChatWireTransport, type ChatWire } from '../src/chat-transport';

const FrameSchema = v.looseObject({ type: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()), landed: v.optional(v.string()), replay: v.optional(v.boolean()) });

/** The loop's side of the wire, as a fixture: a send lands where the harness
 *  says, and what the loop holds — the rows a turn wrote, the reservations a
 *  splice keeps — is what `admitted` answers from. A send the loop refuses
 *  rejects with the loop's own classified error, as the real loop's does; a
 *  send that FAULTS rejects with whatever broke underneath it. */
interface HarnessRefusal { readonly refuse: string; readonly fault?: true; }

function isRefusal(landing: HarnessLanding): landing is HarnessRefusal {
  return v.is(v.object({ refuse: v.string() }), landing);
}

/** The loop's answer to a send: a landing at once, a refusal, or — as the
 *  loop itself answers — a landing decided later. */
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

  /** A socket the SDK's protocol helpers can drive. */
  const connection = (id: string): Connection => {
    const socketFrames: string[] = [];
    frames.set(id, socketFrames);

    const partialSocket: Pick<Connection, 'id' | 'send'> = { id, send: (frame: string) => { socketFrames.push(frame); } };
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

/** A request to an idle loop: taken now, answered once the turn it opened has
 *  run — the order the loop keeps, so a test drives the turn's events between
 *  the two and settles the landing last. */
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
    /** The loop's answer, once the turn has run. */
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

  test('a message the running turn ended before reading is answered by its rerun, under the request that sent it', async () => {
    // The loop answers the landing where it is decided: here, after the turn
    // that was running ended without a step for the words, reran them as the
    // operator's next turn under the message's own id, and finished.
    const landing = Promise.withResolvers<SendLanding>();
    const h = harness(landing.promise);
    const conn = h.connection('c1');
    const admitted = h.transport.onMessage(conn, chatRequest('req-1', 'one more thing'));
    await h.taken(1);

    // The rerun opens under the message's id: the request that sent it is
    // the request its stream and its done frame answer under.
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

    // One done frame, the rerun's, under `req-1` — never a `mid-turn` verdict
    // at admission that would have told the client the words were read by a
    // turn that never saw them.
    expect(h.responses().filter((frame) => frame.done === true)).toEqual([
      { type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true },
    ]);
    expect(h.responses().filter((frame) => frame.landed !== undefined)).toEqual([]);
  });

  test('two messages the rerun merged into one turn are both answered when it closes', async () => {
    // The loop reruns every leftover as ONE turn under the first one's id
    // and names the rest at its open; the second request has no turn of its
    // own, so the shared turn's close is what answers it.
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
    // Nothing told the tab its message was refused: a fault reads as a fault
    // to whoever owns the socket, never as the loop's answer.
    expect(h.responses()).toEqual([]);
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
    const h = openRequest();
    const conn = h.connection('c1');
    const { answered } = await h.open(conn, 'req-1', 'hello');
    expect(h.responses()).toEqual([]);

    // The loop wrote the opening row and opened the turn: every tab reads the
    // transcript with the operator's message in it.
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

  test('a relay that breaks mid-stream tells the tab, keeps its partial out of the transcript, and the turn still closes', async () => {
    const h = openRequest();
    const conn = h.connection('c1');
    const { answered } = await h.open(conn, 'req-1', 'hello');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));

    // Two chunks reach the relay, then the stream fails under it — the loop's
    // own copy is unaffected and commits the whole answer from its text.
    const broken = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: 'start' });
        controller.enqueue({ type: 'text-start', id: 't' });
        controller.enqueue({ type: 'text-delta', id: 't', delta: 'hel' });
        controller.error(new Error('the socket under the relay closed'));
      },
    });

    await h.transport.observe(broken, { index: 0 });

    // The tab is told the relay broke, under its own request, before the turn
    // ends — not left with a message that simply stops.
    expect(h.responses().at(-1)).toMatchObject({ id: 'req-1', done: false, error: true, body: expect.stringContaining('the socket under the relay closed') });
    // The three parts that arrived are not the answer: the transcript must
    // persist the loop's full text, so nothing offers the partial as the row.
    expect(h.transport.streamed('msg-1')).toBeNull();
    expect(h.transport.answer('msg-1')).toBeNull();

    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'hello', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);

    // The request still closes at the turn's own end, and the partial is not
    // kept as a finished answer for a late reader either.
    expect(h.responses().at(-1)).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });
    expect(h.transport.answer('msg-1')).toBeNull();
    expect(h.broadcasts.at(-1)?.frame.type).toBe('cf_agent_chat_messages');
  });

  test('a chunk the relay cannot place is a classified refusal to the tab, and the turn keeps its own record', async () => {
    // The `tool-input-start` never reached this relay, so the delta names a
    // call nothing here has open. Forwarded, the client's own stream reader
    // throws on it ("Received tool-input-delta for missing tool call with ID
    // ...") and the whole answer dies in the tab. The relay is what broke.
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

    // The tab reads OUR classification of what broke, never the SDK's sentence
    // about a chunk the client was never meant to be handed.
    const failed = h.responses().at(-1);
    expect(failed).toMatchObject({ id: 'req-1', done: false, error: true });
    expect(failed?.body).toContain('relaying the answer stream');
    expect(failed?.body).not.toContain('Ensure a "tool-input-start" chunk');
    // The frame itself never went out, and nothing after it did either: the
    // relay stops rather than racing on with a stream the client cannot follow.
    const relayed = h.responses().filter((frame) => frame.error !== true).map((frame) => frame.body ?? '');
    expect(relayed.some((body) => body.includes('tool-input-delta'))).toBe(false);
    expect(relayed.some((body) => body.includes('never relayed'))).toBe(false);

    // The turn is untouched: the loop commits its own answer, the request
    // closes at the turn's end, and no partial is offered as the durable row.
    expect(h.transport.streamed('msg-1')).toBeNull();
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'reading it', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
    expect(h.responses().at(-1)).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });
    expect(h.broadcasts.at(-1)?.frame.type).toBe('cf_agent_chat_messages');
  });

  test('a reasoning delta the relay cannot place degrades it too, so the thought is not half-sent', async () => {
    // The same fatal rule as the tool-call case, and the reason "Thinking"
    // appeared and vanished: the client's reader throws on a `reasoning-delta`
    // whose `reasoning-start` it never saw, and the thought — plus everything
    // after it — dies in the tab. The reader clears its text and reasoning ids
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
      // The second step reuses the id; the reader forgot it at the step end.
      { type: 'reasoning-delta', id: 'r', delta: 'and again' },
    ]), { index: 0 });

    const failed = h.responses().at(-1);
    expect(failed).toMatchObject({ id: 'req-1', done: false, error: true });
    expect(failed?.body).toContain('relaying the answer stream');
    const relayed = h.responses().filter((frame) => frame.error !== true).map((frame) => frame.body ?? '');
    expect(relayed.some((body) => body.includes('and again'))).toBe(false);
    // What the client DID see still reached it.
    expect(relayed.some((body) => body.includes('weighing it'))).toBe(true);

    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: '', toolCalls: [], steps: 2, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
    expect(h.responses().at(-1)).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });
  });

  test("a turn's second provider call cannot rename the answer: one message, under the row's id", async () => {
    // An answer the provider cut at its output limit is continued by a SECOND
    // provider call, and that call is its own SDK stream — its own `start`,
    // which carries a message id of the SDK's own minting whenever the caller
    // configured one. Read on the first stream's state that `start` RENAMES
    // the answer, and every later chunk, the resume store and the transcript
    // hand-off then key on an id the loop never persisted.
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

    // Both calls are one answer, under the id the loop persists the row with.
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
    // The first delta flushes the store; the turn is still live.
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'par' }]), { index: 0 });
    expect(h.chunkRows().length).toBeGreaterThan(0);

    const second = h.connection('c2');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.onConnect(second);
    // Resuming first, then the transcript as it is now — the live turn's
    // opening row, which the loop wrote when the turn started.
    expect(JSON.parse(h.connectionFrames('c2')[0] ?? '{}')).toEqual({ type: 'cf_agent_stream_resuming', id: 'req-1' });
    expect(v.parse(v.looseObject({ type: v.string(), messages: v.array(v.object({ id: v.string() })) }), JSON.parse(h.connectionFrames('c2')[1] ?? '{}'))).toMatchObject({
      type: 'cf_agent_chat_messages', messages: [{ id: 'input-req-1' }],
    });
    await h.transport.onMessage(second, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'req-1' }));
    const replayed = h.connectionFrames('c2').slice(2).map((frame) => v.parse(FrameSchema, JSON.parse(frame)));
    expect(replayed.slice(0, 3).map((f) => [JSON.parse(f.body ?? '{}').type, f.replay])).toEqual([['start', true], ['text-start', true], ['text-delta', true]]);
    expect(replayed.at(-1)).toMatchObject({ done: false, replay: true });
    // The turn is still running while the tab resumed; its end is what answers the request.
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'hel', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
  });

  test('an interrupted turn closes with the abort chunk and no error frame; a failure still carries one', async () => {
    // A Stop is the operator's own act, not a failure of the turn: the SDK's
    // client reads an `error: true` frame as the stream's error and the hook
    // paints an error card, which every Stop showed after the switch. The
    // abort chunk the model stream carries is the whole report of a cut.
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

    // A turn that FAILED still tells the tab so, before it closes.
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
