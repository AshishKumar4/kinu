/** The fork-copy pipeline end to end: the source's frame stream, each frame structuredClone'd across the wire
 *  (as DO RPC), the target's receiver. Both halves are core's, so no second definition of the copy can drift. */

import { describe, test, expect } from 'bun:test';
import { readForkLineage, readSoul } from '../src/index';
import { createTestWorkspace as fresh, type TestWorkspace } from './helpers';
import {
  readChain, readWorkingContext, seedForkSource, seedForkTarget,
  SPILLED_BYTES, TARGET_ARTIFACTS, type ForkConversation,
} from './helpers/fork-conversation';
import { deliver, reassemble, receiverFor, sourceFrames, streamFork } from './helpers/fork-stream';

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

describe('fork pipeline (end-to-end)', () => {
  test('a streamed fork replays into the fork database as one conversation', async () => {
    const src = fresh();
    const tgt = fresh();
    // The fork DO's onStart bootstrap: identity and main actor exist before any frame.
    await seedForkTarget(tgt, { workspaceId: 'FORK-DO-ID', workspaceName: 'fork-bootstrap' });
    await seedSource(src);

    await streamFork(src, tgt, TARGET, { untilMessageId: 'm2' });

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

    const landed = await streamFork(src, tgt, TARGET, { untilMessageId: 'm2' });

    const marker = tgt.sql<{ id: string; parent_id: string | null; recorded_at: number }>`
      SELECT id, parent_id, recorded_at FROM conversation_entries WHERE role = 'system'`;

    expect(marker).toHaveLength(1);
    expect(marker[0]?.parent_id).toBe('m2');
    expect(marker[0]?.recorded_at).toBe(landed.forkPointMs + 1);
    const chain = await readChain(tgt);
    expect(chain.text[chain.text.length - 1]).toContain('forked from workspace');
    expect(chain.text[chain.text.length - 1]).toContain('source-agent');
  });

  test('a source with no crafted tools and no memory forks safely', async () => {
    const src = fresh();
    const tgt = fresh();
    const chat = await seedForkSource(src, { workspaceId: 'S', workspaceName: 's', memory: [] });
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });

    await expect(streamFork(src, tgt, {
      workspaceId: 'F', workspaceName: 'empty-fork', artifactDirectory: TARGET_ARTIFACTS, now: 7000,
    }, { untilMessageId: 'm1' })).resolves.toBeDefined();

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

    const frames = await sourceFrames(src, 'm1');
    const { artifacts } = reassemble(frames);
    expect(artifacts.length).toBeGreaterThan(0);

    await deliver(receiverFor(tgt, TARGET), frames);

    for (const artifact of artifacts) {
      expect(await tgt.vfs.exists(`${TARGET_ARTIFACTS}/${artifact.path}`)).toBe(true);
    }

    // The production reader resolves the re-rooted path and refuses a digest mismatch.
    expect((await readChain(tgt)).text[0]).toBe(spilled);
  });

  test('hosted fork identity preserves the owner established before the file copy', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedSource(src);

    await streamFork(src, tgt, {
      workspaceId: 'OWNED-FORK', workspaceName: 'owned-fork', artifactDirectory: TARGET_ARTIFACTS,
      ownerUserId: 'user-123', now: 9000,
    }, { untilMessageId: 'm2' });

    expect(tgt.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM workspace_identity`).toEqual([
      { owner_user_id: 'user-123' },
    ]);
  });

  test('repeating a completed delivery converges on exactly one copied history', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedSource(src);

    const target = {
      workspaceId: 'FINAL', workspaceName: 'recovered-fork', artifactDirectory: TARGET_ARTIFACTS, now: 99999,
    } as const;

    // A fresh activation retries a delivery whose acknowledgement was lost, under a new transfer id.
    await streamFork(src, tgt, target, { untilMessageId: 'm2', transferId: 'first' });
    await streamFork(src, tgt, target, { untilMessageId: 'm2', transferId: 'retry' });

    expect(tgt.sql<{ id: string }>`SELECT id FROM workspace_identity`).toEqual([{ id: 'FINAL' }]);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM fork_lineage`[0]?.c).toBe(1);
    expect(readForkLineage(tgt.sql)?.forkedAt).toBe(99999);
    // A redelivery replaces what the last attempt staged rather than duplicating the conversation.
    expect((await readChain(tgt)).ids.slice(0, 2)).toEqual(['m1', 'm2']);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM conversation_entries`[0]?.c).toBe(3);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM session_messages`[0]?.c).toBe(3);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM context_memberships`[0]?.c).toBe(2);
  });
});
