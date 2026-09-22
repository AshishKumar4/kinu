import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { createTestRuntime } from '@kinu.run/test-utils';
import { SessionHistory } from '../src/session/history';
import { ActorClaimStore, initActorClaimTables } from '../src/orchestrator/actor-claims';
import { SessionStream } from '../src/orchestrator/session-stream';
import type { ActorProgramIdentity } from '../src/orchestrator/actor-claims';
import { KinuError } from '../src/obs/error';

const BUILTIN: ActorProgramIdentity = { kind: 'builtin', version: 0, digest: null, build: 'test' };

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

test('a step cancelled while reasoning seals what it streamed, buffered tail included', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'reasoning-start', id: 'r' });

    for (const word of ['thinking ', 'hard ', 'about it']) await stream.nativePart({ type: 'reasoning-delta', id: 'r', text: word });
    await stream.nativeStep([]);
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
    await stream.nativeStep([final]);
    const after = s.selected();
    expect(after.revision).toBe(before.revision + 1);
    expect(s.open()).toEqual([]);
    expect((await s.history.materialize()).messages.at(-1)).toEqual(final);
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

    await Promise.all([stream.nativeStep([final]), stream.settle()]);
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

    await stream.nativeStep([{ role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] }]);
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
    await stream.nativeStep([{ role: 'assistant', content: [{ type: 'text', text: 'live and done' }] }]);
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
    // Nothing durable yet under 64 deltas.
    const [open] = s.open();

    if (open === undefined) throw new Error('the answer is open');
    // A new admission of the same turn supersedes its epoch.
    await s.turn('t1');
    expect(s.open()).toEqual([]);
    expect(s.history.context.entries(s.selected()).some(entry => entry.messageId === open)).toBe(true);
  } finally { s.testSql.close(); }
});

test('a window never splits a surrogate pair across two statements', async () => {
  const s = setup();

  try {
    const { stream } = await s.turn('t1');
    await stream.nativePart({ type: 'text-start', id: '0' });

    // The next 63 plus the high surrogate fill one window; the surrogate is held back.
    for (let i = 0; i < 64; i++) await stream.nativePart({ type: 'text-delta', id: '0', text: 'a' });
    await stream.nativePart({ type: 'text-delta', id: '0', text: '\ud83d' });
    expect(s.rows()).toEqual(['a'.repeat(64)]);
    await stream.nativePart({ type: 'text-delta', id: '0', text: '\ude00' });
    await stream.nativePart({ type: 'text-end', id: '0' });
    expect(s.rows()).toEqual([`${'a'.repeat(64)}😀`]);
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
    await stream.nativeStep([{ role: 'assistant', content: [{ type: 'text', text: 'the answer' }] }]);

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
    await stream.nativeStep([{ role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: '/x' } },
      { type: 'text', text: 'calling now' },
    ] }]);

    expect(s.open()).toEqual([]);
    expect((await s.history.materialize()).messages.at(-1)).toEqual({ role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: '/x' } },
      { type: 'text', text: 'calling now' },
    ] });
  } finally { s.testSql.close(); }
});
