/**
 * The canonical conversation store: ONE default-chat authority per workspace,
 * and every reader served from it without any reconciliation write.
 *
 * The defect class this pins: the Cloudflare backend held two copies of the
 * default chat — the SDK's rich `assistant_messages` tree and a `messages`
 * projection kept level by a post-turn reconciler — and every reader except
 * the fork cut read the projection. An interrupted turn, or a sibling branch
 * that never became an ancestor of the newest leaf, existed in the tree and
 * was invisible to status counts, history paging, search and outcome
 * attribution until a reconciliation happened to project it. The store now
 * reads the authority directly, the reconciler is gone, and these tests hold
 * that completeness as data — including the reset case: deleting the former
 * projection cannot hide a row.
 */

import { describe, test, expect } from 'bun:test';
import {
  sessionTreeAncestry, chatPaneAncestry, snapshotWorkspaceForFork,
  conversationCount, conversationTurnPair, conversationPageRows,
  getChatHistoryPage, hasPaneStore,
  normalizeImportedConversation,
  initAllTables, writeSoul,
} from '../src/index';
import { ConversationSearchStore } from '../src/memory/conversation-search';
import {
  createTestWorkspace, makeSql, makeExecRaw, SDK_SESSION_DDL, type TestWorkspace,
} from './helpers';

/** A cloud-shaped workspace: production schema plus the SDK's pane store. */
function fresh(): TestWorkspace {
  const ws = createTestWorkspace();
  ws.execRaw(SDK_SESSION_DDL);
  return ws;
}

/** Append to the pane store the way the SDK's session provider does: the
 *  serialized UI message, parented on the caller's choice or the latest leaf. */
function paneAppend(
  { sql }: TestWorkspace,
  msg: { id: string; role: string; text: string; parentId?: string | null; at: string },
): void {
  const content = JSON.stringify({
    id: msg.id, role: msg.role, parts: [{ type: 'text', text: msg.text }],
  });
  const parent = msg.parentId !== undefined
    ? msg.parentId
    : sql<{ id: string }>`SELECT id FROM assistant_messages ORDER BY rowid DESC LIMIT 1`[0]?.id ?? null;
  void sql`
    INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
    VALUES (${msg.id}, ${''}, ${parent}, ${msg.role}, ${content}, ${msg.at})
  `;
}

/**
 * Two completed turns, an INTERRUPTED third turn (the SDK persisted both of
 * its messages; the retired turn-end summary never would have), and TWO
 * SIBLING branches off the second answer that never become ancestors of the
 * newest leaf. Everything below must see all eight rows.
 */
function seedCloudTranscript(ws: TestWorkspace): void {
  void ws.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SRC'}, ${'src'}, ${100})`;
  paneAppend(ws, { id: 'u1', role: 'user', text: 'first ask', parentId: null, at: '2026-08-16 22:00:00' });
  paneAppend(ws, { id: 'a1', role: 'assistant', text: 'first answer', at: '2026-08-16 22:00:01' });
  paneAppend(ws, { id: 'u2', role: 'user', text: 'second ask', at: '2026-08-16 22:02:00' });
  paneAppend(ws, { id: 'a2', role: 'assistant', text: 'second answer', at: '2026-08-16 22:02:01' });
  // The interrupted turn.
  paneAppend(ws, { id: 'u3', role: 'user', text: 'third ask', at: '2026-08-16 22:05:00' });
  paneAppend(ws, { id: 'leaf', role: 'assistant', text: 'partial answer', at: '2026-08-16 22:05:00' });
  // Sibling branches off a2 — invisible to any newest-leaf walk.
  paneAppend(ws, { id: 'sib1', role: 'assistant', text: 'branch take one', parentId: 'a2', at: '2026-08-16 22:03:00' });
  paneAppend(ws, { id: 'sib2', role: 'assistant', text: 'branch take two', parentId: 'a2', at: '2026-08-16 22:04:00' });
}

const ALL_IDS = ['u1', 'a1', 'u2', 'a2', 'u3', 'leaf', 'sib1', 'sib2'];

describe('the default chat is complete through every reader, with no mirror', () => {
  test('no reader ever wrote a projection row into `messages`', () => {
    const ws = fresh();
    seedCloudTranscript(ws);

    expect(hasPaneStore(ws.sql)).toBe(true);
    expect(conversationCount(ws.sql)).toBe(8);
    const mirrored = ws.sql<{ c: number }>`
      SELECT COUNT(*) AS c FROM messages WHERE session_id = 'default'`;
    expect(mirrored[0]!.c).toBe(0);
  });

  test('the paged history walk reaches the interrupted turn and both siblings', () => {
    const ws = fresh();
    seedCloudTranscript(ws);

    const ids: string[] = [];
    let cursor: { after: string } | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = getChatHistoryPage(ws.sql, { limit: 3, cursor });
      ids.unshift(...page.items.map((entry) => entry.id));
      // Page is a discriminated union: past the 'end' check, `next` exists.
      if (page.status === 'end') break;
      cursor = page.next;
    }
    expect(ids).toEqual(ALL_IDS);
  });

  test('status message counting, raw page shape and cursor anchoring agree', () => {
    const ws = fresh();
    seedCloudTranscript(ws);

    expect(conversationCount(ws.sql)).toBe(8);
    const page = conversationPageRows(ws.sql, { limit: 2 });
    expect(page.items.map((r) => r.id)).toEqual(['sib2', 'sib1']);
    // The anchor is resolvable inside the authority the cursor came from.
    expect(() => conversationPageRows(ws.sql, { limit: 2, cursor: { after: 'leaf' } }))
      .not.toThrow();
  });

  test('conversation search finds an interrupted turn and scrolls around it', () => {
    const ws = fresh();
    seedCloudTranscript(ws);
    const store = new ConversationSearchStore(ws.sql);

    const hits = store.search('partial answer');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.messageId).toBe('leaf');
    expect(hits[0]!.conversationId).toBe('default');

    const scroll = store.scroll('u3', 2)!;
    // Transcript order (insertion), not ancestry order — the same walk every
    // surface has always shown around an anchor.
    expect(scroll.messages.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'leaf', 'sib1']);
    expect(scroll.messages[2]!.anchor).toBe(true);
    expect(scroll.messages.find((m) => m.id === 'leaf')!.content).toBe('partial answer');
  });

  test('browse reports the one conversation with the full count and preview', () => {
    const ws = fresh();
    seedCloudTranscript(ws);
    const store = new ConversationSearchStore(ws.sql);

    const conversations = store.browse();
    expect(conversations.length).toBe(1);
    expect(conversations[0]!.conversationId).toBe('default');
    expect(conversations[0]!.messageCount).toBe(8);
    expect(conversations[0]!.preview).toBe('first ask');
  });

  test('outcome and take attribution resolve the interrupted turn pair', () => {
    const ws = fresh();
    seedCloudTranscript(ws);

    const pair = conversationTurnPair(ws.sql, 'leaf');
    expect(pair).toBeDefined();
    expect(pair!.sessionId).toBe('default');
    expect(pair!.request).toBe('third ask');
    expect(pair!.response).toBe('partial answer');
    expect(pair!.startedAtMs).toBe(Date.parse('2026-08-16T22:05:00Z'));
    expect(pair!.endedAtMs).toBe(Date.parse('2026-08-16T22:05:00Z'));
    // A sibling attributes to its own parent edge, not to the newest leaf's.
    // The parent edge IS the request side: a sibling branched off the
    // assistant answer attributes to that answer, exactly like the old join.
    expect(conversationTurnPair(ws.sql, 'sib2')!.request).toBe('second answer');
  });

  test('fork ancestry cuts the tree the chat pane renders, siblings excluded', async () => {
    const ws = fresh();
    seedCloudTranscript(ws);
    await writeSoul(ws.vfs, ws.sql, 'p');

    const snapshot = await snapshotWorkspaceForFork(ws.sql, ws.vfs, 'leaf');
    expect(snapshot.assistantMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'leaf']);
    expect(sessionTreeAncestry(ws.sql, 'sib1').map((n) => n.id))
      .toEqual(['u1', 'a1', 'u2', 'a2', 'sib1']);
  });
});

describe('resetting the former projection cannot hide rows', () => {
  test('every reader still completes after the mirror rows are deleted', () => {
    const ws = fresh();
    seedCloudTranscript(ws);
    // Simulate the surviving-workspace shape at its worst: stale projection
    // rows exist, then go away. Nothing readable may depend on either state.
    void ws.sql`DELETE FROM messages WHERE session_id = 'default'`;

    expect(conversationCount(ws.sql)).toBe(8);
    const store = new ConversationSearchStore(ws.sql);
    expect(store.search('branch take two').map((h) => h.messageId)).toContain('sib2');
    expect(store.scroll('leaf', 1)!.messages.map((m) => m.id)).toEqual(['u3', 'leaf', 'sib1']);
    expect(conversationTurnPair(ws.sql, 'leaf')!.response).toBe('partial answer');
    const page = getChatHistoryPage(ws.sql, { limit: 200 });
    expect(page.items.length).toBe(8);
  });
});

describe('the CLI transcript answers the same questions from `messages`', () => {
  /** A local-shaped workspace: no SDK store, rows written the way the CLI
   *  backend writes them (plain text, ms stamps, metadata column). */
  function cliWorkspace(): TestWorkspace {
    const ws = createTestWorkspace();
    void ws.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'L'}, ${'local'}, ${100})`;
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'cu1'}, ${'default'}, ${null}, ${'user'}, ${'first ask'}, ${1_000})`;
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'ca1'}, ${'default'}, ${'cu1'}, ${'assistant'}, ${'first answer'}, ${2_000})`;
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'cu2'}, ${'default'}, ${'ca1'}, ${'user'}, ${'second ask'}, ${3_000})`;
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
      VALUES (${'csys'}, ${'default'}, ${'cu2'}, ${'user'}, ${'wake notice'})`;
    return ws;
  }

  test('count, paging, search, attribution and ancestry agree with the cloud readers', () => {
    const ws = cliWorkspace();
    expect(hasPaneStore(ws.sql)).toBe(false);
    expect(conversationCount(ws.sql)).toBe(4);

    const store = new ConversationSearchStore(ws.sql);
    // Strict all-term hit first, then the ranked partial that fills the page:
    // 'first ask' shares one term, 'second ask' and 'wake notice' share none.
    expect(store.search('first answer').map((h) => h.messageId)).toEqual(['ca1', 'cu1']);
    const scroll = store.scroll('cu2', 5)!;
    expect(scroll.messages.map((m) => m.id)).toEqual(['cu1', 'ca1', 'cu2', 'csys']);

    const pair = conversationTurnPair(ws.sql, 'ca1');
    expect(pair!.sessionId).toBe('default');
    expect(pair!.request).toBe('first ask');
    expect(pair!.startedAtMs).toBe(1_000);
    expect(pair!.endedAtMs).toBe(2_000);

    expect(sessionTreeAncestry(ws.sql, 'csys').map((n) => n.id))
      .toEqual(['cu1', 'ca1', 'cu2', 'csys']);

    const page = getChatHistoryPage(ws.sql, { limit: 10 });
    expect(page.status).toBe('end');
    expect(page.items.map((e) => e.id)).toEqual(['cu1', 'ca1', 'cu2', 'csys']);
  });

  test('a harness-stamped row renders as system through written markers only', () => {
    const ws = cliWorkspace();
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, metadata)
      VALUES (${`prog-${1}`}, ${'default'}, ${'csys'}, ${'user'}, ${'background job done'},
              ${JSON.stringify({ kinuAuthor: 'harness' })})`;

    const page = getChatHistoryPage(ws.sql, { limit: 10 });
    expect(page.items.find((e) => e.id === 'prog-1')!.role).toBe('system');
  });

  test('non-default sessions stay isolated from every default-chat reader', () => {
    const ws = cliWorkspace();
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'n1'}, ${'mcts'}, ${null}, ${'assistant'}, ${'a search node thought'}, ${500})`;
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'p1'}, ${'peer:atlas'}, ${null}, ${'user'}, ${'a peer exchange'}, ${600})`;

    expect(conversationCount(ws.sql)).toBe(4);
    const store = new ConversationSearchStore(ws.sql);
    expect(store.search('search node')).toEqual([]);
    expect(store.search('peer exchange').map((h) => h.conversationId)).toEqual(['peer:atlas']);
    const browse = store.browse().map((c) => c.conversationId).sort();
    expect(browse).toEqual(['default', 'peer:atlas']);
    // A non-default anchor is still reachable — it is a different tree, not a
    // hidden one.
    expect(store.scroll('n1', 1)!.messages.map((m) => m.id)).toEqual(['n1']);
    expect(sessionTreeAncestry(ws.sql, 'n1')).toEqual([]);
  });
});

describe('the tree walks stay sound', () => {
  test('a sibling branch is not inherited — only the cut point\'s ancestry', () => {
    const ws = fresh();
    paneAppend(ws, { id: 'root', role: 'user', text: 'pick one', parentId: null, at: '2026-08-16 22:00:00' });
    paneAppend(ws, { id: 'left', role: 'assistant', text: 'take one', parentId: 'root', at: '2026-08-16 22:00:00' });
    paneAppend(ws, { id: 'right', role: 'assistant', text: 'take two', parentId: 'root', at: '2026-08-16 22:00:00' });

    expect(sessionTreeAncestry(ws.sql, 'left').map((n) => n.id)).toEqual(['root', 'left']);
    expect(sessionTreeAncestry(ws.sql, 'right').map((n) => n.id)).toEqual(['root', 'right']);
  });

  test('a walk terminates on a cycle instead of hanging', () => {
    const ws = createTestWorkspace();
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'loop'}, ${'default'}, ${'loop'}, ${'user'}, ${'self-parented'}, ${1_000})`;

    expect(sessionTreeAncestry(ws.sql, 'loop').length).toBeGreaterThan(0);
  });

  test('without the pane store the same cloud id is unresolvable — honestly', async () => {
    const ws = fresh();
    seedCloudTranscript(ws);
    await writeSoul(ws.vfs, ws.sql, 'p');
    ws.execRaw('DROP TABLE assistant_messages');

    await expect(snapshotWorkspaceForFork(ws.sql, ws.vfs, 'leaf'))
      .rejects.toThrow('fork point not found: message id "leaf" does not exist in source');
  });

  test('chatPaneAncestry answers empty where the pane store does not exist', () => {
    const ws = createTestWorkspace();
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'cu1'}, ${'default'}, ${null}, ${'user'}, ${'cli message'}, ${1_000})`;

    expect(chatPaneAncestry(ws.sql, 'cu1')).toEqual([]);
  });
});

/** The bare-schema shape (initAllTables without the workspace bundle) stays
 *  readable for the CLI paths that construct their own handles. */
describe('bare schema', () => {
  test('the store reads a hand-initialized workspace', () => {
    const db = new (require('bun:sqlite').Database)(':memory:');
    const sql = makeSql(db);
    initAllTables(makeExecRaw(db), sql);
    void sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'m1'}, ${'default'}, ${null}, ${'user'}, ${'cli message'}, ${1_000})`;

    expect(conversationCount(sql)).toBe(1);
    expect(sessionTreeAncestry(sql, 'm1').map((n) => n.id)).toEqual(['m1']);
  });
});

describe('a cloud export imported into a LOCAL workspace', () => {
  /** The import shape: pane rows present (as a cloud archive carries them),
   *  nothing in `messages` yet. */
  function imported(): TestWorkspace {
    const ws = createTestWorkspace();
    ws.execRaw(SDK_SESSION_DDL);
    void ws.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'IMP'}, ${'imported'}, ${100})`;
    paneAppend(ws, { id: 'cu1', role: 'user', text: 'first ask', parentId: null, at: '2026-08-16 22:00:00' });
    paneAppend(ws, { id: 'ca1', role: 'assistant', text: 'first answer', parentId: 'cu1', at: '2026-08-16 22:00:01' });
    return ws;
  }

  test('normalize-once projects the pane into `messages` and drops it', () => {
    const ws = imported();
    expect(normalizeImportedConversation(ws.sql)).toBe(2);
    // Second run is a no-op — the pane is gone.
    expect(normalizeImportedConversation(ws.sql)).toBe(0);

    expect(hasPaneStore(ws.sql)).toBe(false);
    const rows = ws.sql<{ id: string; content: string; created_at: number }>`
      SELECT id, content, created_at FROM messages WHERE session_id = 'default' ORDER BY rowid`;
    expect(rows.map((r) => r.id)).toEqual(['cu1', 'ca1']);
    expect(rows[0]!.content).toBe('first ask');
    expect(rows[0]!.created_at).toBe(Date.parse('2026-08-16T22:00:00Z'));
  });

  test('a NEW local turn continues the imported history through every reader', () => {
    const ws = imported();
    normalizeImportedConversation(ws.sql);
    // The way the CLI backend writes a turn: plain rows on the local authority.
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'lu1'}, ${'default'}, ${'ca1'}, ${'user'}, ${'next ask'}, ${1_500_000})`;

    expect(conversationCount(ws.sql)).toBe(3);
    const page = getChatHistoryPage(ws.sql, { limit: 10 });
    expect(page.items.map((e) => e.id)).toEqual(['cu1', 'ca1', 'lu1']);
    expect(conversationTurnPair(ws.sql, 'lu1')!.request).toBe('first answer');
    const store = new ConversationSearchStore(ws.sql);
    // 'first ask' shares `ask` and fills the page behind the strict hit;
    // 'first answer' shares neither term and stays out.
    expect(store.search('next ask').map((h) => h.messageId)).toEqual(['lu1', 'cu1']);
    expect(sessionTreeAncestry(ws.sql, 'lu1').map((n) => n.id)).toEqual(['cu1', 'ca1', 'lu1']);
  });
});

describe('the derived search index rebuilds on every invisible mutation', () => {
  test('session reassignment leaves no ghost under the old conversation', () => {
    const ws = createTestWorkspace();
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'m1'}, ${'default'}, ${null}, ${'user'}, ${'kubernetes ingress config'}, ${1000})`;
    let store = new ConversationSearchStore(ws.sql);
    expect(store.search('kubernetes')[0]!.conversationId).toBe('default');

    // What the CLI fork does: move the tail into an archive session.
    void ws.sql`UPDATE messages SET session_id = ${'archive-x'} WHERE id = ${'m1'}`;
    // Source-table trigger bumps the revision; the same store rebuilds on read.
    expect(store.search('kubernetes').map((h) => h.conversationId)).toEqual(['archive-x']);
  });

  test('same-length update, delete, clear and equal-count reseed rebuild without a callsite hint', () => {
    const ws = createTestWorkspace();
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'d1'}, ${'default'}, ${null}, ${'assistant'}, ${'wrangler staging deploy'}, ${1000})`;
    let store = new ConversationSearchStore(ws.sql);
    expect(store.search('wrangler').length).toBe(1);

    // UPDATE is same-rowid and same-count; the source trigger still invalidates.
    void ws.sql`UPDATE messages SET content = ${'docker staging deploy'} WHERE id = ${'d1'}`;
    expect(store.search('wrangler')).toEqual([]);
    expect(store.search('docker').length).toBe(1);

    // DELETE is the clear-path primitive.
    void ws.sql`DELETE FROM messages WHERE id = ${'d1'}`;
    expect(store.search('docker')).toEqual([]);

    // Reseed at the SAME count and a direct SDK-style INSERT both rebuild.
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'d2'}, ${'default'}, ${null}, ${'assistant'}, ${'fresh replacement'}, ${1000})`;
    expect(store.search('fresh').length).toBe(1);
    void ws.sql`DELETE FROM messages`;
    expect(store.search('fresh')).toEqual([]);
  });

  test('retired mirror rows never answer a pane-mode scroll or attribution', () => {
    const ws = fresh();
    seedCloudTranscript(ws);
    // A surviving-workspace leftover: the old projection's copy of a turn,
    // under an id the pane store does not know.
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'ghost'}, ${'default'}, ${'u3'}, ${'assistant'}, ${'STALE projection text'}, ${1_000})`;

    const scroll = store(ws.sql).scroll('ghost', 2);
    expect(scroll).toBeNull();
    expect(conversationTurnPair(ws.sql, 'ghost')).toBeUndefined();
  });

  test('a pane miss finds a non-default turn without reviving a stale default mirror', () => {
    const ws = fresh();
    seedCloudTranscript(ws);
    void ws.sql`
      INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'mcts-u'}, ${'mcts'}, ${null}, ${'user'}, ${'score this candidate'}, ${2_000})`;
    void ws.sql`
      INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'mcts-a'}, ${'mcts'}, ${'mcts-u'}, ${'assistant'}, ${'candidate score'}, ${2_001})`;
    void ws.sql`
      INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'stale'}, ${'default'}, ${null}, ${'assistant'}, ${'retired mirror'}, ${2_002})`;

    expect(conversationTurnPair(ws.sql, 'mcts-a')).toMatchObject({
      sessionId: 'mcts',
      request: 'score this candidate',
      response: 'candidate score',
    });
    expect(conversationTurnPair(ws.sql, 'stale')).toBeUndefined();
  });

  test('a pane clear refuses a stale mirror fork point', async () => {
    const ws = fresh();
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'old'}, ${'default'}, ${null}, ${'user'}, ${'retired mirror'}, ${1000})`;
    await writeSoul(ws.vfs, ws.sql, 'p');
    // The authoritative pane exists but was cleared. `old` must not fall back
    // into the retired messages mirror and become forkable again.
    await expect(snapshotWorkspaceForFork(ws.sql, ws.vfs, 'old'))
      .rejects.toThrow('fork point not found: message id "old" does not exist in source');
  });

  /** A fresh search store over `sql` — a new instance exercises the full
   *  ensure/rebuild path rather than this file's earlier caches. */
  function store(sql: ReturnType<typeof createTestWorkspace>['sql']): ConversationSearchStore {
    return new ConversationSearchStore(sql);
  }
});
