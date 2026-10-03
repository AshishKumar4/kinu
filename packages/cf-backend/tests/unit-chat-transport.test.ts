/**
 * The hosted root's chat transport over the real SDK primitives, pinning the wire the React hook reads.
 * The transport writes no row: the loop does, when it opens the turn or lands the splice.
 */
import { describe, expect, test } from 'bun:test';
import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import * as v from 'valibot';
import { AwaitedList, createTestSql } from '@kinu.run/test-utils';
import { INTERRUPTED_TURN, type JsonObject, type SendLanding, type SessionEvent } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { Connection } from 'agents';
import { ChatWireTransport, type ChatWire } from '../src/chat-transport';
import { socketConnection } from './helpers/bindings';

const FrameSchema = v.looseObject({
  type: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()), landed: v.optional(v.string()),
  replay: v.optional(v.boolean()), replayComplete: v.optional(v.boolean()), restated: v.optional(v.boolean()),
});

/** The loop's side of the wire: a refused send rejects with the loop's classified error, a faulting one
 *  with whatever broke underneath. */
interface HarnessRefusal { readonly refuse: string; readonly fault?: true; }

function isRefusal(landing: HarnessLanding): landing is HarnessRefusal {
  return v.is(v.object({ refuse: v.string() }), landing);
}

/** One landing for every send, or one per send in order. */
type HarnessLanding = SendLanding | HarnessRefusal | Promise<SendLanding> | readonly SendLanding[];

function harness(landing: HarnessLanding = 'turn', loadHistory?: () => Promise<UIMessage[]>) {
  const { db } = createTestSql();
  const broadcasts: Array<{ frame: v.InferOutput<typeof FrameSchema>; exclude: string[] | undefined }> = [];
  const history: UIMessage[] = [];
  /** The ids the loop holds a reservation for: every send accepted mid-turn. */
  const reserved = new Set<string>();
  const sent = new AwaitedList<{ text: string; files: readonly { url: string }[]; id: string; mode: string }>();
  let interrupts = 0;
  let clears = 0;
  /** Whether the ledger holds a turn no activation has opened here yet: one an eviction left open. */
  let owed = false;
  /** The open turn's finished steps as the ledger records them, drawn. */
  const recorded: JsonObject[][] = [];
  const connections = new Map<string, Connection>();
  const frames = new Map<string, string[]>();
  /** Everything a socket was handed, in order: its sends and broadcasts that included it. */
  const received = new Map<string, string[]>();

  /** Drivable by the SDK's protocol helpers; any other member throws, naming itself. */
  const connection = (id: string): Connection => {
    const socketFrames: string[] = [];
    const heard: string[] = [];
    frames.set(id, socketFrames);
    received.set(id, heard);
    const socket = socketConnection({ id, send: (frame: string) => { socketFrames.push(frame); heard.push(frame); } });
    connections.set(id, socket);

    return socket;
  };

  const wire: ChatWire = {
    resumes: true,
    turnOwed: () => owed,
    steps: () => recorded,
    broadcast: (message, exclude) => {
      broadcasts.push({ frame: v.parse(FrameSchema, JSON.parse(message)), exclude });

      for (const [id, heard] of received) if (!(exclude ?? []).includes(id)) heard.push(message);
    },
    getConnection: (id) => connections.get(id),
    history: loadHistory ?? (async () => [...history]),
    admitted: async (id) => history.some((row) => row.id === id) || reserved.has(id),
    send: (input) => {
      if (isRefusal(landing)) return Promise.reject(landing.fault === true ? new Error(landing.refuse) : new KinuError('bad_input', landing.refuse));
      sent.push(input);
      reserved.add(input.id);

      if (Array.isArray(landing)) return Promise.resolve(landing[sent.items.length - 1] ?? 'mid-turn');

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


  return {
    /** The object after an eviction mid-turn: a fresh transport over the same database and sockets, the turn owed. */
    afterEviction: () => {
      owed = true;

      return new ChatWireTransport(wire);
    },
    transport, broadcasts, history, reserved, recorded, sent: sent.items, taken: (count: number) => sent.until((items) => items.length >= count), connection, db,
    interrupts: () => interrupts, clears: () => clears,
    responses: () => broadcasts.filter((b) => b.frame.type === 'cf_agent_use_chat_response').map((b) => b.frame),
    connectionFrames: (id: string): string[] => frames.get(id) ?? [],
    received: (id: string): string[] => received.get(id) ?? [],
  };
}

/** A request to an idle loop, answered once its turn has run; the landing settles last. */
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
  await h.transport.openTurn({ turnId: 'background', messageId: 'answer', userTurn: false, carried: [], finishedSteps: 0 });
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

const turnStart = (turnId: string, messageId: string, carried: readonly string[] = [], finishedSteps = 0): SessionEvent =>
  ({ type: 'turn-start', kind: 'user', text: 'x', workMode: 'build', turnId, messageId, carried, finishedSteps });

/** A tab's replay, a frame a line: `R ` marks a chunk of a step restated from the ledger. */
function replayOf(frames: readonly string[]): string[] {
  return frames.map((text) => v.parse(FrameSchema, JSON.parse(text))).filter((frame) => frame.replay === true).map((frame) => {
    if (frame.replayComplete === true) return 'complete';
    const chunk = v.parse(v.looseObject({ type: v.string(), delta: v.optional(v.string()), toolCallId: v.optional(v.string()) }), JSON.parse(frame.body ?? ''));

    return [frame.restated === true ? 'R' : '', chunk.type, chunk.delta ?? '', chunk.toolCallId ?? ''].filter((word) => word !== '').join(' ');
  });
}

const STEP_ONE: UIMessageChunk[] = [
  { type: 'start-step' }, { type: 'text-start', id: 't0' }, { type: 'text-delta', id: 't0', delta: 'one' }, { type: 'text-end', id: 't0' },
  { type: 'finish-step' },
];

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

  // Review job 163: a splice ahead of the message that opened the turn kept its mapping, so when that splice was
  // later handed back as its own turn, the turn streamed under the closed request and its tab heard nothing.
  test('a message spliced ahead of the one that opened the turn answers under its own id if it later runs alone', async () => {
    const h = harness(['mid-turn', 'turn']);
    const conn = h.connection('c1');

    const request = JSON.stringify({
      type: 'cf_agent_use_chat_request', id: 'req-1',
      init: { method: 'POST', body: JSON.stringify({ trigger: 'submit-message', messages: [
        { id: 'input-a', role: 'user', parts: [{ type: 'text', text: 'first' }] },
        { id: 'input-b', role: 'user', parts: [{ type: 'text', text: 'second' }] },
      ] }) },
    });

    await h.transport.onMessage(conn, request);
    await h.transport.deliver(turnStart('input-b', 'msg-b'));
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'second', assistantResponse: '', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.transport.deliver(turnStart('input-a', 'msg-a'));
    await h.transport.observe(chunks([{ type: 'start' }]), { index: 0 });

    const streamed = h.broadcasts.filter((b) => b.frame.type === 'cf_agent_use_chat_response' && b.frame.done === false).map((b) => b.frame.id);
    expect(streamed).not.toContain('req-1');
  });

  test('a send that faults underneath the loop still closes the request, once, as a failure, and propagates', async () => {
    const h = harness({ refuse: 'the send ledger is unreadable', fault: true });
    const conn = h.connection('c1');

    await expect(h.transport.onMessage(conn, chatRequest('req-1', 'hello'))).rejects.toThrow('the loop failed to take a client message');
    // Without the frame the sending tab waits on a turn-end that never comes.
    expect(h.responses()).toHaveLength(1);
    expect(h.responses()[0]).toMatchObject({ id: 'req-1', done: true, error: true });
    expect(h.responses()[0]?.landed).toBeUndefined();
  });

  test('a history read that fails during admission closes the request too', async () => {
    const h = harness('turn', () => Promise.reject(new Error('the transcript is unreadable')));
    const conn = h.connection('c1');

    await expect(h.transport.onMessage(conn, chatRequest('req-1', 'hello'))).rejects.toThrow('the loop failed to take a client message');
    expect(h.responses()).toHaveLength(1);
    expect(h.responses()[0]).toMatchObject({ id: 'req-1', done: true, error: true });
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

  test("a turn's chunks are broadcast under its request and accumulate into the answer", async () => {
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
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'hello', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);

    expect(h.responses().at(-1)).toEqual({ type: 'cf_agent_use_chat_response', id: 'req-1', body: '', done: true });
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

    // 2026-09-27: `sdk-minted-2` reached the tab, whose SDK chat drew the answer twice.
    const sse = h.responses().flatMap((frame) => frame.body === undefined || frame.body === '' ? [] : [`data: ${frame.body}\n\n`]).join('');

    const tab = new Chat<UIMessage>({ transport: new DefaultChatTransport({
      fetch: Object.assign(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } }), { preconnect: fetch.preconnect }),
    }) });

    await tab.sendMessage({ text: 'hello' });
    const assistant = tab.messages.filter((message) => message.role === 'assistant');
    expect(assistant.map((message) => message.id)).toEqual(['msg-1']);
    expect(assistant[0]?.parts.flatMap((part) => part.type === 'text' ? [part.text] : [])).toEqual(['first half', ' and the rest']);
  });

  test('a reconnecting client is told what is resuming and gets the stored chunks replayed', async () => {
    const h = openRequest();
    const first = h.connection('c1');
    const { answered } = await h.open(first, 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'par' }]), { index: 0 });

    const second = h.connection('c2');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.onConnect(second);
    expect(JSON.parse(h.connectionFrames('c2')[0] ?? '{}')).toEqual({ type: 'cf_agent_stream_resuming', id: 'req-1', turnId: 'input-req-1' });
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

  // A joining tab's replay restates from the ledger each step it records whose last chunk went out, then the relay's
  // chunks after them: the loop records a step beside the stream, so either can be ahead.
  test('a joining tab hears a step the ledger records and the relay sent whole restated, then the relay\'s chunks after it', async () => {
    const h = openRequest();
    const { answered } = await h.open(h.connection('c1'), 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, ...STEP_ONE, { type: 'start-step' }, { type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'tw' }]), { index: 0 });
    h.recorded.push([{ type: 'text', text: 'one', state: 'done' }]);

    const joining = h.connection('c2');
    await h.transport.onConnect(joining);
    await h.transport.onMessage(joining, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'req-1' }));

    expect(replayOf(h.connectionFrames('c2'))).toEqual([
      'start', 'R start-step', 'R text-start', 'R text-delta one', 'R text-end', 'R finish-step', 'start-step', 'text-start', 'text-delta tw', 'complete',
    ]);
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'one', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
  });

  test('a step the relay sent whole that the ledger has not recorded is replayed from the relay', async () => {
    const h = openRequest();
    const { answered } = await h.open(h.connection('c1'), 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, ...STEP_ONE]), { index: 0 });

    const joining = h.connection('c2');
    await h.transport.onConnect(joining);
    await h.transport.onMessage(joining, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'req-1' }));

    expect(replayOf(h.connectionFrames('c2'))).toEqual(['start', 'start-step', 'text-start', 'text-delta one', 'text-end', 'finish-step', 'complete']);
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'one', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
  });

  test('a step the ledger records before its last chunk went out is replayed from the relay, and the rest follows live', async () => {
    const h = openRequest();
    const { answered } = await h.open(h.connection('c1'), 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, ...STEP_ONE.slice(0, 3)]), { index: 0 });
    h.recorded.push([{ type: 'text', text: 'one', state: 'done' }]);

    const joining = h.connection('c2');
    await h.transport.onConnect(joining);
    await h.transport.onMessage(joining, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'req-1' }));
    await h.transport.observe(chunks(STEP_ONE.slice(3)), { index: 0 });

    const heard = h.received('c2').map((text) => v.parse(FrameSchema, JSON.parse(text)))
      .filter((frame) => frame.type === 'cf_agent_use_chat_response' && frame.body !== undefined && frame.body !== '')
      .map((frame) => `${frame.replay === true ? 'replay ' : ''}${v.parse(v.looseObject({ type: v.string() }), JSON.parse(frame.body ?? '')).type}`);

    expect(heard).toEqual(['replay start', 'replay start-step', 'replay text-start', 'replay text-delta', 'text-end', 'finish-step']);
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: 'one', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
  });

  test('a re-opened turn\'s replay restates the steps finished before this activation ahead of the relay\'s', async () => {
    const h = harness();
    const first = h.connection('c1');
    await h.transport.onMessage(first, chatRequest('req-1', 'hello'));
    const revived = h.afterEviction();
    h.recorded.push(
      [{ type: 'tool-shell', toolCallId: 'call_0', state: 'output-available', input: { command: 'echo 1' }, output: '1' }],
      [{ type: 'tool-shell', toolCallId: 'call_1', state: 'output-error', input: { command: 'false' }, errorText: 'exit 1' }],
    );

    const joining = h.connection('c2');
    await revived.onConnect(joining);
    await revived.deliver(turnStart('input-req-1', 'msg-1', [], 2));
    await revived.observe(chunks([{ type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't2' }, { type: 'text-delta', id: 't2', delta: 'three' }]), { index: 0 });
    const resuming = v.parse(FrameSchema, JSON.parse(h.connectionFrames('c2').find((text) => text.includes('cf_agent_stream_resuming')) ?? '{}'));
    await revived.onMessage(joining, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: resuming.id }));

    expect(replayOf(h.connectionFrames('c2'))).toEqual([
      'start', 'R start-step', 'R tool-input-available call_0', 'R tool-output-available call_0', 'R finish-step',
      'R start-step', 'R tool-input-available call_1', 'R tool-output-error call_1', 'R finish-step',
      'start-step', 'text-start', 'text-delta three', 'complete',
    ]);
  });

  /** Owner report 2026-09-26, "reasoning-delta for missing reasoning part": the tab's reader throws on a delta whose
   *  part it never saw open, so every part a joining tab continues must open in what it reads, before its deltas. */
  // 2026-09-26 (two-turn.test.ts red): a done frame for another request is never stored, so the replay on ack
  // cannot carry it; skipped for a joining tab, it was lost, and that tab's send waited on it for good.
  // 2026-09-26 (chat-session-parity red): a tab that connects after an eviction was told to resume the stream the
  // evicted turn left active; the resumed turn opened a new stream and the tab, pending for the old one, missed it.
  // 2026-09-30 (F2, staging a4e564ce1): told nothing resumes, a tab had no partial to read (the transcript holds an
  // answer from its commit), and the re-drive streamed under an id no client held, so the eval client never heard it.
  test('a tab that connects after an eviction waits on the owed turn, then follows its re-drive by the turn\'s id', async () => {
    const h = harness();
    const first = h.connection('c1');
    await h.transport.onMessage(first, chatRequest('req-1', 'hello'));
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'text-start', id: 'text-0' }]), { index: 0 });

    const revived = h.afterEviction();
    const second = h.connection('c2');
    await revived.onConnect(second);
    await revived.onMessage(second, JSON.stringify({ type: 'cf_agent_stream_resume_request', probeId: 'p-1' }));
    await revived.deliver(turnStart('input-req-1', 'msg-1'));
    const told = h.connectionFrames('c2').map((frame) => v.parse(FrameSchema, JSON.parse(frame)));
    const resuming = told.at(-1);

    expect(told.map((frame) => frame.type))
      .toEqual(['cf_agent_stream_pending', 'cf_agent_chat_messages', 'cf_agent_stream_pending', 'cf_agent_stream_resuming']);
    expect(resuming).toMatchObject({ turnId: 'input-req-1', probeId: 'p-1' });

    await revived.onMessage(second, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: resuming?.id }));
    await revived.observe(chunks([{ type: 'start' }, { type: 'text-start', id: 'text-0' }, { type: 'text-delta', id: 'text-0', delta: 'resumed' }]), { index: 0 });

    const bodies = h.received('c2').map((text) => v.parse(FrameSchema, JSON.parse(text)))
      .filter((frame) => frame.type === 'cf_agent_use_chat_response' && frame.id === resuming?.id && frame.body !== undefined && frame.body !== '')
      .map((frame) => v.parse(v.looseObject({ type: v.string() }), JSON.parse(frame.body ?? '')).type);

    expect(bodies).toEqual(['start', 'text-start', 'text-delta']);
  });

  test('a tab waiting on an owed turn hears nothing resumes when the loop goes quiet without opening it', async () => {
    const h = harness();
    const revived = h.afterEviction();
    const tab = h.connection('c1');
    await revived.onMessage(tab, JSON.stringify({ type: 'cf_agent_stream_resume_request', probeId: 'p-1' }));
    revived.quiet();

    expect(h.connectionFrames('c1').map((frame) => JSON.parse(frame))).toEqual([
      { type: 'cf_agent_stream_pending', probeId: 'p-1' },
      { type: 'cf_agent_stream_resume_none', reason: 'idle', probeId: 'p-1' },
    ]);
  });

  test('a tab still in its handshake that sends a message spliced into the live turn hears its landing', async () => {
    const h = harness(['turn', 'mid-turn']);
    const first = h.connection('c1');
    await h.transport.onMessage(first, chatRequest('req-1', 'hello'));
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'text-start', id: 'text-0' }]), { index: 0 });

    const second = h.connection('c2');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.onConnect(second);
    await h.transport.onMessage(second, chatRequest('req-2', 'and also this'));

    const landings = h.received('c2').map((text) => v.parse(FrameSchema, JSON.parse(text)))
      .filter((frame) => frame.type === 'cf_agent_use_chat_response' && frame.id === 'req-2' && frame.done === true);

    expect(landings).toHaveLength(1);
    expect(landings[0]?.landed).toBe('mid-turn');
  });

  test('a tab joining mid-reasoning reads each part opened before its deltas, live chunks included', async () => {
    const h = openRequest();
    const first = h.connection('c1');
    const { answered } = await h.open(first, 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'reasoning-start', id: 'reasoning-0' }, { type: 'reasoning-delta', id: 'reasoning-0', delta: 'weigh' }]), { index: 0 });

    const second = h.connection('c2');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.onConnect(second);
    // The reasoning goes on before the joining tab's acknowledgement lands.
    await h.transport.observe(chunks([{ type: 'reasoning-delta', id: 'reasoning-0', delta: 'ing it' }]), { index: 1 });
    await h.transport.onMessage(second, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'req-1' }));
    await h.transport.observe(chunks([{ type: 'reasoning-end', id: 'reasoning-0' }]), { index: 2 });

    const opened = new Set<string>();
    const orphans: string[] = [];
    let thought = '';

    for (const text of h.received('c2')) {
      const frame = v.parse(FrameSchema, JSON.parse(text));

      if (frame.type !== 'cf_agent_use_chat_response' || frame.id !== 'req-1' || !frame.body) continue;
      const chunk = v.parse(v.looseObject({ type: v.string(), id: v.optional(v.string()), delta: v.optional(v.string()) }), JSON.parse(frame.body));

      if (chunk.type === 'reasoning-delta' && chunk.id === 'reasoning-0') thought += chunk.delta ?? '';

      if (chunk.type.endsWith('-start') && chunk.id !== undefined) opened.add(chunk.id);
      else if ((chunk.type.endsWith('-delta') || chunk.type.endsWith('-end')) && chunk.id !== undefined && !opened.has(chunk.id)) orphans.push(chunk.type);
    }

    expect(orphans).toEqual([]);
    expect(opened.has('reasoning-0')).toBe(true);
    // Every frame of the thought, once: a replay that dropped or repeated one reads wrong.
    expect(thought).toBe('weighing it');
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: '', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' } });
    await h.land(answered);
  });

  // Review job 169: on a failure the joining tab's resume names the failing stream itself, so a synthetic done
  // there settled it before the turn's own terminal frame, without the error.
  test('a tab joining a turn that then fails hears one terminal frame, the one carrying the error', async () => {
    const h = openRequest();
    const first = h.connection('c1');
    const { answered } = await h.open(first, 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }]), { index: 0 });

    const second = h.connection('c2');
    h.history.push({ id: 'input-req-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await h.transport.onConnect(second);
    await h.transport.deliver({ type: 'error', message: 'the provider refused the request' });
    await h.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: '', toolCalls: [], steps: 0, durationMs: 0, feedback: null, hadError: true, origin: 'user' } });
    await h.land(answered);

    const terminal = h.received('c2').map((text) => v.parse(FrameSchema, JSON.parse(text)))
      .filter((frame) => frame.type === 'cf_agent_use_chat_response' && frame.id === 'req-1' && frame.done === true);

    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.error).toBe(true);
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
    await failed.transport.observe(chunks([{ type: 'start' }, { type: 'error', errorText: 'AI_APICallError (HTTP 400)' }]), { index: 0 });
    await failed.transport.deliver({ type: 'error', message: 'the provider refused the request' });
    await failed.transport.deliver({ type: 'turn-end', turn: { userMessage: 'hello', assistantResponse: '', toolCalls: [], steps: 0, durationMs: 0, feedback: null, hadError: true, origin: 'user' } });
    await failed.land(failing.answered);

    // The sender's chat keeps the first error its stream carries and a watching tab only a terminal one, so the
    // provider's own words never reach a tab: the classified reason is the one error, and it ends the turn.
    const errors = failed.responses().filter((frame) => frame.error === true || frame.body?.includes('"type":"error"') === true);
    expect(errors).toEqual([{ type: 'cf_agent_use_chat_response', id: 'req-2', body: 'the provider refused the request', done: true, error: true }]);
    expect(failed.responses().at(-1)).toEqual(errors[0]);
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

const turnEnd = (text: string): SessionEvent => ({
  type: 'turn-end', turn: { userMessage: text, assistantResponse: '', toolCalls: [], steps: 1, durationMs: 0, feedback: null, hadError: false, origin: 'user' },
});

/** A model stream the test feeds while the turn runs, so a tab can reconnect in the middle of it. A push settles
 *  when the relay asks for the chunk after its last one: it has handled every chunk the push carried. */
function liveChunks() {
  const queued: UIMessageChunk[] = [];
  let ended = false;
  let arrived = Promise.withResolvers<void>();
  let consumed: ReturnType<typeof Promise.withResolvers<void>> | null = null;

  const stream = new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      while (queued.length === 0 && !ended) {
        consumed?.resolve();
        arrived = Promise.withResolvers<void>();
        await arrived.promise;
      }

      const next = queued.shift();

      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  }, { highWaterMark: 0 });

  const push = async (...parts: UIMessageChunk[]): Promise<void> => {
    queued.push(...parts);
    consumed = Promise.withResolvers<void>();
    arrived.resolve();
    await consumed.promise;
  };

  return { stream, push, end: () => { ended = true; arrived.resolve(); } };
}

/** What a tab's reader builds from the answer frames it was sent, in order, as `useAgentChat` feeds them to `ai`. */
async function readAnswer(frames: readonly string[], requestId: string): Promise<UIMessage | undefined> {
  const bodies = frames.map((text) => v.parse(FrameSchema, JSON.parse(text)))
    .filter((frame) => frame.type === 'cf_agent_use_chat_response' && frame.id === requestId && frame.body !== undefined && frame.body !== '')
    .map((frame) => v.parse(v.custom<UIMessageChunk>((value) => v.is(v.looseObject({ type: v.string() }), value)), JSON.parse(frame.body ?? '')));

  let last: UIMessage | undefined;

  for await (const message of readUIMessageStream({ stream: chunks(bodies), onError: (error) => { throw error; } })) last = message;

  return last;
}

describe('a tab that reconnects mid-turn', () => {
  test('stores nothing durable to resume from: the answer\'s one durable copy is the loop\'s', async () => {
    const h = openRequest();
    const { answered } = await h.open(h.connection('c1'), 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'text-start', id: 't' },
      ...Array.from({ length: 30 }, (_unused, index): UIMessageChunk => ({ type: 'text-delta', id: 't', delta: `w${String(index)} ` }))]), { index: 0 });

    const sdkTables = h.db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'cf_agents_stream%' OR name = 'cf_agents_chat_progress' OR name LIKE 'cf_ai_chat_stream%')").all();

    expect(sdkTables).toEqual([]);
    await h.transport.deliver(turnEnd('hello'));
    await h.land(answered);
  });

  test('reads the replay and then the live deltas, whole and once, from inside a flush window', async () => {
    const h = openRequest();
    const { answered } = await h.open(h.connection('c1'), 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    const live = liveChunks();
    const observed = h.transport.observe(live.stream, { index: 0 });
    const words = Array.from({ length: 25 }, (_unused, index) => `w${String(index)} `);
    // 13 deltas: ten reach a flush point, three sit in the cadence window when the tab comes back.
    await live.push({ type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't' },
      ...words.slice(0, 13).map((delta): UIMessageChunk => ({ type: 'text-delta', id: 't', delta })));

    const second = h.connection('c2');
    await h.transport.onConnect(second);
    // Streamed between the tab being told and its ack: in its replay, never also live.
    await live.push(...words.slice(13, 16).map((delta): UIMessageChunk => ({ type: 'text-delta', id: 't', delta })));
    await h.transport.onMessage(second, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'req-1' }));
    await live.push(...words.slice(16).map((delta): UIMessageChunk => ({ type: 'text-delta', id: 't', delta })),
      { type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish' });
    live.end();
    await observed;

    const answer = await readAnswer(h.received('c2'), 'req-1');
    expect(answer?.id).toBe('msg-1');
    expect(answer?.parts.flatMap((part) => part.type === 'text' ? [part.text] : [])).toEqual([words.join('')]);
    await h.transport.deliver(turnEnd('hello'));
    await h.land(answered);
  });

  test('reads a tool call still streaming its input, then its live input, with no part it never saw open', async () => {
    const h = openRequest();
    const { answered } = await h.open(h.connection('c1'), 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    const live = liveChunks();
    const observed = h.transport.observe(live.stream, { index: 0 });
    await live.push({ type: 'start' }, { type: 'start-step' },
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'write' },
      { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: '{"path":"a.t' });

    const second = h.connection('c2');
    await h.transport.onConnect(second);
    await h.transport.onMessage(second, JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'req-1' }));
    await live.push({ type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: 'xt"}' },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'write', input: { path: 'a.txt' } },
      { type: 'finish-step' }, { type: 'finish' });
    live.end();
    await observed;

    const answer = await readAnswer(h.received('c2'), 'req-1');
    expect(answer?.parts.filter((part) => part.type === 'tool-write')).toMatchObject([{ toolCallId: 'call-1', state: 'input-available', input: { path: 'a.txt' } }]);
    await h.transport.deliver(turnEnd('hello'));
    await h.land(answered);
  });

  test.each([['ends', false], ['is stopped', true]] as const)('once the turn %s, nothing is held to replay: a tab that asks hears nothing is resuming', async (_how, stopped) => {
    const h = openRequest();
    const { answered } = await h.open(h.connection('c1'), 'req-1', 'hello');
    await h.transport.deliver(turnStart('input-req-1', 'msg-1'));
    await h.transport.observe(chunks([{ type: 'start' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'par' }]), { index: 0 });

    if (stopped) await h.transport.deliver({ type: 'error', message: INTERRUPTED_TURN });
    await h.transport.deliver(turnEnd('hello'));
    await h.land(answered);

    const late = h.connection('c2');
    await h.transport.onMessage(late, JSON.stringify({ type: 'cf_agent_stream_resume_request', probeId: 'p-1' }));
    expect(h.connectionFrames('c2').map((frame) => JSON.parse(frame))).toContainEqual({ type: 'cf_agent_stream_resume_none', reason: 'idle', probeId: 'p-1' });
  });
});
