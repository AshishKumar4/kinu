import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestActorsOver, createTestSql, createMemoryVfs } from '@kinu.run/test-utils';
import {
  SessionHistory, CHAT_SESSION_ID, STEER_METADATA_KEY, STEER_STEP_METADATA_KEY,
  initActorClaimTables,
  type JsonObject, type MessagePartReference,
} from '@kinu.run/core';

const databases: Database[] = [];

afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function transcript() {
  const { sql, db, execRaw } = createTestSql();
  databases.push(db);
  const actor = createTestActorsOver(db).main;
  initActorClaimTables(execRaw);
  const workspace = createMemoryVfs();

  const history = new SessionHistory({
    sql, actor, transactionSync: (write) => db.transaction(write)(),
    files: async () => ({ vfs: workspace.vfs, artifactDirectory: '/home/main/.kinu/context' }),
  });

  const store = history.transcript(CHAT_SESSION_ID);

  const user = async (id: string, text: string, metadata?: JsonObject) => {
    const message = await history.admitInput({ id, turnId: id, message: { role: 'user', content: text }, assertOwner: () => actor.assertCurrent() });
    const entry = await store.prepareUser({ id, turnId: id, message, metadata });
    store.appendUser(entry);
  };

  const output = async (id: string, parts: JsonObject[]): Promise<MessagePartReference[]> => {
    const prepared = await history.messages.prepareParts('assistant', parts, {}, id);
    const reference = db.transaction(() => history.messages.insert(prepared, 'output'))();

    return prepared.parts.map((part) => ({ messageId: id, partNo: part.number, throughSequence: reference.sequence }));
  };

  return { history, store, user, output };
}

describe('the CF public transcript over canonical references', () => {
  test('replayed admission is idempotent and steers retain parentage and metadata', async () => {
    const t = transcript();
    await t.user('opening', 'build the slate');
    await t.user('opening', 'build the slate');
    await t.user('steer', 'also check staging', { [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: 2 });

    expect(t.store.ancestry().map((entry) => [entry.id, entry.parentId])).toEqual([
      ['opening', null], ['steer', 'opening'],
    ]);
    expect((await t.store.history()).map((message) => message.id)).toEqual(['opening', 'steer']);
    expect(await t.store.lastUserMetadata()).toMatchObject({ [STEER_STEP_METADATA_KEY]: 2 });
  });

  test('the selected final text preserves tool results and UI-only step markers without narration', async () => {
    const t = transcript();
    await t.user('opening', 'build the slate');

    const parts = await t.output('native-output', [
      { type: 'text', text: 'I will inspect the files.' },
      { type: 'step-start' },
      { type: 'tool-call', toolCallId: 'call', toolName: 'file', input: {} },
      { type: 'tool-result', toolCallId: 'call', toolName: 'file', output: { type: 'text', value: 'inspected' } },
      { type: 'step-start' },
      { type: 'text', text: 'The slate is ready.' },
    ]);

    const finalText = parts.at(-1);

    if (finalText === undefined) throw new Error('fixture has no final text reference');
    const entry = await t.store.prepareAssistant({ id: 'answer', parentId: 'opening', turnId: 'opening', runId: 'run', parts, finalText });
    t.store.appendAssistant(entry);
    const answer = (await t.store.history()).at(-1);

    expect(answer?.parts).toEqual([
      { type: 'step-start' },
      { type: 'tool-file', toolCallId: 'call', state: 'output-available', input: {}, output: 'inspected' },
      { type: 'step-start' },
      { type: 'text', text: 'The slate is ready.' },
    ]);
    expect(t.store.read('answer')?.parts.at(-1)).toEqual(finalText);
  });

  test('a synthesized answer references separate canonical text without entering model context', async () => {
    const t = transcript();
    await t.user('opening', 'run the check');

    const parts = await t.output('native-output', [
      { type: 'tool-call', toolCallId: 'call', toolName: 'shell', input: {} },
      { type: 'tool-result', toolCallId: 'call', toolName: 'shell', output: { type: 'text', value: 'passed' } },
    ]);

    const final = await t.output('display-answer', [{ type: 'text', text: 'The check passed.' }]);
    const finalText = final[0];

    if (finalText === undefined) throw new Error('fixture has no display text reference');
    t.store.appendAssistant(await t.store.prepareAssistant({ id: 'answer', parentId: 'opening', turnId: 'opening', runId: 'run', parts, finalText }));
    expect((await t.store.history()).at(-1)?.parts.at(-1)).toEqual({ type: 'text', text: 'The check passed.' });
    const selected = t.history.context.selected();

    if (selected !== null) expect(t.history.context.entries(selected).some((entry) => entry.messageId === 'display-answer')).toBe(false);
    t.store.clear();
    expect(t.store.count()).toBe(0);
    expect(await t.history.messages.materialize({ messageId: finalText.messageId, sequence: finalText.throughSequence })).toMatchObject({ role: 'assistant' });
  });
});
