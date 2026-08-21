/**
 * A chat is a chat, so its history is reachable wherever the chat is.
 *
 * `getChatHistoryPage` was declared on `OrchestratorAgent` alone. A subordinate
 * facet runs `initWorkspaceSchema` against its OWN `ctx.storage.sql`, so it has
 * its own `assistant_messages` and its own conversation — and nothing could ask
 * for a page of it. The consequence in the product was exact: the subordinate
 * column drove `useGrowingScroll` with `fetched: null` and no `onReachEdge`, so
 * everything older than the agents SDK's hydration window (a bounded newest
 * slice governed by `hydrationByteBudget`) was unreachable. Not slow to reach —
 * unreachable, with no affordance saying so.
 *
 * The read model itself is one function in core and is tested there over a real
 * store, cursor semantics included. What is asserted here is the thing core
 * cannot see: that BOTH roots answer it, over their own storage, and that the
 * pages of a transcript longer than one window join up without dropping or
 * repeating a message.
 *
 * Behaviour through the public classes. The source-level ratchet that stops a
 * second copy appearing on a root lives in unit-rpc-surface.test.ts beside the
 * other four control-plane members.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { orchestratorHarness, subordinateHarness } from './helpers/actor-harness';
import type { ChatHistoryEntry, Page } from '@kinu.run/core';

/** A root this suite drives: either actor, reached only through the RPC. */
interface Root {
  readonly db: Database;
  readonly agent: { getChatHistoryPage(request?: { limit?: number; cursor?: { after: string } }): Promise<Page<ChatHistoryEntry>> };
}

/**
 * `n` turns of conversation, oldest first.
 *
 * The table is created here because the agents SDK's session provider creates
 * it on its first append, so an actor that has not taken a turn has none — the
 * state `readInheritedContext` already checks for. Written through the SDK's own
 * column list, so `created_at` is the whole-second `DATETIME` default a real
 * turn gets. That is the reason the walk seeks on `rowid`: several messages of
 * one turn share a second, and a timestamp cursor over ties has no defined
 * membership, never mind order.
 */
function seed(db: Database, n: number): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT '', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const ids: string[] = [];
  const append = db.prepare(
    `INSERT INTO assistant_messages (id, session_id, role, content, created_at)
     VALUES (?, '', ?, ?, '2026-01-01 00:00:00')`,
  );
  for (let i = 1; i <= n; i++) {
    const id = `m${i}`;
    ids.push(id);
    append.run(id, i % 2 === 0 ? 'assistant' : 'user', `message ${i}`);
  }
  return ids;
}

/** Every page, oldest first — the walk the column performs. Returns the ids in
 *  presentation order plus how many requests it took, so a walk that never
 *  advances is a hang rather than a silently short answer. */
async function walk(root: Root, limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: { after: string } | undefined;
  for (let pages = 1; pages <= 50; pages++) {
    const page: Page<ChatHistoryEntry> = await root.agent.getChatHistoryPage({ limit, cursor });
    ids.unshift(...page.items.map((m) => m.id));
    if (page.status === 'end') return { ids, pages };
    cursor = page.next;
  }
  throw new Error('the walk did not reach the beginning within 50 pages');
}

describe('a transcript longer than one window is reachable page by page', () => {
  test('on the workspace root', async () => {
    const root = orchestratorHarness();
    const seeded = seed(root.db, 25);

    const walked = await walk(root, 10);

    expect(walked.ids).toEqual(seeded);
    // 25 over pages of 10: three requests, the last of which ran off the end.
    // Asserted because "it returned everything" is also true of one unbounded
    // read, and an unbounded read is the defect the contract replaced.
    expect(walked.pages).toBe(3);
  });

  test('and on a subordinate root, over its own storage', async () => {
    const root = subordinateHarness();
    const seeded = seed(root.db, 25);

    const walked = await walk(root, 10);

    expect(walked.ids).toEqual(seeded);
    expect(walked.pages).toBe(3);
  });

  /**
   * The two stores are separate. A subordinate is a facet with its own SQL, so
   * its conversation is its own — reading the parent's here would be the
   * "delegation transcript leaked into the helper's chat" defect, and reading
   * nothing would be the one this ticket closes.
   */
  test('the roots do not read each other', async () => {
    const parent = orchestratorHarness();
    const child = subordinateHarness();
    seed(parent.db, 4);

    expect((await walk(parent, 10)).ids).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect((await walk(child, 10)).ids).toEqual([]);
  });

  /**
   * An empty transcript is a STATEMENT, not a failure. The subordinate column
   * renders "this subordinate's conversation starts here" from it, and that is
   * only honest if the store said so.
   */
  test('an empty conversation ends the walk instead of failing it', async () => {
    const page = await subordinateHarness().agent.getChatHistoryPage({ limit: 10 });

    expect(page.status).toBe('end');
    expect(page.items).toEqual([]);
  });

  /** A cursor naming a row this store never had is refused, not answered with
   *  the newest page — which would silently re-deliver history the caller
   *  already holds and read as an exhausted conversation on the next page. */
  test('a cursor from another conversation is refused rather than answered', async () => {
    const root = subordinateHarness();
    seed(root.db, 4);

    await expect(root.agent.getChatHistoryPage({ limit: 2, cursor: { after: 'not-in-this-store' } }))
      .rejects.toThrow(/no longer in it/);
  });
});
