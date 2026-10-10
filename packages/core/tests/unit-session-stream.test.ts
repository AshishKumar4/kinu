import { expect, spyOn, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { createTestRuntime } from '@kinu.run/test-utils';
import { SessionHistory } from '../src/session/history';
import { ActorClaimStore, initActorClaimTables } from '../src/orchestrator/actor-claims';
import { SessionStream } from '../src/orchestrator/session-stream';
import type { ActorProgramIdentity } from '../src/orchestrator/actor-claims';
import { KinuError } from '../src/obs/error';
import { McpToolError } from '../src/tools/mcp-error';
import { initRunEventTables, RunEventRecorder } from '../src/events/recorder';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator';

const BUILTIN: ActorProgramIdentity = { kind: 'builtin', version: 0, digest: null, build: 'test' };

const remoteFailure = { isError: true, content: [{ type: 'text', text: 'remote failed' }], structuredContent: { reason: 'remote-code' } };

test('a sealed step stores canonical output references, not a second transcript body', async () => {
  const s = setup();

  try {
    initRunEventTables(s.rt.storage.execRaw);
    const events = new RunEventRecorder(s.rt.storage.sql, s.rt.actor);
    const acc = new TurnAccumulator({ onStepEvent: (step) => { events.emit('run-references', { type: 'step_finish', ...step }); } });
    const { stream } = await s.turn('references');
    const text = 'canonical-payload-only '.repeat(3000);
    const message: ModelMessage = { role: 'assistant', content: [{ type: 'text', text }] };
    const record = { messages: [message], toolResults: [], step: { stepIndex: 0, finishReason: 'stop' } };

    await stream.nativeStep(record, (parts) => acc.writeNative(record, parts));

    const payload = s.rt.storage.sql<{ payload: string }>`SELECT payload FROM run_events WHERE run_id = 'run-references' AND type = 'step_finish'`[0]?.payload;

    expect(payload).toBeDefined();
    expect(payload?.length).toBeLessThan(text.length / 10);
    expect(payload).not.toContain(text);

    const event = events.read('run-references')[0];

    if (event?.type !== 'step_finish') throw new Error('a sealed step emitted no reference event');

    expect(event.parts.length).toBe(1);
    expect(await s.history.messages.materialize({ messageId: event.parts[0].messageId })).toEqual(message);
  } finally { s.testSql.close(); }
});

test.each([
  { name: 'shell', error: new KinuError('io', 'command exited 7', { execution: { exitCode: 7 } }),
    output: { type: 'error-json', value: { reason: 'io', error: 'command exited 7', execution: { exitCode: 7 } } } },
  { name: 'eval', error: new McpToolError(remoteFailure), output: { type: 'error-json', value: remoteFailure } },
])('a cut $name failure keeps its machine-readable evidence in the resumed context', async ({ name, error, output }) => {
  const s = setup();

  try {
    const { stream } = await s.turn('failed');
    await stream.nativePart({ type: 'tool-call', toolCallId: 'failed-call', toolName: name, input: {} });
    await stream.nativePart({ type: 'tool-error', toolCallId: 'failed-call', toolName: name, input: {}, error });
    await stream.settle();

    const reopened = new SessionHistory({ sql: s.rt.storage.sql, actor: s.rt.actor,
      transactionSync: write => s.rt.storage.transactionSync(write), files: async () => ({ vfs: s.rt.storage.vfs, artifactDirectory: '/actor' }) });

    const messages = (await reopened.materialize()).messages.filter(message => message.role === 'tool');

    expect(messages).toEqual([{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'failed-call', toolName: name, output }] }]);
  } finally { s.testSql.close(); }
});

function setup() {
  const { rt, testSql } = createTestRuntime();
  initActorClaimTables(rt.storage.execRaw);
  const history = new SessionHistory({ sql: rt.storage.sql, actor: rt.actor, transactionSync: write => rt.storage.transactionSync(write), files: async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor' }) });
  const claims = new ActorClaimStore(rt.storage.sql, rt.actor, write => rt.storage.transactionSync(write), history);
  const selected = () => history.context.selected() ?? history.context.initialize();
  const open = () => testSql.db.query<{ message_id: string }, []>('SELECT message_id FROM session_messages WHERE sealed_at IS NULL').all().map(row => row.message_id);
  const rows = () => testSql.db.query<{ text: string }, []>('SELECT text FROM stream_parts ORDER BY part_no, segment').all().map(row => row.text);

  const turn = async (turnId: string) => {
    const claim = await claims.admit({ runId: `run-${turnId}`, turnId, workMode: 'build', program: BUILTIN, context: selected() });
    const stream = new SessionStream(history, turnId, claim.epoch);
    const consumed = await claims.consume(claim, { index: 0, messages: (await history.materialize()).messages });
    stream.beginRequest(consumed.requestId, 0);

    return { claim, stream };
  };

  return { rt, testSql, history, claims, selected, open, rows, turn };
}

test('an interrupted authored loop retains its producer-owned command failure metadata', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('authored-failure');
    await stream.observe({ type: 'tool-call', toolCallId: 'command', toolName: 'shell', args: {}, source: 'scaffold' });
    await stream.observe({ type: 'tool-result', toolCallId: 'command', toolName: 'shell',
      result: 'command exited 7', error: 'command exited 7', success: false, reason: 'io', execution: { exitCode: 7 }, source: 'scaffold' });
    await stream.settle();

    const reopened = new SessionHistory({ sql: s.rt.storage.sql, actor: s.rt.actor,
      transactionSync: write => s.rt.storage.transactionSync(write), files: async () => ({ vfs: s.rt.storage.vfs, artifactDirectory: '/actor' }) });

    expect((await reopened.materialize()).messages.filter(message => message.role === 'tool')).toEqual([
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'command', toolName: 'shell',
        output: { type: 'error-json', value: { reason: 'io', error: 'command exited 7', execution: { exitCode: 7 } } } }] },
    ]);
  } finally { s.testSql.close(); }
});

test('a step cancelled while reasoning seals what it streamed, buffered tail included', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'reasoning-start', id: 'r' });

    for (const word of ['thinking ', 'hard ', 'about it']) await stream.nativePart({ type: 'reasoning-delta', id: 'r', text: word });
    await stream.nativeStep({ messages: [], toolResults: [] });
    expect(s.open()).toEqual([]);
    const answer = (await s.history.materialize()).messages.find(message => message.role === 'assistant');
    expect(answer).toEqual({ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking hard about it' }] });
  } finally { s.testSql.close(); }
});

test('a streamed answer joins the working context only when it seals', async () => {
  // A revision names immutable content.
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    const before = s.selected();
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'partial' });
    expect(s.open()).toHaveLength(1);
    expect(s.history.context.entries(s.selected()).some(entry => entry.messageId === s.open()[0])).toBe(false);
    expect(s.selected()).toEqual(before);

    await stream.nativePart({ type: 'text-end', id: '0' });
    const final: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: 'partial' }] };
    await stream.nativeStep({ messages: [final], toolResults: [] });
    const after = s.selected();
    expect(after.revision).toBe(before.revision + 1);
    expect(s.open()).toEqual([]);
    expect((await s.history.materialize()).messages.at(-1)).toEqual(final);
  } finally { s.testSql.close(); }
});

test('the provider\'s compaction summary is kept with its mark, so the next request replays it as one', async () => {
  const s = setup();
  const mark = { anthropic: { type: 'compaction' } };

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0', providerMetadata: mark });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'Summary so far.' });
    await stream.nativePart({ type: 'text-end', id: '0' });
    const final: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: 'Summary so far.', providerOptions: mark }] };
    await stream.nativeStep({ messages: [final], toolResults: [] });

    expect((await s.history.materialize()).messages.at(-1)).toEqual(final);
  } finally { s.testSql.close(); }
});

test('a failed ledger write rolls back its step, and a committed step is published only after commit', async () => {
  const s = setup();

  try {
    initRunEventTables(s.rt.storage.execRaw);
    const events = new RunEventRecorder(s.rt.storage.sql, s.rt.actor);
    const { stream } = await s.turn('t1');
    const before = s.selected();
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'record me' });
    const final: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: 'record me' }] };
    const heard: { inTransaction: boolean; open: readonly string[] }[] = [];
    events.observe(() => { heard.push({ inTransaction: s.testSql.db.inTransaction, open: s.open() }); });
    const row = () => events.emitDeferred('run-t1', { type: 'step_finish', parts: [], stepIndex: 1, usage: { input: 7, output: 2 }, usd: 0.000003 });

    await expect(stream.nativeStep({ messages: [final], toolResults: [] }, () => {
      row();
      throw new KinuError('io', 'the ledger write failed');
    })).rejects.toThrow(KinuError);
    expect(events.read('run-t1')).toEqual([]);
    expect(s.selected()).toEqual(before);
    expect(heard).toEqual([]);

    await stream.nativeStep({ messages: [final], toolResults: [] }, () => row().publish);
    expect(heard).toEqual([{ inTransaction: false, open: [] }]);
    expect((await s.history.materialize()).messages.at(-1)).toEqual(final);
    expect(events.read('run-t1')).toEqual([expect.objectContaining({ type: 'step_finish', parts: [], stepIndex: 1, usage: { input: 7, output: 2 }, usd: 0.000003 })]);
  } finally { s.testSql.close(); }
});

test('settling an already sealed stream runs no SQL', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'done' });
    await stream.nativePart({ type: 'text-end', id: '0' });
    await stream.nativeStep({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }], toolResults: [] });
    const statements = spyOn(s.testSql.db, 'prepare');

    try {
      await stream.settle();
      expect(statements).toHaveBeenCalledTimes(0);
    } finally { statements.mockRestore(); }
  } finally { s.testSql.close(); }
});

test('recorders sharing a database publish distinct ordered rows without a stale cached index', () => {
  const s = setup();

  try {
    initRunEventTables(s.rt.storage.execRaw);
    const first = new RunEventRecorder(s.rt.storage.sql, s.rt.actor);
    const second = new RunEventRecorder(s.rt.storage.sql, s.rt.actor);
    const heard: number[] = [];
    first.observe((event) => { heard.push(event.eventIndex); });
    second.observe((event) => { heard.push(event.eventIndex); });
    first.emit('run-shared', { type: 'step_finish', parts: [], stepIndex: 1, usage: { input: 1, output: 1 } });
    second.emit('run-shared', { type: 'step_finish', parts: [], stepIndex: 2, usage: { input: 2, output: 2 } });
    first.emit('run-shared', { type: 'step_finish', parts: [], stepIndex: 3, usage: { input: 3, output: 3 } });

    expect(heard).toEqual([0, 1, 2]);
    expect(first.read('run-shared').map((event) => event.eventIndex)).toEqual([0, 1, 2]);
  } finally { s.testSql.close(); }
});

test('a late native finish after a terminal seal cannot duplicate the tool row', async () => {
  const s = setup();

  try {
    initRunEventTables(s.rt.storage.execRaw);
    const events = new RunEventRecorder(s.rt.storage.sql, s.rt.actor);
    const { stream } = await s.turn('t1');
    const input = { command: 'pwd' };
    await stream.nativePart({ type: 'tool-call', toolCallId: 'call-a', toolName: 'shell', input });
    await stream.nativePart({ type: 'tool-result', toolCallId: 'call-a', toolName: 'shell', input, output: 'home' });
    const tool = () => events.emitDeferred('run-t1', { type: 'tool_call_end', name: 'shell', toolCallId: 'call-a', outcome: { success: true } }).publish;
    await stream.nativeStep({ messages: [], toolResults: [] }, () => tool());
    await stream.settle();
    await stream.nativeStep({ messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-a', toolName: 'shell', input }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-a', toolName: 'shell', output: { type: 'text', value: 'home' } }] },
    ], toolResults: [] }, () => {
      const tools = tool();
      const finished = events.emitDeferred('run-t1', { type: 'step_finish', parts: [], stepIndex: 1, usage: { input: 5, output: 2 } }).publish;

      return () => { tools(); finished(); };
    });

    expect(events.read('run-t1').filter((event) => event.type === 'tool_call_end').map((event) => event.toolCallId)).toEqual(['call-a']);
  } finally { s.testSql.close(); }
});

test('a program following an unfinished native delegation retains both outputs and settles every part', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    const native = 'the native delegation stopped here '.repeat(12);
    const authored = 'the program continued';
    await stream.nativePart({ type: 'text-start', id: 'partial' });
    await stream.nativePart({ type: 'text-delta', id: 'partial', text: native });
    await stream.observe({ type: 'text-delta', delta: authored, source: 'scaffold' });
    // A program's own step finishes with no response messages, as the scaffold transform yields it.
    await stream.observe({ type: 'step-finish', stepIndex: 1, responseMessages: [], source: 'scaffold' });
    await stream.settle();
    const messages = (await s.history.materialize()).messages.filter((message) => message.role === 'assistant');

    expect(messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: native }] },
      { role: 'assistant', content: [{ type: 'text', text: authored }] },
    ]);
    expect(s.open()).toEqual([]);
  } finally { s.testSql.close(); }
});

test('a program can delegate to native inference and then retain its own text and tool step', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    const native: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: 'delegated answer' }] };
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'delegated answer' });
    await stream.nativeStep({ messages: [native], toolResults: [] });

    const own: ModelMessage = { role: 'assistant', content: [
      { type: 'text', text: 'program follow-up' },
      { type: 'tool-call', toolCallId: 'program-call', toolName: 'file', input: { path: '/note' } },
    ] };

    const result: ModelMessage = { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'program-call', toolName: 'file', output: { type: 'text', value: 'saved' } },
    ] };

    await stream.observe({ type: 'text-delta', delta: 'program follow-up' });
    await stream.observe({ type: 'tool-call', toolCallId: 'program-call', toolName: 'file', args: { path: '/note' } });
    await stream.observe({ type: 'tool-result', toolCallId: 'program-call', toolName: 'file', success: true, result: 'saved' });
    await stream.observe({ type: 'step-finish', stepIndex: 2, responseMessages: [native, own, result] });
    await stream.settle();

    expect((await s.history.materialize()).messages.slice(-3)).toEqual([native, own, result]);
  } finally { s.testSql.close(); }
});

test('a step finishing while the turn settles seals each container once', async () => {
  // The SDK pipeline and the failed turn loop settle the same containers concurrently.
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'partial answer' });
    await stream.nativePart({ type: 'text-end', id: '0' });
    const final: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] };

    await Promise.all([stream.nativeStep({ messages: [final], toolResults: [] }), stream.settle()]);
    expect(s.open()).toEqual([]);
    expect((await s.history.materialize()).messages.at(-1)).toEqual(final);
  } finally { s.testSql.close(); }
});

test('a step that finishes after the turn settled keeps the settled record', async () => {
  // The reverse race: a late final message neither re-seals nor throws the step away.
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'partial' });
    await stream.settle();
    expect(s.open()).toEqual([]);

    await stream.nativeStep({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] }], toolResults: [] });
    expect(s.open()).toEqual([]);
    expect((await s.history.materialize()).messages.at(-1))
      .toEqual({ role: 'assistant', content: [{ type: 'text', text: 'partial' }] });
  } finally { s.testSql.close(); }
});

test('an admission the store refuses seals nothing of a live stream', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'live ' });
    const stale = { ...s.selected(), revision: s.selected().revision + 7 };
    await expect(s.claims.admit({ runId: 'run-t2', turnId: 't2', workMode: 'build', program: BUILTIN, context: stale })).rejects.toThrow(KinuError);
    expect(s.open()).toHaveLength(1);
    await stream.nativePart({ type: 'text-end', id: '0' });
    await stream.nativeStep({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'live and done' }] }], toolResults: [] });
    expect((await s.history.materialize()).messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'live and done' }] });
  } finally { s.testSql.close(); }
});

test('a message a reset activation left open seals at the turn\'s next admission, as the cut answer', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'cut ' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'short' });
    // Nothing durable yet between cadence flushes.
    const [open] = s.open();

    if (open === undefined) throw new Error('the answer is open');
    // A new admission of the same turn supersedes its epoch.
    await s.turn('t1');
    expect(s.open()).toEqual([]);
    expect(s.history.context.entries(s.selected()).some(entry => entry.messageId === open)).toBe(true);
  } finally { s.testSql.close(); }
});

// 2026-09-28 (turn-sql): the claim check moved into the append's own statement; a superseded stream still writes nothing.
test('a stream whose claim moved on writes nothing at its next flush', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'kept' });
    s.testSql.db.run('UPDATE actor_turn_claims SET epoch = epoch + 1');

    for (let i = 0; i < 9; i++) await stream.nativePart({ type: 'text-delta', id: '0', text: 'late' });
    await expect(stream.nativePart({ type: 'text-delta', id: '0', text: 'late' })).rejects.toThrow('no longer current');
    expect(s.rows()).toEqual(['kept']);
  } finally { s.testSql.close(); }
});

test('a window never splits a surrogate pair across two statements', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0' });

    // The first delta opens the part; the flush ten deltas later falls on the high surrogate, which is held back.
    for (let i = 0; i < 10; i++) await stream.nativePart({ type: 'text-delta', id: '0', text: 'a' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: '\ud83d' });
    expect(s.rows()).toEqual(['a'.repeat(10)]);
    await stream.nativePart({ type: 'text-delta', id: '0', text: '\ude00' });
    await stream.nativePart({ type: 'text-end', id: '0' });
    expect(s.rows()).toEqual([`${'a'.repeat(10)}😀`]);
  } finally { s.testSql.close(); }
});

test('a reasoning part the final message omits is sealed from the stream that witnessed it', async () => {
  // Streamed thinking is evidence even when the settled message omits it.
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'reasoning-start', id: 'r' });
    await stream.nativePart({ type: 'reasoning-delta', id: 'r', text: 'weighing it up' });
    await stream.nativePart({ type: 'reasoning-end', id: 'r' });
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'the answer' });
    await stream.nativePart({ type: 'text-end', id: '0' });
    await stream.nativeStep({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'the answer' }] }], toolResults: [] });

    expect(s.open()).toEqual([]);
    const answer = (await s.history.materialize()).messages.at(-1);
    expect(answer).toEqual({ role: 'assistant', content: [
      { type: 'reasoning', text: 'weighing it up' },
      { type: 'text', text: 'the answer' },
    ] });
  } finally { s.testSql.close(); }
});

test('a final message that reorders what streamed seals in the final order, without throwing', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'calling now' });
    await stream.nativePart({ type: 'text-end', id: '0' });
    await stream.nativePart({ type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: '/x' } });
    await stream.nativeStep({ messages: [{ role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: '/x' } },
      { type: 'text', text: 'calling now' },
    ] }], toolResults: [] });

    expect(s.open()).toEqual([]);
    expect((await s.history.materialize()).messages.at(-1)).toEqual({ role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: '/x' } },
      { type: 'text', text: 'calling now' },
    ] });
  } finally { s.testSql.close(); }
});

test('a call is durable only once its part is in the record, and a slow write holds only the waiter', async () => {
  // DESIGN red 9: `execute` may start before the stream reaches the call; the claim waits, the stream does not.
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    const calls = () => s.testSql.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM stream_parts WHERE kind = 'tool-call'").get()?.n ?? 0;
    const seen: number[] = [];
    const waited = stream.durable('call-1').then(() => { seen.push(calls()); });

    // The earlier text part and the call arrive after the waiter; neither waits on it.
    await stream.nativePart({ type: 'text-start', id: '0' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: 'sending' });
    await stream.nativePart({ type: 'text-end', id: '0' });
    expect(seen).toEqual([]);

    await stream.nativePart({ type: 'tool-call', toolCallId: 'call-1', toolName: 'shell', input: { command: 'deploy' } });
    await waited;
    expect(seen).toEqual([1]);

    // A call asked for after its part landed is durable at once.
    await stream.durable('call-1');
  } finally { s.testSql.close(); }
});

test('a waiter for a call whose turn is aborted is released with the abort', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    const abort = new AbortController();
    const waited = stream.durable('call-never', abort.signal);

    abort.abort(new Error('stopped'));
    await expect(waited).rejects.toThrow('stopped');
  } finally { s.testSql.close(); }
});
