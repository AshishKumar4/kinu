import { expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime, present } from '@kinu.run/test-utils';
import { initSessionContextTables } from '../src/session/schema';
import { SessionMessages } from '../src/session/messages';
import { PLATFORM_CATALOG } from '../src/platform-catalog';
import { SessionPayloads } from '../src/session/payload';
import { SessionContext, type ContextEntry, type ContextSelection } from '../src/session/context';
import { SessionProposals } from '../src/session/proposals';
import { SessionTranscript, readSessionTranscript } from '../src/session/transcript';
import { rowText } from '../src/utils/ui-message';
import { SessionHistory } from '../src/session/history';
import { initSessionTranscriptTables } from '../src/session/transcript-schema';
import { getChatHistoryPage } from '../src/read-models/status';
import { answersForDrainTurns } from '../src/identity/conversation-store';
import { inheritedContextFromTranscript } from '../src/orchestrator/heads-support';
import type { JsonObject } from '../src/utils/json';
import { KinuError } from '../src/obs/error';

function setup() {
  const { rt, testSql } = createTestRuntime();
  initSessionContextTables(rt.storage.execRaw);
  const payloads = new SessionPayloads(async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor' }));
  const messages = new SessionMessages(rt.storage.sql, rt.actor, payloads);
  const context = new SessionContext(rt.storage.sql, rt.actor, write => rt.storage.transactionSync(write), messages);

  return { rt, testSql, payloads, messages, context };
}

test('message publication rolls back with its membership and can be retried', async () => {
  const s = setup();

  try {
    const selected = s.context.initialize();
    const prepared = await s.messages.prepare({ role: 'user', content: 'hello' }, 'input');
    expect(() => s.context.commit(selected, { cause: 'input', turnId: 'turn', assertEpoch: () => s.rt.actor.assertCurrent(), mutate: () => {
      s.messages.insert(prepared, 'input');
      throw new Error('crash before membership');
    } })).toThrow('crash before membership');
    expect(s.context.entries(selected)).toEqual([]);
    const committed = s.context.commit(selected, { cause: 'input', turnId: 'turn', mutate: () => [{ ...s.messages.insert(prepared, 'input'), entryId: 'input', position: 0 }], assertEpoch: () => s.rt.actor.assertCurrent() });
    expect(await s.messages.materialize(present(s.context.entries(committed)[0], 'the committed context entry'))).toEqual({ role: 'user', content: 'hello' });
  } finally { s.testSql.close(); }
});

test('an open message reads its accumulated text and a sealed one its content', async () => {
  const s = setup();

  try {
    const streamRows = () => s.testSql.db.query<{ n: number }, []>('SELECT count(*) AS n FROM stream_parts').get()?.n ?? -1;
    const descriptor = await s.payloads.prepare({ type: 'text' });
    s.context.initialize();
    s.messages.open('assistant', 'answer', 'output');
    s.messages.streamOpenPart('answer', { partNo: 0, kind: 'text', streamOrder: 0, descriptor, text: 'ab' });
    const entry = { messageId: 'answer' };
    expect(await s.messages.materialize(entry)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'ab' }] });

    s.messages.streamAppend('answer', 0, 'cd');
    s.messages.streamMetadata('answer', 0, await s.messages.prepareMetadata('answer', 0, { test: { partial: true } }));
    expect(streamRows()).toBe(1);
    expect(await s.messages.materialize(entry)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'abcd', providerOptions: { test: { partial: true } } }] });
    s.messages.streamEnd('answer', 0);
    expect(() => s.messages.streamAppend('answer', 0, 'e')).toThrow('ended');

    const content = await s.messages.prepareContent([{ partNo: 0, kind: 'text', streamOrder: 0, replyTo: null, value: { type: 'text', text: 'final' } }]);
    s.messages.seal('answer', content, { providerOptions: { test: { late: true } } });
    expect(streamRows()).toBe(0);
    expect(await s.messages.materialize(entry)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'final' }], providerOptions: { test: { late: true } } });
    expect(() => s.messages.seal('answer', content)).toThrow('already sealed');
    expect(() => s.messages.streamOpenPart('answer', { partNo: 1, kind: 'text', streamOrder: 1, descriptor })).toThrow('sealed');
    expect(await s.messages.openParts('answer')).toBeNull();
  } finally { s.testSql.close(); }
});

test('an accumulating part never puts one row over the platform limit and seals through the spill rule', async () => {
  // `do.sqlite.row_bytes` is 2 MB: a long reasoning part continues in the next row.
  const s = setup();

  try {
    const descriptor = await s.payloads.prepare({ type: 'reasoning' });
    s.messages.open('assistant', 'long', 'output');
    s.messages.streamOpenPart('long', { partNo: 0, kind: 'reasoning', streamOrder: 0, descriptor });
    const window = 'r'.repeat(300_000);

    for (let i = 0; i < 4; i++) s.messages.streamAppend('long', 0, window);
    const widest = s.testSql.db.query<{ n: number }, []>('SELECT MAX(length(text)) AS n FROM stream_parts').get()?.n ?? -1;
    expect(widest * 3).toBeLessThan(PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value);
    expect(widest).toBeLessThan(300_000);
    expect(await s.messages.materialize({ messageId: 'long' })).toEqual({ role: 'assistant', content: [{ type: 'reasoning', text: window.repeat(4) }] });
    const parts = await s.messages.openParts('long');

    if (parts === null) throw new Error('the message is open');
    s.messages.seal('long', await s.messages.prepareContent(parts));
    const row = s.testSql.db.query<{ content_json: string | null; content_path: string | null }, []>("SELECT content_json, content_path FROM session_messages WHERE message_id = 'long'").get();
    expect(row?.content_json).toBeNull();
    expect(row?.content_path).not.toBeNull();
    expect(await s.messages.materialize({ messageId: 'long' })).toEqual({ role: 'assistant', content: [{ type: 'reasoning', text: window.repeat(4) }] });
  } finally { s.testSql.close(); }
});

test('pruning and branching preserve historical selection without resurrecting removed output', async () => {
  const s = setup();

  try {
    const prepared = await s.messages.prepare({ role: 'assistant', content: 'recorded' }, 'answer');
    const initial = s.context.initialize();
    const original = s.context.commit(initial, { cause: 'output', turnId: 'turn', mutate: () => [{ ...s.messages.insert(prepared, 'output'), entryId: 'answer', position: 0 }], assertEpoch: () => s.rt.actor.assertCurrent() });
    const fork = s.context.fork(original);
    const pruned = s.context.commit(original, { cause: 'context_transform', turnId: 'turn', mutate: () => [], assertEpoch: () => s.rt.actor.assertCurrent() });
    expect(s.context.entries(pruned)).toEqual([]);
    expect(s.context.entries(original)).toEqual(s.context.entries(fork));
    s.context.select(pruned, fork, () => {});
    expect(s.context.selected()).toEqual(fork);
    expect(() => s.context.entries({ contextId: 'missing', revision: 0 })).toThrow('revision does not exist');
  } finally { s.testSql.close(); }
});

test('reverting a context selects an isolated branch that survives reader reconstruction', async () => {
  const s = setup();

  try {
    const assertOwner = () => s.rt.actor.assertCurrent();
    const input = await s.messages.prepare({ role: 'user', content: 'initial instruction' }, 'input');
    const initial = s.context.initialize();
    const original = s.context.commit(initial, { cause: 'input', turnId: 'turn', mutate: () => [{ ...s.messages.insert(input, 'input'), entryId: 'input', position: 0 }], assertEpoch: assertOwner });
    const summary = await s.messages.prepare({ role: 'user', content: 'compacted instruction' }, 'summary');
    const compacted = s.context.commit(original, { cause: 'context_transform', turnId: 'turn', mutate: () => [{ ...s.messages.insert(summary, 'context_transform'), entryId: 'summary', position: 0 }], assertEpoch: assertOwner });
    const before = s.rt.storage.sql<{ total: number }>`SELECT COUNT(*) AS total FROM session_messages`[0]?.total;
    const restored = s.context.fork(original);
    s.context.select(compacted, restored, assertOwner);
    const reopened = new SessionContext(s.rt.storage.sql, s.rt.actor, write => s.rt.storage.transactionSync(write), s.messages);
    expect(reopened.selected()).toEqual(restored);
    expect(reopened.entries(restored)).toEqual(s.context.entries(original));
    expect(s.rt.storage.sql<{ total: number }>`SELECT COUNT(*) AS total FROM session_messages`[0]?.total).toBe(before);

    const edited = await s.messages.prepare({ role: 'user', content: 'branch instruction' }, 'edit');
    const branch = reopened.commit(restored, { cause: 'edit', turnId: null, mutate: () => [{ ...s.messages.insert(edited, 'edit'), entryId: 'input', position: 0 }], assertEpoch: assertOwner });
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

test('a context reads what is stored: another reader\'s revision, and one written again by the same turn after a rollback', async () => {
  const s = setup();
  // One millisecond for every write, as one request's frozen clock gives them.
  setSystemTime(Date.parse('2026-09-25T00:00:00.000Z'));

  try {
    const assertOwner = () => s.rt.actor.assertCurrent();
    const other = new SessionContext(s.rt.storage.sql, s.rt.actor, write => s.rt.storage.transactionSync(write), s.messages);

    const said = async (text: string) => {
      const prepared = await s.messages.prepare({ role: 'user', content: text }, text);

      return (entries: readonly ContextEntry[]) => [...entries, { ...s.messages.insert(prepared, 'input'), entryId: text, position: entries.length }];
    };

    const read = async (selection: ContextSelection) => Promise.all(s.context.entries(selection).map(async entry => (await s.messages.materialize(entry)).content));
    const first = s.context.commit(s.context.initialize(), { cause: 'input', turnId: 'turn', assertEpoch: assertOwner, mutate: await said('one') });
    const second = other.commit(first, { cause: 'input', turnId: 'turn', assertEpoch: assertOwner, mutate: await said('two') });

    expect(await read(second)).toEqual(['one', 'two']);
    const three = await said('three');

    const rolledBack = (write: () => ContextSelection): void => {
      expect(() => s.rt.storage.transactionSync(() => {
        write();
        throw new Error('rolled back after its revision');
      })).toThrow('rolled back after its revision');
    };

    rolledBack(() => s.context.commit(second, { cause: 'input', turnId: 'third', assertEpoch: assertOwner, mutate: three }));
    const third = other.commit(second, { cause: 'input', turnId: 'third', assertEpoch: assertOwner, mutate: await said('four') });

    expect(third.revision).toBe(second.revision + 1);
    expect(await read(third)).toEqual(['one', 'two', 'four']);

    // Both writes open the same row; the retry also drops the last entry.
    const five = s.messages.insert(await s.messages.prepare({ role: 'user', content: 'five' }, 'five'), 'input');
    const replaced = (entries: readonly ContextEntry[]) => entries.map((entry, position) => (position === 0 ? { ...five, entryId: 'five', position } : entry));
    rolledBack(() => s.context.commit(third, { cause: 'edit', turnId: 'fourth', assertEpoch: assertOwner, mutate: replaced }));
    const fourth = other.commit(third, { cause: 'edit', turnId: 'fourth', assertEpoch: assertOwner, mutate: (entries) => replaced(entries).slice(0, 2) });

    expect(await read(fourth)).toEqual(['five', 'two']);
  } finally {
    setSystemTime();
    s.testSql.close();
  }
});

test('VFS-backed image payloads fail explicitly after file corruption', async () => {
  const s = setup();

  try {
    const image = await s.messages.prepare({ role: 'user', content: [{ type: 'image', image: new Uint8Array([0, 1, 255]) }] }, 'image');
    const selected = s.context.commit(s.context.initialize(), { cause: 'input', turnId: 'turn', mutate: () => [{ ...s.messages.insert(image, 'input'), entryId: 'image', position: 0 }], assertEpoch: () => s.rt.actor.assertCurrent() });
    const reference = present(s.context.entries(selected)[0], 'the image entry');
    expect(await s.messages.materialize(reference)).toEqual({ role: 'user', content: [{ type: 'image', image: new Uint8Array([0, 1, 255]) }] });
    const stored = await s.messages.materializeParts(reference);
    const external = v.parse(v.object({ image: v.object({ $sessionAttachment: v.object({ path: v.string() }) }) }), stored[0]?.value);
    await s.rt.storage.vfs.writeFile(external.image.$sessionAttachment.path, 'corrupt');
    // The reader that verified these bytes keeps serving them; a reader that
    // has not, as after a restart, finds the corruption.
    expect(await s.messages.materialize(reference)).toEqual({ role: 'user', content: [{ type: 'image', image: new Uint8Array([0, 1, 255]) }] });
    await expect(new SessionMessages(s.rt.storage.sql, s.rt.actor, s.payloads).materialize(reference)).rejects.toThrow('digest differs');
  } finally { s.testSql.close(); }
});

test('a sealed row that is JSON but not a message is refused on read', async () => {
  // Valid JSON is not enough; the stored text must parse as a message.
  const corruptions = [
    { content: '{"parts":[]}', layer: 'the part list' },
    { content: '[{"partNo":0,"kind":"text","streamOrder":0,"replyTo":null,"value":{"type":"text","text":7}}]', layer: 'the SDK message schema' },
  ];

  for (const { content, layer } of corruptions) {
    const s = setup();

    try {
      const prepared = await s.messages.prepare({ role: 'user', content: [{ type: 'text', text: 'hello' }] }, 'input');
      const selected = s.context.commit(s.context.initialize(), { cause: 'input', turnId: 'turn', mutate: () => [{ ...s.messages.insert(prepared, 'input'), entryId: 'input', position: 0 }], assertEpoch: () => s.rt.actor.assertCurrent() });
      const reference = present(s.context.entries(selected)[0], 'the input entry');
      s.testSql.db.run("UPDATE session_messages SET content_json = ? WHERE message_id = 'input'", [content]);
      await expect(s.messages.materialize(reference), layer).rejects.toThrow(KinuError);
    } finally { s.testSql.close(); }
  }
});

test('a sealed message read back cannot be edited in place, and a later read is the stored one', async () => {
  // Steps share the sealed object, so in-place edits must fail.
  const s = setup();

  try {
    const prepared = await s.messages.prepare({ role: 'assistant', content: [{ type: 'text', text: 'stored' }] }, 'answer');
    s.messages.insert(prepared, 'output');
    const read = await s.messages.materialize({ messageId: 'answer' });
    const part = Array.isArray(read.content) ? read.content[0] : undefined;

    if (part?.type !== 'text') throw new Error('the stored answer must read back as one text part');
    expect(() => { part.text = 'edited'; }).toThrow(TypeError);
    expect(() => { read.providerOptions = { test: { marked: true } }; }).toThrow(TypeError);
    expect(await s.messages.materialize({ messageId: 'answer' })).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'stored' }] });
  } finally { s.testSql.close(); }
});

test('a reader holds only the sealed messages its last context read named', async () => {
  const s = setup();

  try {
    for (const [id, text] of [['first', 'one'], ['second', 'two']]) s.messages.insert(await s.messages.prepare({ role: 'user', content: text }, id), 'input');
    await s.messages.materializeAll([{ messageId: 'first' }, { messageId: 'second' }]);
    await s.messages.materializeAll([{ messageId: 'second' }]);
    s.testSql.db.run("UPDATE session_messages SET content_json = '{}'");

    // `first` left the context, so reading it goes back to its row, now corrupt.
    await expect(s.messages.materialize({ messageId: 'first' })).rejects.toThrow(KinuError);
    expect(await s.messages.materialize({ messageId: 'second' })).toEqual({ role: 'user', content: 'two' });
  } finally { s.testSql.close(); }
});

test('foreign keys reject another actor selection and stale ownership publishes nothing', async () => {
  const s = setup();

  try {
    const selected = s.context.initialize();
    const prepared = await s.messages.prepare({ role: 'user', content: 'same' }, 'one');
    expect(() => s.context.commit(selected, { cause: 'input', turnId: 'turn', mutate: () => [{ ...s.messages.insert(prepared, 'input'), entryId: 'one', position: 0 }], assertEpoch: () => { throw new Error('stale epoch'); } })).toThrow('stale epoch');
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
    const base = s.context.commit(s.context.initialize(), { cause: 'input', turnId: 'turn', mutate: () => [{ ...s.messages.insert(prepared, 'input'), entryId: 'old', position: 0 }], assertEpoch: assertOwner });
    const old = present(s.context.entries(base)[0], 'the staged entry');
    proposals.stage({ id: 'remove', base, author: s.rt.actor.actorId, via: 'session', cause: 'context_transform', turnId: 'turn', changes: [{ entryId: old.entryId, expected: old, replacement: null }] });
    const tail = await s.messages.prepare({ role: 'assistant', content: 'new work' }, 'tail');
    s.context.commit(base, { cause: 'output', turnId: 'turn', mutate: entries => [...entries, { ...s.messages.insert(tail, 'output'), entryId: 'tail', position: 1 }], assertEpoch: assertOwner });
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
    const writer = new SessionTranscript({ sql: s.rt.storage.sql, actor: s.rt.actor, sessionId: 'default', messages: s.messages, payloads: s.payloads, atomic: write => s.rt.storage.transactionSync(write), selection: () => s.context.selected() });
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
    const writer = new SessionTranscript({ sql: s.rt.storage.sql, actor: s.rt.actor, sessionId: 'default', messages: s.messages, payloads: s.payloads, atomic: write => s.rt.storage.transactionSync(write), selection: () => s.context.selected() });
    const other = new SessionTranscript({ sql: s.rt.storage.sql, actor: s.rt.actor, sessionId: 'mcts', messages: s.messages, payloads: s.payloads, atomic: write => s.rt.storage.transactionSync(write), selection: () => s.context.selected() });

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
      chat.appendAssistant(await chat.prepareAssistant({ id: answer, parentId: ask, turnId: ask, runId: ask, parts: [{ messageId: output.messageId, partNo: 0 }], finalText: null }));
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
    const transcript = new SessionTranscript({ sql: s.rt.storage.sql, actor: s.rt.actor, sessionId: 'default', messages: s.messages, payloads: s.payloads, atomic: write => s.rt.storage.transactionSync(write), selection: () => s.context.selected() });
    const input = s.messages.insert(await s.messages.prepare({ role: 'user', content: 'request' }, 'input'), 'input');
    transcript.appendUser(await transcript.prepareUser({ id: 'ask', turnId: 'turn', message: input, metadata: { drainTurnId: 'drain' } }));

    for (const [id, text] of [['older', 'old answer'], ['latest', 'latest answer'], ['empty', '  ']] as const) {
      s.messages.insert(await s.messages.prepare({ role: 'assistant', content: text }, id), 'output');
      transcript.appendAssistant(await transcript.prepareAssistant({ id, parentId: 'ask', turnId: 'turn', runId: 'run', parts: [{ messageId: id, partNo: 0 }], finalText: null }));
    }

    expect(await answersForDrainTurns(transcript, ['drain', 'unanswered'])).toEqual(new Map([['drain', 'latest answer']]));
  } finally { s.testSql.close(); }
});

/** A chat transcript whose turn streamed `parts`, settled with its last streamed text, or with `answer` written apart. */
async function settledAnswer(s: ReturnType<typeof setup>, parts: JsonObject[], answer: string | null) {
  initSessionTranscriptTables(s.rt.storage.execRaw);
  const transcript = new SessionTranscript({ sql: s.rt.storage.sql, actor: s.rt.actor, sessionId: 'default', messages: s.messages, payloads: s.payloads, atomic: write => s.rt.storage.transactionSync(write), selection: () => s.context.selected() });
  const input = s.messages.insert(await s.messages.prepare({ role: 'user', content: 'list the folders' }, 'input'), 'input');
  transcript.appendUser(await transcript.prepareUser({ id: 'ask', turnId: 'turn', message: input, metadata: { drainTurnId: 'drain' } }));
  const output = s.messages.insert(await s.messages.prepareParts({ id: 'output', role: 'assistant', content: parts, envelope: {} }), 'output');
  const streamed = parts.map((_, partNo) => ({ messageId: output.messageId, partNo }));
  const lastText = parts.reduce((found, part, index) => (part.type === 'text' ? index : found), -1);

  const finalText = answer === null ? streamed[lastText] ?? null
    : { messageId: s.messages.insert(await s.messages.prepare({ role: 'assistant', content: answer }, 'display'), 'render').messageId, partNo: 0 };

  transcript.appendAssistant(await transcript.prepareAssistant({ id: 'answer', parentId: 'ask', turnId: 'turn', runId: 'run', parts: streamed, finalText }));
  const drawn = (await transcript.message('answer'))?.parts ?? [];

  return { transcript, drawn: drawn.map(part => part.type === 'text' ? part.text : part.type) };
}

const listed = (id: string): JsonObject[] => [
  { type: 'tool-call', toolCallId: id, toolName: 'file', input: {} },
  { type: 'tool-result', toolCallId: id, toolName: 'file', output: { type: 'text', value: 'listed' } },
];

test('a multi-step answer draws every part it streamed, and every reader of the answer reads only its final text', async () => {
  const s = setup();

  try {
    const { transcript, drawn } = await settledAnswer(s, [
      { type: 'text', text: 'Step 1: listing.' }, ...listed('one'), { type: 'text', text: 'Step 2: listing.' }, ...listed('two'), { type: 'text', text: 'Done.' },
    ], null);

    expect(drawn).toEqual(['Step 1: listing.', 'tool-file', 'Step 2: listing.', 'tool-file', 'Done.']);
    expect((await transcript.project('answer'))?.content).toBe('Done.');
    expect((await getChatHistoryPage(transcript, {})).items.find(item => item.role === 'assistant')?.content).toBe('Done.');
    expect((await transcript.newestFirst()).find(row => row.role === 'assistant')?.content).toBe('Done.');
    expect(await answersForDrainTurns(transcript, ['drain'])).toEqual(new Map([['drain', 'Done.']]));
    expect((await inheritedContextFromTranscript(transcript)).find(row => row.role === 'assistant')?.content).toBe('Done.');
    expect(rowText({ role: 'assistant', parts: (await transcript.message('answer'))?.parts ?? [] })).toBe('Done.');
  } finally { s.testSql.close(); }
});

test('a turn that ends on a tool (stopped mid-call, or at the step cap) keeps its row as it streamed', async () => {
  const s = setup();

  try {
    const { transcript, drawn } = await settledAnswer(s, [
      { type: 'text', text: 'Step 1: listing.' }, ...listed('one'), { type: 'text', text: 'Step 2: reading.' }, ...listed('two'),
    ], null);

    expect(drawn).toEqual(['Step 1: listing.', 'tool-file', 'Step 2: reading.', 'tool-file']);
    expect((await transcript.project('answer'))?.content).toBe('Step 2: reading.');
  } finally { s.testSql.close(); }
});

test('a recorded answer takes the place of the texts it is made of, and follows narration it is not made of', async () => {
  const continued = setup();
  const reported = setup();

  try {
    // A step cut at the output limit, then its continuation: the answer is the two joined, drawn once.
    const joined = await settledAnswer(continued, [
      { type: 'text', text: 'Step 1: listing.' }, ...listed('one'), { type: 'text', text: 'The folder holds ' }, { type: 'text', text: 'three files.' },
    ], 'The folder holds three files.');

    expect(joined.drawn).toEqual(['Step 1: listing.', 'tool-file', 'The folder holds three files.']);

    // A head's report is not the model's text: the narration stays and the report follows it.
    const report = await settledAnswer(reported, [
      { type: 'text', text: 'Step 1: listing.' }, ...listed('one'), { type: 'text', text: 'Step 2: reading.' },
    ], 'Head h1 stopped: out of steps.');

    expect(report.drawn).toEqual(['Step 1: listing.', 'tool-file', 'Step 2: reading.', 'Head h1 stopped: out of steps.']);
    expect((await report.transcript.project('answer'))?.content).toBe('Head h1 stopped: out of steps.');
  } finally {
    continued.testSql.close();
    reported.testSql.close();
  }
});
