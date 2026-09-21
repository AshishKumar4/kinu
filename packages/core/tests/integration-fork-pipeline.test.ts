/**
 * The fork-copy pipeline end-to-end, across the transport boundary.
 *
 *   1. The source workspace materializes a ForkSnapshot from its own SQL rows
 *      (snapshotWorkspaceForFork)
 *   2. The snapshot crosses the wire — structuredClone, which is what DO RPC
 *      does, and what preserves the canonical BLOB vfs rows
 *   3. The target lands it in its own SQLite (writeForkSnapshot)
 *
 * Both halves are core's, so this exercises the production path rather than a
 * transcription of it. Any second definition of the copy — a SqlExecutor stub
 * inside the CF backend answering the exact SELECTs the write issues, or a
 * hand-rolled one in this file — is a place the shapes can drift apart in
 * silence.
 *
 * Verifies the same invariants as unit-fork.test.ts, over the full round trip.
 */

import { describe, test, expect } from 'bun:test';
import {
  readForkLineage, readSoul, snapshotWorkspaceForFork, writeForkSnapshot, SOUL_PATH,
} from '../src/index';
import { createTestWorkspace as fresh, type TestWorkspace } from './helpers';
import {
  readChain, readWorkingContext, seedForkSource, seedForkTarget,
  SOURCE_ARTIFACTS, SPILLED_BYTES, TARGET_ARTIFACTS, type ForkConversation,
} from './helpers/fork-conversation';

const TARGET = {
  workspaceId: 'FORK-DO-ID', workspaceName: 'my-fork', artifactDirectory: TARGET_ARTIFACTS, now: 88888,
} as const;

async function seedSource(src: TestWorkspace): Promise<ForkConversation> {
  const chat = await seedForkSource(src, {
    workspaceId: 'SRC-1', workspaceName: 'source-agent',
    craftedTools: [{ name: 'helper', description: 'utility', code: 'async (x) => x + 1' }],
  });

  await chat.say({ id: 'm1', role: 'user', text: 'hello', parentId: null });
  await chat.say({ id: 'm2', role: 'assistant', text: 'hi there' });
  // Past the cut below, and so never carried.
  await chat.say({ id: 'm3', role: 'user', text: 'post-fork-point' });

  return chat;
}

function snapshotOf(src: TestWorkspace, untilMessageId: string) {
  return snapshotWorkspaceForFork({
    sql: src.sql, vfs: src.vfs, untilMessageId, artifactDirectory: SOURCE_ARTIFACTS,
  });
}

describe('fork pipeline (end-to-end)', () => {
  test('a cloned snapshot replays into the fork database as one conversation', async () => {
    const src = fresh();
    const tgt = fresh();
    // The fork DO's onStart bootstrap: an identity and a main actor exist
    // before any frame arrives.
    await seedForkTarget(tgt, { workspaceId: 'FORK-DO-ID', workspaceName: 'fork-bootstrap' });
    await seedSource(src);

    // DO RPC uses structured clone, which preserves the canonical BLOB
    // (Uint8Array/ArrayBuffer) vfs rows.
    const snapshot = structuredClone(await snapshotOf(src, 'm2'));
    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, TARGET);

    expect(tgt.sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity`)
      .toEqual([{ id: 'FORK-DO-ID', name: 'my-fork' }]);
    expect(await readSoul(tgt.vfs)).toBe('help with testing');

    const chain = await readChain(tgt);
    // m3 is not an ancestor of m2, so it did not cross; the marker is the
    // fork's own leaf.
    expect(chain.ids.slice(0, 2)).toEqual(['m1', 'm2']);
    expect(chain.ids).toHaveLength(3);
    expect(chain.ids[2]?.startsWith('fork-marker-')).toBe(true);
    expect(chain.text.slice(0, 2)).toEqual(['hello', 'hi there']);

    // The model's context came with it, in its positions.
    expect((await readWorkingContext(tgt, TARGET_ARTIFACTS)).entryIds).toEqual(['m1', 'm2']);

    expect(tgt.sql<{ name: string }>`SELECT name FROM crafted_tools`).toEqual([{ name: 'helper' }]);
    // The memory arrived as a FILE the fork can open, not as copied rows.
    expect(await tgt.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' })).toBe('key insight');

    const lineage = readForkLineage(tgt.sql);
    expect(lineage?.sourceWorkspaceId).toBe('SRC-1');
    expect(lineage?.sourceWorkspaceName).toBe('source-agent');
    expect(lineage?.sourceMessageId).toBe('m2');
    expect(lineage?.forkedAt).toBe(88888);

    const config = new Map(tgt.sql<{ key: string; value: string }>`
      SELECT key, value FROM actor_config`.map((row) => [row.key, row.value]));

    expect(config.get('model')).toBe('@cf/moonshotai/kimi-k2.6');
    expect(config.get('display_name')).toBe('my-fork');
  });

  test('the marker the round trip lands is parented on the cut and names the source', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt, { workspaceId: 'FORK-DO-ID' });
    await seedSource(src);
    const snapshot = structuredClone(await snapshotOf(src, 'm2'));

    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, TARGET);

    const marker = tgt.sql<{ id: string; parent_id: string | null; recorded_at: number }>`
      SELECT id, parent_id, recorded_at FROM conversation_entries WHERE role = 'system'`;

    expect(marker).toHaveLength(1);
    expect(marker[0]?.parent_id).toBe('m2');
    expect(marker[0]?.recorded_at).toBe(snapshot.cut.createdAtMs + 1);
    const chain = await readChain(tgt);
    expect(chain.text[chain.text.length - 1]).toContain('forked from workspace');
    expect(chain.text[chain.text.length - 1]).toContain('source-agent');
  });

  test('a snapshot with no crafted tools and no memory is safe', async () => {
    const src = fresh();
    const tgt = fresh();
    const chat = await seedForkSource(src, { workspaceId: 'S', workspaceName: 's', memory: [] });
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });

    const snapshot = structuredClone(await snapshotOf(src, 'm1'));

    await expect(writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, {
      workspaceId: 'F', workspaceName: 'empty-fork', artifactDirectory: TARGET_ARTIFACTS, now: 7000,
    })).resolves.toBeDefined();

    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`[0]?.c).toBe(0);
    expect((await readChain(tgt)).ids[0]).toBe('m1');
  });

  test('a cloned spilled payload lands on the fork\'s own plane and reads back', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt, { workspaceId: 'FORK-DO-ID' });
    const chat = await seedForkSource(src, { workspaceId: 'SRC-1', workspaceName: 'source-agent' });
    const spilled = 's'.repeat(SPILLED_BYTES);
    await chat.say({ id: 'm1', role: 'user', text: spilled, parentId: null });

    const snapshot = structuredClone(await snapshotOf(src, 'm1'));
    expect(snapshot.artifacts.length).toBeGreaterThan(0);

    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, TARGET);

    for (const artifact of snapshot.artifacts) {
      expect(await tgt.vfs.exists(`${TARGET_ARTIFACTS}/${artifact.path}`)).toBe(true);
    }

    // Read through the production reader: it resolves the re-rooted path and
    // refuses a payload whose digest differs from the row's.
    expect((await readChain(tgt)).text[0]).toBe(spilled);
  });

  test('hosted fork identity preserves the owner established before the file copy', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedSource(src);
    const snapshot = structuredClone(await snapshotOf(src, 'm2'));

    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, {
      workspaceId: 'OWNED-FORK', workspaceName: 'owned-fork', artifactDirectory: TARGET_ARTIFACTS,
      ownerUserId: 'user-123', now: 9000,
    });

    expect(tgt.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM workspace_identity`).toEqual([
      { owner_user_id: 'user-123' },
    ]);
  });

  test('hosted forks route SOUL.md through the owner-only writer on every delivery', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedSource(src);
    const snapshot = structuredClone(await snapshotOf(src, 'm2'));
    const soul = snapshot.files.find((file) => file.path === SOUL_PATH);

    if (!soul) throw new Error('fork snapshot did not include SOUL.md');
    const protectedWrites: string[] = [];

    const options = {
      workspaceId: 'PROTECTED-FORK',
      workspaceName: 'protected-fork',
      artifactDirectory: TARGET_ARTIFACTS,
      ownerUserId: 'user-123',
      now: 9000,
      writeSoulFile: async (content: string) => {
        protectedWrites.push(content);
        await tgt.vfs.writeFile(SOUL_PATH, content);
      },
    } as const;

    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, options);
    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, options);

    expect(protectedWrites).toEqual([soul.content, soul.content]);
  });

  test('repeating a completed delivery converges on exactly one copied history', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedSource(src);
    const snapshot = structuredClone(await snapshotOf(src, 'm2'));

    const options = {
      workspaceId: 'FINAL', workspaceName: 'recovered-fork', artifactDirectory: TARGET_ARTIFACTS, now: 99999,
    } as const;

    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, options);
    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, options);

    expect(tgt.sql<{ id: string }>`SELECT id FROM workspace_identity`).toEqual([{ id: 'FINAL' }]);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM fork_lineage`[0]?.c).toBe(1);
    expect(readForkLineage(tgt.sql)?.forkedAt).toBe(99999);
    // The transcript landed ONCE: a redelivery replaces what the last attempt
    // staged rather than duplicating the conversation.
    expect((await readChain(tgt)).ids.slice(0, 2)).toEqual(['m1', 'm2']);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM conversation_entries`[0]?.c).toBe(3);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM session_messages`[0]?.c).toBe(3);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM context_memberships`[0]?.c).toBe(2);
  });
});
