/**
 * The session tree, the fork failure it was hiding, and the cost gate.
 *
 * The operator's report was `fork point not found: message id "HlWP2xvw90yUD9Xk"
 * does not exist in source` on a message the chat pane was showing him. The pane
 * hydrates from the SDK's message DAG (`assistant_messages`); the fork resolved
 * its cut point in `messages`, which was written by a turn-end summary that ran
 * only on the completed path. These tests hold that gap as data, prove the cut
 * now reads the store the pane renders, and pin the per-turn cost of the
 * projection so nobody reintroduces a table scan on the hot Durable Object.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  reconcileSessionTree, sessionTreeAncestry, chatPaneAncestry, snapshotWorkspaceForFork,
  initAllTables, writeSoul,
} from '../src/index.js';
import type { SqlExecutor } from '../src/types/primitives.js';
import {
  createTestWorkspace, makeSql, makeExecRaw, SDK_SESSION_DDL, type TestWorkspace,
} from './helpers.js';

/** The production workspace schema plus the SDK's own session store.
 *
 *  It was a hand-picked subset built on `initAllTables`, which does not create
 *  `memory_chunks` — so `snapshotWorkspaceForFork` had to tolerate an absence
 *  only this harness produced, and that tolerance is what let a fork drop the
 *  parent's memory index in production. */
function fresh(): TestWorkspace {
  const ws = createTestWorkspace();
  ws.execRaw(SDK_SESSION_DDL);
  return ws;
}

/** Append to the SDK's store the way it does: the serialized UI message,
 *  parented on the caller's choice or on the latest leaf. */
function sdkAppend(
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

/** What the deleted turn-end summary wrote: the last user message with a NULL
 *  parent and the final assistant message, for completed turns only. */
function legacySummary(
  { sql }: TestWorkspace,
  turn: { userId: string; userText: string; assistantId: string; assistantText: string; at: number },
): void {
  void sql`INSERT OR IGNORE INTO messages (id, session_id, parent_id, role, content, created_at)
    VALUES (${turn.userId}, ${'default'}, ${null}, ${'user'}, ${turn.userText}, ${turn.at})`;
  void sql`INSERT OR IGNORE INTO messages (id, session_id, parent_id, role, content, created_at)
    VALUES (${turn.assistantId}, ${'default'}, ${turn.userId}, ${'assistant'}, ${turn.assistantText}, ${turn.at + 1})`;
}

/**
 * Two completed turns, then an interrupted one — the operator's workspace shape.
 * He resumed a poisoned session, so the turn before his fork attempt never
 * reached "completed" and the summary never ran for it.
 */
function seedInterruptedSession(ws: TestWorkspace): void {
  void ws.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SRC'}, ${'src'}, ${100})`;
  sdkAppend(ws, { id: 'u1', role: 'user', text: 'first ask', parentId: null, at: '2026-08-16 22:00:00' });
  sdkAppend(ws, { id: 'a1', role: 'assistant', text: 'first answer', at: '2026-08-16 22:00:01' });
  legacySummary(ws, {
    userId: 'u1', userText: 'first ask', assistantId: 'a1', assistantText: 'first answer', at: 1_000,
  });
  sdkAppend(ws, { id: 'u2', role: 'user', text: 'second ask', at: '2026-08-16 22:02:00' });
  sdkAppend(ws, { id: 'a2', role: 'assistant', text: 'second answer', at: '2026-08-16 22:02:00' });
  legacySummary(ws, {
    userId: 'u2', userText: 'second ask', assistantId: 'a2', assistantText: 'second answer', at: 2_000,
  });
  // The interrupted turn. The SDK persisted both messages; the summary did not.
  sdkAppend(ws, { id: 'u3', role: 'user', text: 'third ask', at: '2026-08-16 22:05:00' });
  sdkAppend(ws, { id: 'HlWP2xvw90yUD9Xk', role: 'assistant', text: 'partial', at: '2026-08-16 22:05:00' });
}

/** The whole chain, root first — what a fork at the leaf must inherit. */
const FULL_CHAIN = ['u1', 'a1', 'u2', 'a2', 'u3', 'HlWP2xvw90yUD9Xk'];

describe('the fork failure the operator reported', () => {
  test('the id the chat pane offers is genuinely absent from `messages`', () => {
    const ws = fresh();
    seedInterruptedSession(ws);

    // The pane can offer it — it is a node of the SDK's tree.
    expect(chatPaneAncestry(ws.sql, 'HlWP2xvw90yUD9Xk').map((r) => r.id)).toEqual(FULL_CHAIN);
    // And the table the old cut resolved against has never heard of it. This
    // single row-count IS the operator's bug.
    expect(ws.sql<{ id: string }>`
      SELECT id FROM messages WHERE id = ${'HlWP2xvw90yUD9Xk'} AND session_id = 'default'
    `).toEqual([]);
  });

  test('the fork resolves it anyway, because the cut reads the store the pane renders', async () => {
    const ws = fresh();
    seedInterruptedSession(ws);
    await writeSoul(ws.vfs, ws.sql, 'p');

    // No projection has run. The cut does not need one.
    const snapshot = await snapshotWorkspaceForFork(ws.sql, ws.vfs, 'HlWP2xvw90yUD9Xk');
    expect(snapshot.messages.map((m) => m.id)).toEqual(FULL_CHAIN);
    expect(snapshot.assistantMessages.map((m) => m.id)).toEqual(FULL_CHAIN);
    expect(snapshot.cut.messageId).toBe('HlWP2xvw90yUD9Xk');
  });

  test('cut the wire: without the SDK store to read, the same id is unresolvable', async () => {
    const ws = fresh();
    seedInterruptedSession(ws);
    await writeSoul(ws.vfs, ws.sql, 'p');
    // Take away the store the pane renders and the cut falls back to `messages`,
    // which is the exact code path that produced the operator's error.
    ws.execRaw('DROP TABLE assistant_messages');

    await expect(snapshotWorkspaceForFork(ws.sql, ws.vfs, 'HlWP2xvw90yUD9Xk'))
      .rejects.toThrow('fork point not found: message id "HlWP2xvw90yUD9Xk" does not exist in source');
  });

  test('a sibling branch is not inherited — only the cut point\'s ancestry', () => {
    const ws = fresh();
    sdkAppend(ws, { id: 'root', role: 'user', text: 'pick one', parentId: null, at: '2026-08-16 22:00:00' });
    sdkAppend(ws, { id: 'left', role: 'assistant', text: 'take one', parentId: 'root', at: '2026-08-16 22:00:00' });
    sdkAppend(ws, { id: 'right', role: 'assistant', text: 'take two', parentId: 'root', at: '2026-08-16 22:00:00' });

    expect(sessionTreeAncestry(ws.sql, 'left').map((n) => n.id)).toEqual(['root', 'left']);
    expect(sessionTreeAncestry(ws.sql, 'right').map((n) => n.id)).toEqual(['root', 'right']);
  });
});

describe('reconcileSessionTree', () => {
  test('projects the interrupted turn the summary skipped, with its real edges', () => {
    const ws = fresh();
    seedInterruptedSession(ws);

    expect(reconcileSessionTree(ws.sql)).toBe(2);

    const rows = ws.sql<{ id: string; parent_id: string | null; content: string }>`
      SELECT id, parent_id, content FROM messages WHERE session_id = 'default' ORDER BY rowid`;
    expect(rows.map((r) => r.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'HlWP2xvw90yUD9Xk']);
    expect(rows[4]!.parent_id).toBe('a2');
    expect(rows[5]!.parent_id).toBe('u3');
    // Flattened for messages_fts and the evolution outcome join, not the raw
    // UI-message JSON the pane renders.
    expect(rows[5]!.content).toBe('partial');
  });

  test('is idempotent and costs nothing once level', () => {
    const ws = fresh();
    seedInterruptedSession(ws);

    expect(reconcileSessionTree(ws.sql)).toBe(2);
    expect(reconcileSessionTree(ws.sql)).toBe(0);
    expect(reconcileSessionTree(ws.sql)).toBe(0);
  });

  test('leaves the MCTS session tree alone — it is a different tree', () => {
    const ws = fresh();
    seedInterruptedSession(ws);
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'n1'}, ${'mcts'}, ${null}, ${'assistant'}, ${'a search node'}, ${500})`;

    reconcileSessionTree(ws.sql);

    expect(ws.sql<{ session_id: string }>`
      SELECT session_id FROM messages WHERE id = 'n1'`[0]!.session_id).toBe('mcts');
    expect(sessionTreeAncestry(ws.sql, 'n1')).toEqual([]);
  });

  test('does nothing where the SDK store does not exist (the CLI writes `messages` itself)', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initAllTables(makeExecRaw(db), sql);
    void sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'m1'}, ${'default'}, ${null}, ${'user'}, ${'cli message'}, ${1_000})`;

    expect(reconcileSessionTree(sql)).toBe(0);
    expect(sessionTreeAncestry(sql, 'm1').map((n) => n.id)).toEqual(['m1']);
  });

  test('a walk terminates on a cycle instead of hanging', () => {
    const ws = fresh();
    void ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'loop'}, ${'default'}, ${'loop'}, ${'user'}, ${'self-parented'}, ${1_000})`;
    ws.execRaw('DROP TABLE assistant_messages');

    expect(sessionTreeAncestry(ws.sql, 'loop').length).toBeGreaterThan(0);
  });
});

/**
 * The cost gate. `reconcileSessionTree` runs in `onChatResponse`, on the Durable
 * Object that also serves every read, and that object is single-threaded — a
 * long write is a long queue for every subsequent read. There is a live defect
 * where a read times out at 30s and recovers on refresh, so per-turn work that
 * grows with the transcript is not a style question here.
 *
 * These tests measure statements executed rather than wall time, so they mean
 * the same thing on any machine and go red on a reintroduced table scan.
 */
describe('the projection is bounded by the turn, not by the transcript', () => {
  /** A SqlExecutor that counts the statements it executes. */
  function counting(db: Database) {
    const inner = makeSql(db);
    let count = 0;
    return {
      sql: (<T = unknown>(strings: TemplateStringsArray, ...values: Parameters<SqlExecutor>[1][]): T[] => {
        count++;
        return inner<T>(strings, ...values);
      }) satisfies SqlExecutor,
      statements: () => count,
      reset: () => { count = 0; },
    };
  }

  /** A transcript of `turns` completed turns, fully projected. */
  function seedProjected(ws: TestWorkspace, turns: number): string {
    void ws.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'S'}, ${'s'}, ${100})`;
    let last = '';
    for (let i = 0; i < turns; i++) {
      // Inline tool output is what makes the transcript heavy in production; a
      // scan pays for these bytes, a walk does not.
      sdkAppend(ws, { id: `u${i}`, role: 'user', text: `ask ${i}`, at: '2026-08-16 20:00:00' });
      sdkAppend(ws, { id: `a${i}`, role: 'assistant', text: `answer ${i} ${'x'.repeat(4_000)}`, at: '2026-08-16 20:00:00' });
      last = `a${i}`;
    }
    reconcileSessionTree(ws.sql);
    return last;
  }

  test('one more turn costs the same at 200 messages as at 800', () => {
    const cost = (turns: number): number => {
      const ws = fresh();
      seedProjected(ws, turns);
      const probe = counting(ws.db);
      sdkAppend(ws, { id: 'u-new', role: 'user', text: 'the new ask', at: '2026-08-16 21:00:00' });
      sdkAppend(ws, { id: 'a-new', role: 'assistant', text: 'the new answer', at: '2026-08-16 21:00:00' });
      probe.reset();
      expect(reconcileSessionTree(probe.sql)).toBe(2);
      return probe.statements();
    };

    const small = cost(100);
    const large = cost(400);
    expect(large).toBe(small);
    // 1 table probe + 1 leaf + (2 present-probes + 2 row reads) + 1 stop-probe
    // + 2 inserts. A scan or a rebuild cannot land inside this.
    expect(small).toBeLessThanOrEqual(10);
  });

  test('a settled workspace pays two statements and writes nothing', () => {
    const ws = fresh();
    seedProjected(ws, 200);
    const probe = counting(ws.db);
    probe.reset();

    expect(reconcileSessionTree(probe.sql)).toBe(0);
    // The table probe and the leaf lookup, then the leaf is already projected.
    expect(probe.statements()).toBeLessThanOrEqual(3);
  });
});
