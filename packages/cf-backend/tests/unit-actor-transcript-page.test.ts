/**
 * The root's and a hosted subordinate's history pages read different `actor_id` partitions of one table,
 * and multi-window pages join without dropping or repeating a message. Cursor semantics are tested in core.
 */

import { describe, expect, test } from 'bun:test';
import { getChatHistoryPage, CHAT_SESSION_ID, type ActorHandle, type SessionHistory, type ChatHistoryEntry, type Page } from '@kinu.run/core';
import { hostedExplorationHarness, hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

/** The root's public RPC, or the production read model over a hosted child's handle. */
interface Root {
  page(request?: { limit?: number; cursor?: { after: string }; actor?: string }): Promise<Page<ChatHistoryEntry>> | Page<ChatHistoryEntry>;
}

async function seed(actor: ActorHandle, history: SessionHistory, n: number, prefix = 'm'): Promise<string[]> {
  const store = history.transcript(CHAT_SESSION_ID);
  const ids: string[] = [];

  for (let i = 1; i <= n; i++) {
    const id = prefix + i;
    const reference = await history.append({ id, turnId: id, message: { role: 'user', content: 'message ' + i }, origin: 'input', assertOwner: () => actor.assertCurrent() });
    const entry = await store.prepareUser({ id, turnId: id, message: reference });
    store.appendUser(entry);
    ids.push(id);
  }

  return ids;
}

/** Every page, oldest first, with the request count, so a walk that never advances is a hang. */
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

    await root.agent.activateActor();
    const actor = root.agent.observeRuntime().actor;
    const seeded = await seed(actor, root.agent.observeActorHost().bindStores(actor).stores.history, 25);

    const walked = await walk({ page: (request) => root.agent.getChatHistoryPage(request) }, 10);

    expect(walked.ids).toEqual(seeded);
    // 25 over pages of 10: three requests, so an unbounded single read fails.
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

    const seeded = await seed(child.actor.handle, child.actor.stores.history, 25);
    const walked = await walk({ page: (request) => getChatHistoryPage(child.actor.stores.history.transcript(CHAT_SESSION_ID), request) }, 10);

    expect(walked.ids).toEqual(seeded);
    expect(walked.pages).toBe(3);
  });

  /** Parent and child share one table; a missing predicate leaks the parent's conversation. */
  test('the actors do not read each other', async () => {
    const parent = orchestratorHarness();

    const child = await hostedSubordinateHarness(parent, {
      name: 'partition-child',
      displayName: 'Partition Child',
      nameOrigin: 'user',
      mission: 'hold a separate conversation',
    });

    await parent.agent.activateActor();
    const actor = parent.agent.observeRuntime().actor;
    await seed(actor, parent.agent.observeActorHost().bindStores(actor).stores.history, 4);

    expect((await walk({ page: (request) => parent.agent.getChatHistoryPage(request) }, 10)).ids)
      .toEqual(['m1', 'm2', 'm3', 'm4']);
    expect((await walk({
      page: (request) => getChatHistoryPage(child.actor.stores.history.transcript(CHAT_SESSION_ID), request),
    }, 10)).ids).toEqual([]);
  });

  /** An empty transcript is a statement the subordinate column renders, not a failure. */
  test('an empty conversation ends the walk instead of failing it', async () => {
    const workspace = orchestratorHarness();

    const child = await hostedSubordinateHarness(workspace, {
      name: 'empty-child',
      displayName: 'Empty Child',
      nameOrigin: 'user',
      mission: 'hold no conversation',
    });

    const page = await getChatHistoryPage(child.actor.stores.history.transcript(CHAT_SESSION_ID), { limit: 10 });

    expect(page.status).toBe('end');
    expect(page.items).toEqual([]);
  });

  /** An unknown cursor is refused, not answered with the newest page (which re-delivers history). */
  test('a cursor from another conversation is refused rather than answered', async () => {
    const workspace = orchestratorHarness();
    const actor = workspace.agent.observeRuntime().actor;
    const history = workspace.agent.observeActorHost().bindStores(actor).stores.history;
    await seed(actor, history, 4);

    await expect(getChatHistoryPage(history.transcript(CHAT_SESSION_ID), {
      limit: 2, cursor: { after: 'not-in-this-store' },
    })).rejects.toThrow(/no longer in it/);
  });

  /**
   * A pane's walk through the RPC: an actor pane names its own actor id; the root's pane names none.
   * Id spaces are disjoint, so a leak shows in the assertion's message.
   */
  test("an actor pane's walk reads its own actor, addressed by the id its snapshot carries", async () => {
    const workspace = orchestratorHarness();

    const child = await hostedSubordinateHarness(workspace, {
      name: 'paged-child',
      displayName: 'Paged Child',
      nameOrigin: 'user',
      mission: 'hold the conversation its own pane pages',
    });

    await workspace.agent.activateActor();
    const actor = workspace.agent.observeRuntime().actor;
    await seed(actor, workspace.agent.observeActorHost().bindStores(actor).stores.history, 4, 'root');
    const seeded = await seed(child.actor.handle, child.actor.stores.history, 25);

    const walked = await walk({
      page: (request) => workspace.agent.getChatHistoryPage({ ...request, actor: child.actor.handle.actorId }),
    }, 10);

    expect(walked.ids).toEqual(seeded);
    expect(walked.pages).toBe(3);
  });

  /** An id this workspace does not host is refused, not answered with the root's page. */
  test('an actor id this workspace does not host is refused', async () => {
    const workspace = orchestratorHarness();
    await workspace.agent.activateActor();

    await expect(workspace.agent.getChatHistoryPage({ limit: 10, actor: 'actor-of-another-workspace' }))
      .rejects.toThrow(/not registered in this workspace/);
  });

  /** An exploration head is not a chat (its transcript is the head journal): refused. */
  test('a hosted actor with no chat pane is refused', async () => {
    const workspace = orchestratorHarness();
    await workspace.agent.activateActor();
    const head = await hostedExplorationHarness(workspace, 'head', 'head-without-a-pane');

    await expect(workspace.agent.getChatHistoryPage({ limit: 10, actor: head.actor.handle.actorId }))
      .rejects.toThrow(/does not name a chat/);
  });
});
