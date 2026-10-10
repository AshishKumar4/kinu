// A replacement transfer empties what an abandoned one landed before it stages, over the store's own foreign keys.
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { openWorkspaceMainActor } from '../src/identity/workspace-actors';
import { sealForkFrame } from '../src/index';
import { createTestWorkspace as fresh } from './helpers';
import { seedForkSource, TARGET_ARTIFACTS } from './helpers/fork-conversation';
import { deliver, receiverFor, sourceFrames } from './helpers/fork-stream';

/** The tables a published fork's chat, context, messages and tools land in. */
const LANDED = ['conversation_entries', 'context_memberships', 'session_messages', 'crafted_tools'] as const;

describe('a fork target taking a replacement transfer', () => {
  // Run against the store's own foreign keys: a reset ordered parent first is refused by SQLite, not by this test.
  test('empties a published fork with every foreign key enforced', async () => {
    const src = fresh();
    const chat = await seedForkSource(src, { purpose: 'help with testing', craftedTools: [{ name: 'helper', description: 'utility', code: 'async (x) => x' }] });

    await chat.say({ id: 'm1', role: 'user', text: 'first' });
    await chat.say({ id: 'm2', role: 'assistant', text: 'second' });
    const tgt = fresh();
    const target = { workspaceId: 'FORK-ID', workspaceName: 'my-fork', artifactDirectory: TARGET_ARTIFACTS, now: 4242 };

    await deliver(receiverFor(tgt, target), await sourceFrames(src, 'm2'));
    const actorId = openWorkspaceMainActor(tgt.sql).actorId;

    const rows = (): Record<string, number> => Object.fromEntries(LANDED.map((table) => [table, (table === 'crafted_tools'
      ? tgt.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
      : tgt.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE actor_id = ?`).get(actorId)?.n) ?? 0]));

    expect(Object.values(rows()).every((count) => count > 0)).toBe(true);
    const memory = new MemoryStore(tgt.vfs, tgt.sql, write => tgt.db.transaction(write)());
    memory.ensureSchema();
    await memory.indexFile('memory/replaced.md', 'an abandoned semantic projection');
    expect(memory.pendingProjection()).toHaveLength(1);
    tgt.db.exec('PRAGMA foreign_keys = ON');
    const replacement = (await sourceFrames(src, 'm1')).find((frame) => frame.kind === 'begin');

    if (replacement === undefined) throw new Error('the source stream has no begin frame');
    await receiverFor(tgt, target).accept(sealForkFrame({ ...replacement, transferId: 'tx-replacement' }));
    expect(rows()).toEqual(Object.fromEntries(LANDED.map((table) => [table, 0])));
    expect(memory.pendingProjection()).toEqual([]);
  });
});
