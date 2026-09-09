/**
 * A chat is a chat, so its history is reachable wherever the chat is.
 *
 * A hosted subordinate keeps its conversation in the workspace's ONE database,
 * scoped by its own `actor_id` — not in a database of its own. The root answers
 * through its public `getChatHistoryPage` RPC; a hosted child has no Think chat
 * RPC of its own, so its page is read through the same production read model
 * over the handle the directory issued. Either way, the rows, the cursor, and
 * the refusal below are production behavior, not fixture behavior.
 *
 * The read model itself is one function in core and is tested there over a real
 * store, cursor semantics included. What is asserted here is the thing core
 * cannot see: that the ROOT's page and a hosted SUBORDINATE's page read
 * different `actor_id` partitions of one table, and that pages of a transcript
 * longer than one window join up without dropping or repeating a message.
 */

import { describe, expect, test } from 'bun:test';
import { getChatHistoryPage, type ChatHistoryEntry, type Page, type SqlExecutor } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

/** A transcript reader: the root's public RPC, or the production read model
 * over a hosted child's directory-issued handle. */
interface Root {
  page(request?: { limit?: number; cursor?: { after: string } }): Promise<Page<ChatHistoryEntry>> | Page<ChatHistoryEntry>;
}

/**
 * `n` turns of conversation, oldest first, in one actor's partition.
 *
 * Written through the production `messages` columns, including `actor_id`: a
 * seed without the predicate column would put every fixture row in every
 * actor's conversation, which is exactly the leak this shape exists to catch.
 * `created_at` intentionally repeats across rows, because several messages of
 * one turn share a stamp and the walk must seek on `rowid` rather than time.
 */
function seed(sql: SqlExecutor, actorId: string, n: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `m${i}`;
    ids.push(id);
    void sql`INSERT INTO messages (actor_id, id, session_id, role, content, created_at)
      VALUES (${actorId}, ${id}, 'default', ${i % 2 === 0 ? 'assistant' : 'user'}, ${`message ${i}`}, ${i})`;
  }
  return ids;
}

/** Every page, oldest first — the walk the column performs. Returns the ids in
 * presentation order plus how many requests it took, so a walk that never
 * advances is a hang rather than a silently short answer. */
async function walk(root: Root, limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: { after: string } | undefined;
  for (let pages = 1; pages <= 50; pages++) {
    const page: Page<ChatHistoryEntry> = await root.page({ limit, cursor });
    ids.unshift(...page.items.map((m) => m.id));
    if (page.status === 'end') return { ids, pages };
    cursor = page.next;
  }
  throw new Error('the walk did not reach the beginning within 50 pages');
}

describe('a transcript longer than one window is reachable page by page', () => {
  test('on the workspace root', async () => {
    const root = orchestratorHarness();
    const seeded = seed(sqlOver(root.db), root.agent.observeRuntime().actor.actorId, 25);

    const walked = await walk({ page: (request) => root.agent.getChatHistoryPage(request) }, 10);

    expect(walked.ids).toEqual(seeded);
    // 25 over pages of 10: three requests, the last of which ran off the end.
    // Asserted because "it returned everything" is also true of one unbounded
    // read, and an unbounded read is the defect the contract replaced.
    expect(walked.pages).toBe(3);
  });

  test('and on a hosted subordinate, over its own actor partition', async () => {
    const workspace = orchestratorHarness();
    const child = await hostedSubordinateHarness(workspace, {
      name: 'transcript-child',
      displayName: 'Transcript Child',
      nameOrigin: 'user',
      mission: 'hold one conversation',
    });
    const sql = sqlOver(workspace.db);
    const seeded = seed(sql, child.actor.handle.actorId, 25);

    const walked = await walk({ page: (request) => getChatHistoryPage(sql, child.actor.handle, request) }, 10);

    expect(walked.ids).toEqual(seeded);
    expect(walked.pages).toBe(3);
  });

  /**
   * The two partitions are separate. Parent and child share one table, so a
   * missing predicate would read the parent's conversation in the child's chat
   * — the "delegation transcript leaked into the helper's chat" defect — and
   * reading nothing would be the one this ticket closes.
   */
  test('the actors do not read each other', async () => {
    const parent = orchestratorHarness();
    const child = await hostedSubordinateHarness(parent, {
      name: 'partition-child',
      displayName: 'Partition Child',
      nameOrigin: 'user',
      mission: 'hold a separate conversation',
    });
    const sql = sqlOver(parent.db);
    seed(sql, parent.agent.observeRuntime().actor.actorId, 4);

    expect((await walk({ page: (request) => parent.agent.getChatHistoryPage(request) }, 10)).ids)
      .toEqual(['m1', 'm2', 'm3', 'm4']);
    expect((await walk({
      page: (request) => getChatHistoryPage(sql, child.actor.handle, request),
    }, 10)).ids).toEqual([]);
  });

  /**
   * An empty transcript is a STATEMENT, not a failure. The subordinate column
   * renders "this subordinate's conversation starts here" from it, and that is
   * only honest if the store said so.
   */
  test('an empty conversation ends the walk instead of failing it', async () => {
    const workspace = orchestratorHarness();
    const child = await hostedSubordinateHarness(workspace, {
      name: 'empty-child',
      displayName: 'Empty Child',
      nameOrigin: 'user',
      mission: 'hold no conversation',
    });
    const page = getChatHistoryPage(sqlOver(workspace.db), child.actor.handle, { limit: 10 });

    expect(page.status).toBe('end');
    expect(page.items).toEqual([]);
  });

  /** A cursor naming a row this partition never had is refused, not answered with
   * the newest page — which would silently re-deliver history the caller
   * already holds and read as an exhausted conversation on the next page. */
  test('a cursor from another conversation is refused rather than answered', () => {
    const workspace = orchestratorHarness();
    const sql = sqlOver(workspace.db);
    const actorId = workspace.agent.observeRuntime().actor.actorId;
    seed(sql, actorId, 4);

    expect(() => getChatHistoryPage(sql, workspace.agent.observeRuntime().actor, {
      limit: 2,
      cursor: { after: 'not-in-this-store' },
    })).toThrow(/no longer in it/);
  });
});
