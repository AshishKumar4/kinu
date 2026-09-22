import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime } from '@kinu.run/test-utils';
import { initSessionContextTables } from '../src/session/schema';
import { SessionMessages, type MessageReference } from '../src/session/messages';
import { SessionPayloads } from '../src/session/payload';
import { SessionContext } from '../src/session/context';
import { PreparedMessageUpdate } from '../src/session/updates';
import { SessionProposals } from '../src/session/proposals';
import { SessionTranscript, readSessionTranscript } from '../src/session/transcript';
import { SessionHistory } from '../src/session/history';
import { initSessionTranscriptTables } from '../src/session/transcript-schema';
import { getChatHistoryPage } from '../src/read-models/status';
import { answersForDrainTurns } from '../src/identity/conversation-store';
import { KinuError } from '../src/obs/error';

function setup() {
  const { rt, testSql } = createTestRuntime();
  initSessionContextTables(rt.storage.execRaw);
  const payloads = new SessionPayloads(async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor' }));
  const messages = new SessionMessages(rt.storage.sql, rt.actor, payloads);
  const context = new SessionContext(rt.storage.sql, rt.actor, write => rt.storage.transactionSync(write));

  return { rt, testSql, payloads, messages, context };
}

test('message publication rolls back with its membership and can be retried', async () => {
  const s = setup();

  try {
    const selected = s.context.initialize();
    const prepared = await s.messages.prepare({ role: 'user', content: 'hello' }, 'input');
    expect(() => s.context.commit(selected, 'input', 'turn', () => {
      s.messages.insert(prepared, 'input');
      throw new Error('crash before membership');
    }, () => s.rt.actor.assertCurrent())).toThrow('crash before membership');
    expect(s.context.entries(selected)).toEqual([]);
    const committed = s.context.commit(selected, 'input', 'turn', () => [{ ...s.messages.insert(prepared, 'input'), entryId: 'input', position: 0 }], () => s.rt.actor.assertCurrent());
    expect(await s.messages.materialize(s.context.entries(committed)[0])).toEqual({ role: 'user', content: 'hello' });
  } finally { s.testSql.close(); }
});

test('stream cutoffs retain partial text while final replacement and late metadata advance selection', async () => {
  const s = setup();

  try {
    const prepared = await s.messages.prepare({ role: 'assistant', content: [{ type: 'text', text: '\ud83d' }] }, 'answer');
    let selected = s.context.initialize();
    selected = s.context.commit(selected, 'output', 'turn', () => [{ ...s.messages.insert(prepared, 'output'), entryId: 'answer', position: 0 }], () => s.rt.actor.assertCurrent());
    const first = s.context.entries(selected)[0];
    const suffix = await PreparedMessageUpdate.prepare({ operation: 'append', part: 0, value: '\ude00' }, s.payloads);
    selected = s.context.commit(selected, 'output', 'turn', entries => [{ ...s.messages.append('answer', first.sequence, [suffix]), entryId: 'answer', position: entries[0].position }], () => s.rt.actor.assertCurrent());
    const second = s.context.entries(selected)[0];
    expect(await s.messages.materialize(first)).toEqual({ role: 'assistant', content: [{ type: 'text', text: '\ud83d' }] });
    expect(await s.messages.materialize(second)).toEqual({ role: 'assistant', content: [{ type: 'text', text: '😀' }] });

    const updates = await Promise.all([
      PreparedMessageUpdate.prepare({ part: 0, operation: 'content-end' }, s.payloads),
      PreparedMessageUpdate.prepare({ part: 0, operation: 'replace-content', value: 'final' }, s.payloads),
      PreparedMessageUpdate.prepare({ part: null, operation: 'envelope-metadata', value: { providerOptions: { test: { late: true } } } }, s.payloads),
    ]);

    selected = s.context.commit(selected, 'output', 'turn', () => [{ ...s.messages.append('answer', second.sequence, updates), entryId: 'answer', position: 0 }], () => s.rt.actor.assertCurrent());
    expect(await s.messages.materialize(s.context.entries(selected)[0])).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'final' }], providerOptions: { test: { late: true } } });
    expect(await s.messages.materialize(second)).toEqual({ role: 'assistant', content: [{ type: 'text', text: '😀' }] });
  } finally { s.testSql.close(); }
});

test('a sealed message is projected once at its seal and read as one row after', async () => {
  // Every step of every turn materializes every message in its context. A
  // streamed answer is one row per delta, so without the projection each
  // step re-joined every delta of every past answer (D23). The rows stay the
  // truth: the projection is derived from them, and only for the sealed
  // cutoff — an open message still grows, and an earlier cutoff is history.
  const s = setup();

  try {
    const prepared = await s.messages.prepare({ role: 'assistant', content: [{ type: 'text', text: 'a' }] }, 'answer');
    let selected = s.context.initialize();
    selected = s.context.commit(selected, 'output', 'turn', () => [{ ...s.messages.insert(prepared, 'output'), entryId: 'answer', position: 0 }], () => s.rt.actor.assertCurrent());
    const opened = s.context.entries(selected)[0];
    const projections = () => s.testSql.db.query<{ n: number }, []>('SELECT count(*) AS n FROM message_projections').get()!.n;

    // Open: read from its rows, projected by nobody.
    expect(await s.messages.materialize(opened)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'a' }] });
    expect(projections()).toBe(0);

    let reference: MessageReference = opened;

    for (const piece of ['b', 'c', 'd']) {
      const suffix = await PreparedMessageUpdate.prepare({ operation: 'append', part: 0, value: piece }, s.payloads);
      reference = s.messages.append('answer', reference.sequence, [suffix]);
    }

    const ended = await PreparedMessageUpdate.prepare({ part: 0, operation: 'content-end' }, s.payloads);
    reference = s.messages.append('answer', reference.sequence, [ended]);
    s.messages.seal(reference);

    // Sealed: the first read joins the rows and stores the projection; the
    // second reads the projection alone — proven by changing a delta row
    // underneath it and reading the same answer.
    expect(await s.messages.materialize(reference)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'abcd' }] });
    expect(projections()).toBe(1);
    s.testSql.db.run('UPDATE message_updates SET payload_json = \'"X"\' WHERE operation = \'append\' AND payload_json = \'"b"\'');
    expect(await s.messages.materialize(reference)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'abcd' }] });
    // An earlier cutoff of the same message is history: read from its rows
    // as they are now, and never projected.
    expect(await s.messages.materialize({ ...opened, sequence: opened.sequence + 1 })).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'aX' }] });
    expect(projections()).toBe(1);
  } finally { s.testSql.close(); }
});

test('pruning and branching preserve historical selection without resurrecting removed output', async () => {
  const s = setup();

  try {
    const prepared = await s.messages.prepare({ role: 'assistant', content: 'recorded' }, 'answer');
    const initial = s.context.initialize();
    const original = s.context.commit(initial, 'output', 'turn', () => [{ ...s.messages.insert(prepared, 'output'), entryId: 'answer', position: 0 }], () => s.rt.actor.assertCurrent());
    const fork = s.context.fork(original);
    const pruned = s.context.commit(original, 'context_transform', 'turn', () => [], () => s.rt.actor.assertCurrent());
    expect(s.context.entries(pruned)).toEqual([]);
    expect(s.context.entries(original)).toEqual(s.context.entries(fork));
    s.context.select(pruned, fork, () => {});
    expect(s.context.selected()).toEqual(fork);
  } finally { s.testSql.close(); }
});

test('reverting a context selects an isolated branch that survives reader reconstruction', async () => {
  const s = setup();

  try {
    const assertOwner = () => s.rt.actor.assertCurrent();
    const input = await s.messages.prepare({ role: 'user', content: 'initial instruction' }, 'input');
    const initial = s.context.initialize();
    const original = s.context.commit(initial, 'input', 'turn', () => [{ ...s.messages.insert(input, 'input'), entryId: 'input', position: 0 }], assertOwner);
    const summary = await s.messages.prepare({ role: 'user', content: 'compacted instruction' }, 'summary');
    const compacted = s.context.commit(original, 'context_transform', 'turn', () => [{ ...s.messages.insert(summary, 'context_transform'), entryId: 'summary', position: 0 }], assertOwner);
    const before = s.rt.storage.sql<{ total: number }>`SELECT COUNT(*) AS total FROM session_messages`[0]?.total;
    const restored = s.context.fork(original);
    s.context.select(compacted, restored, assertOwner);
    const reopened = new SessionContext(s.rt.storage.sql, s.rt.actor, write => s.rt.storage.transactionSync(write));
    expect(reopened.selected()).toEqual(restored);
    expect(reopened.entries(restored)).toEqual(s.context.entries(original));
    expect(s.rt.storage.sql<{ total: number }>`SELECT COUNT(*) AS total FROM session_messages`[0]?.total).toBe(before);

    const edited = await s.messages.prepare({ role: 'user', content: 'branch instruction' }, 'edit');
    const branch = reopened.commit(restored, 'edit', null, () => [{ ...s.messages.insert(edited, 'edit'), entryId: 'input', position: 0 }], assertOwner);
    const originalEntry = s.context.entries(original)[0];
    const compactedEntry = s.context.entries(compacted)[0];
    const branchEntry = reopened.entries(branch)[0];

    if (!originalEntry || !compactedEntry || !branchEntry) throw new Error('each context must retain its instruction');
    expect(await s.messages.materialize(originalEntry)).toEqual({ role: 'user', content: 'initial instruction' });
    expect(await s.messages.materialize(compactedEntry)).toEqual({ role: 'user', content: 'compacted instruction' });
    expect(await s.messages.materialize(branchEntry)).toEqual({ role: 'user', content: 'branch instruction' });
    expect(() => reopened.select(branch, compacted, () => { throw new Error('turn is active'); })).toThrow('turn is active');
    expect(reopened.selected()).toEqual(branch);
  } finally { s.testSql.close(); }
});

test('VFS-backed image payloads fail explicitly after file corruption', async () => {
  const s = setup();

  try {
    const image = await s.messages.prepare({ role: 'user', content: [{ type: 'image', image: new Uint8Array([0, 1, 255]) }] }, 'image');
    const selected = s.context.commit(s.context.initialize(), 'input', 'turn', () => [{ ...s.messages.insert(image, 'input'), entryId: 'image', position: 0 }], () => s.rt.actor.assertCurrent());
    const reference = s.context.entries(selected)[0];
    expect(await s.messages.materialize(reference)).toEqual({ role: 'user', content: [{ type: 'image', image: new Uint8Array([0, 1, 255]) }] });
    const stored = await s.messages.materializeParts(reference);
    const external = v.parse(v.object({ image: v.object({ $sessionAttachment: v.object({ path: v.string() }) }) }), stored[0]?.value);
    await s.rt.storage.vfs.writeFile(external.image.$sessionAttachment.path, 'corrupt');
    await expect(s.messages.materialize(reference)).rejects.toThrow('digest differs');
  } finally { s.testSql.close(); }
});

test('metadata cannot replace structure regardless of payload size', async () => {
  const s = setup();

  try {
    await expect(PreparedMessageUpdate.prepare({ operation: 'metadata', part: 0, value: { toolName: 'changed', padding: 'x'.repeat(1_100_000) } }, s.payloads)).rejects.toThrow('cannot change native part structure');
    await expect(PreparedMessageUpdate.prepare({ operation: 'envelope-metadata', part: null, value: { role: 'system' } }, s.payloads)).rejects.toThrow('cannot replace message structure');
    expect(() => s.context.entries({ contextId: 'missing', revision: 0 })).toThrow('revision does not exist');
  } finally { s.testSql.close(); }
});

test('foreign keys reject another actor selection and stale ownership publishes nothing', async () => {
  const s = setup();

  try {
    const selected = s.context.initialize();
    const prepared = await s.messages.prepare({ role: 'user', content: 'same' }, 'one');
    expect(() => s.context.commit(selected, 'input', 'turn', () => [{ ...s.messages.insert(prepared, 'input'), entryId: 'one', position: 0 }], () => { throw new Error('stale epoch'); })).toThrow('stale epoch');
    expect(s.context.entries(selected)).toEqual([]);
    expect(() => s.rt.storage.sql`INSERT INTO actor_context_selection(actor_id,context_id) VALUES(${'unknown-actor'},${selected.contextId})`).toThrow();
  } finally { s.testSql.close(); }
});

test('staged removal preserves an appended tail and rejects a changed target', async () => {
  const s = setup();

  try {
    const assertOwner = () => s.rt.actor.assertCurrent();
    const proposals = new SessionProposals(s.rt.storage.sql, s.rt.actor, s.context, write => s.rt.storage.transactionSync(write));
    const prepared = await s.messages.prepare({ role: 'user', content: 'old' }, 'old');
    const base = s.context.commit(s.context.initialize(), 'input', 'turn', () => [{ ...s.messages.insert(prepared, 'input'), entryId: 'old', position: 0 }], assertOwner);
    const old = s.context.entries(base)[0];
    proposals.stage({ id: 'remove', base, author: s.rt.actor.actorId, via: 'session', cause: 'context_transform', turnId: 'turn', changes: [{ entryId: old.entryId, expected: old, replacement: null }] });
    const tail = await s.messages.prepare({ role: 'assistant', content: 'new work' }, 'tail');
    s.context.commit(base, 'output', 'turn', entries => [...entries, { ...s.messages.insert(tail, 'output'), entryId: 'tail', position: 1 }], assertOwner);
    const applied = proposals.apply('remove', assertOwner, () => null);

    if (applied === null) throw new Error('unexpected deferred edit');
    expect(s.context.entries(applied).map(entry => entry.messageId)).toEqual(['tail']);
    expect(s.context.entries(base).map(entry => entry.messageId)).toEqual(['old']);
    expect(() => proposals.stage({ id: 'stale', base, author: s.rt.actor.actorId, via: 'session', cause: 'edit', turnId: null, changes: [] })).toThrow(KinuError);
    expect(proposals.pending(base.contextId)).toEqual([]);
  } finally { s.testSql.close(); }
});

test('read-only transcript authorization is checked again after payload access', async () => {
  const s = setup();

  try {
    initSessionTranscriptTables(s.rt.storage.execRaw);
    const text = 'retained text '.repeat(100_000);
    const prepared = await s.messages.prepare({ role: 'user', content: text }, 'input');
    const reference = s.messages.insert(prepared, 'input');
    const writer = new SessionTranscript(s.rt.storage.sql, s.rt.actor, 'default', s.messages, s.payloads, write => s.rt.storage.transactionSync(write), () => s.context.selected());
    writer.appendUser(await writer.prepareUser({ id: 'public-input', turnId: 'turn', message: reference }));
    let authorized = true;
    let revokeDuringRead = false;

    const reader = readSessionTranscript(s.rt.storage.sql, {
      actorId: s.rt.actor.actorId,
      assertCurrent() { s.rt.actor.assertCurrent();

 if (!authorized) throw new Error('read grant revoked'); },
    }, 'default', async () => {
      if (revokeDuringRead) authorized = false;

      return s.rt.storage.vfs;
    });

    expect(await reader.history()).toEqual([{ id: 'public-input', role: 'user', parts: [{ type: 'text', text }] }]);
    revokeDuringRead = true;
    await expect(reader.history()).rejects.toThrow('read grant revoked');
  } finally { s.testSql.close(); }
});

test('canonical transcript pages follow the head ancestry and stay session-scoped', async () => {
  const s = setup();

  try {
    initSessionTranscriptTables(s.rt.storage.execRaw);
    const writer = new SessionTranscript(s.rt.storage.sql, s.rt.actor, 'default', s.messages, s.payloads, write => s.rt.storage.transactionSync(write), () => s.context.selected());
    const other = new SessionTranscript(s.rt.storage.sql, s.rt.actor, 'mcts', s.messages, s.payloads, write => s.rt.storage.transactionSync(write), () => s.context.selected());

    for (const [id, transcript, parentId] of [['root', writer, null], ['left', writer, 'root'], ['foreign', other, null], ['right', writer, 'root']] as const) {
      const prepared = await s.messages.prepare({ role: 'user', content: id }, id);
      const reference = s.messages.insert(prepared, 'input');
      transcript.appendUser(await transcript.prepareUser({ id, parentId, turnId: id, message: reference }));
    }

    const first = await getChatHistoryPage(writer, { limit: 1 });
    expect(first.items.map(item => item.content)).toEqual(['right']);

    if (first.status !== 'more') throw new Error('expected another page');
    const last = await getChatHistoryPage(writer, { limit: 1, cursor: first.next });
    expect(last.items.map(item => item.content)).toEqual(['root']);
    expect(last.status).toBe('end');
    await expect(getChatHistoryPage(writer, { cursor: { after: 'foreign' } })).rejects.toThrow();
    expect(writer.count()).toBe(2);
    writer.setHead('left');
    expect((await getChatHistoryPage(writer, {})).items.map(item => item.content)).toEqual(['root', 'left']);
  } finally { s.testSql.close(); }
});

test('reverting to an entry continues from its parent on the context recorded there', async () => {
  const { rt, testSql } = createTestRuntime();

  try {
    initSessionContextTables(rt.storage.execRaw);
    initSessionTranscriptTables(rt.storage.execRaw);
    const history = new SessionHistory({ sql: rt.storage.sql, actor: rt.actor, transactionSync: write => rt.storage.transactionSync(write), files: async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor' }) });
    const assertOwner = () => rt.actor.assertCurrent();
    const chat = history.transcript('default');
    const turns: Array<[string, string, string]> = [['ask-1', 'answer-1', 'one'], ['ask-2', 'answer-2', 'two'], ['ask-3', 'answer-3', 'three']];

    for (const [ask, answer, text] of turns) {
      const input = await history.append({ id: ask, message: { role: 'user', content: text }, origin: 'input', turnId: ask, assertOwner });
      chat.record({ ...await chat.prepareUser({ id: ask, turnId: ask, message: input }), parentId: undefined });
      const output = await history.append({ id: answer, message: { role: 'assistant', content: `${text} answered` }, origin: 'output', turnId: ask, assertOwner });
      chat.appendAssistant(await chat.prepareAssistant({ id: answer, parentId: ask, turnId: ask, runId: ask, parts: [{ messageId: answer, partNo: 0, throughSequence: output.sequence }], finalText: null }));
    }

    const before = history.context.selected();

    if (before === null) throw new Error('a context is selected after three turns');
    const reverted = history.revertTo('default', 'ask-3', () => {});
    expect(reverted).not.toEqual(before);
    expect(history.context.selected()).toEqual(reverted);
    expect((await history.materialize()).messages.map(message => message.content)).toEqual(['one', 'one answered', 'two', 'two answered']);
    expect(chat.ancestry().map(entry => entry.id)).toEqual(['ask-1', 'answer-1', 'ask-2', 'answer-2']);
    expect(chat.read('ask-3')).not.toBeNull();

    const fourth = await history.append({ id: 'ask-4', message: { role: 'user', content: 'four' }, origin: 'input', turnId: 'ask-4', assertOwner });
    chat.record({ ...await chat.prepareUser({ id: 'ask-4', turnId: 'ask-4', message: fourth }), parentId: undefined });
    expect(chat.ancestry().map(entry => entry.id)).toEqual(['ask-1', 'answer-1', 'ask-2', 'answer-2', 'ask-4']);
    expect(history.revertTo('default', 'ask-1', () => {})).toMatchObject({ revision: 0 });
    expect((await history.materialize()).messages).toEqual([]);
    expect(chat.ancestry()).toEqual([]);
    expect(() => history.revertTo('default', 'ask-2', () => { throw new Error('turn is active'); })).toThrow('turn is active');
  } finally { testSql.close(); }
});

test('drain recovery returns the newest nonempty canonical answer across sibling replies', async () => {
  const s = setup();

  try {
    initSessionTranscriptTables(s.rt.storage.execRaw);
    const transcript = new SessionTranscript(s.rt.storage.sql, s.rt.actor, 'default', s.messages, s.payloads, write => s.rt.storage.transactionSync(write), () => s.context.selected());
    const input = s.messages.insert(await s.messages.prepare({ role: 'user', content: 'request' }, 'input'), 'input');
    transcript.appendUser(await transcript.prepareUser({ id: 'ask', turnId: 'turn', message: input, metadata: { drainTurnId: 'drain' } }));

    for (const [id, text] of [['older', 'old answer'], ['latest', 'latest answer'], ['empty', '  ']] as const) {
      const output = s.messages.insert(await s.messages.prepare({ role: 'assistant', content: text }, id), 'output');
      transcript.appendAssistant(await transcript.prepareAssistant({ id, parentId: 'ask', turnId: 'turn', runId: 'run', parts: [{ messageId: id, partNo: 0, throughSequence: output.sequence }], finalText: null }));
    }

    expect(await answersForDrainTurns(transcript, ['drain', 'unanswered'])).toEqual(new Map([['drain', 'latest answer']]));
  } finally { s.testSql.close(); }
});
