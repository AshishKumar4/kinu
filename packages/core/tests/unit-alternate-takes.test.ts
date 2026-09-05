/**
 * Alternate Takes — near-tie capture at convergence, the turn claim, and the
 * pick that writes the explicit preference into the R3 outcome ledger
 * (turn_outcomes, source 'take_pick') and re-points the convergence record.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw, createTestWorkspace } from './helpers';
import {
  initAlternateTakesTable, captureAlternateTakes, claimAlternateTakesForTurn,
  purgeUnclaimedAlternateTakes,
  listAlternateTakeSets, latestAlternateTakeSet, recordTakePick,
  buildTakeContinuationPrompt,
} from '../src/mcts/takes';
import { buildOutcomeEvalSplit } from '../src/evolution/eval-split';
import {
  initTurnOutcomeTables, listTurnOutcomes, realOutcomeScaffoldRates,
} from '../src/evolution/outcomes';

/** The PRODUCTION schema plus this module's own table: the eval split the pick
 *  feeds reconstructs process evidence from the message and run-event ledgers,
 *  so a hand-picked subset here would test a workspace shape that never ships. */
function setup() {
  const { db, sql, execRaw } = createTestWorkspace();
  initAlternateTakesTable(execRaw, sql);
  return { db, sql, execRaw };
}

function insertNode(
  sql: ReturnType<typeof makeSql>,
  node: { id: string; parentId?: string | null; value: number; depth?: number; status?: string; text?: string; visits?: number },
) {
  void sql`INSERT INTO search_nodes (root_id, id, parent_id, task, action, observation, value, visits, depth, status)
      VALUES ('r', ${node.id}, ${node.parentId ?? null}, ${'the task'}, ${node.text ?? node.id},
              ${node.text ?? `proposal ${node.id}`}, ${node.value}, ${node.visits ?? 1},
              ${node.depth ?? 1}, ${node.status ?? 'open'})`;
}

describe('captureAlternateTakes — the near-tie epsilon rule', () => {
  test('a dominant winner with no near-tied rival captures nothing', () => {
    const { sql } = setup();
    insertNode(sql, { id: 'win', value: 0.9 });
    insertNode(sql, { id: 'far', value: 0.5 });
    expect(captureAlternateTakes(sql, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 })).toBeNull();
    expect(listAlternateTakeSets(sql)).toHaveLength(0);
  });

  test('near-tied rivals become a take set: winner first, then by descending score', () => {
    const { sql } = setup();
    insertNode(sql, { id: 'win', value: 0.9, text: 'approach A' });
    insertNode(sql, { id: 'close1', value: 0.85, text: 'approach B' });
    insertNode(sql, { id: 'close2', value: 0.88, text: 'approach C' });
    insertNode(sql, { id: 'far', value: 0.4, text: 'approach D' });
    const id = captureAlternateTakes(sql, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 });
    expect(id).toBeTruthy();
    const set = latestAlternateTakeSet(sql)!;
    expect(set.winnerNodeId).toBe('win');
    expect(set.turnId).toBeNull();
    expect(set.chosenNodeId).toBeNull();
    expect(set.candidates.map((c) => c.nodeId)).toEqual(['win', 'close2', 'close1']);
    expect(set.candidates[0]).toMatchObject({ text: 'approach A', score: 0.9, depth: 1 });
  });

  test('the winner’s own ancestors/descendants and the root are not rivals', () => {
    const { sql } = setup();
    insertNode(sql, { id: 'root', value: 0.9, depth: 0, text: 'the task' });
    insertNode(sql, { id: 'parent', parentId: 'root', value: 0.89, depth: 1, text: 'same path parent' });
    insertNode(sql, { id: 'win', parentId: 'parent', value: 0.9, depth: 2, text: 'winning leaf' });
    insertNode(sql, { id: 'child', parentId: 'win', value: 0.87, depth: 3, text: 'refinement of winner' });
    insertNode(sql, { id: 'rival', parentId: 'root', value: 0.86, depth: 1, text: 'genuinely different' });
    captureAlternateTakes(sql, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 });
    const set = latestAlternateTakeSet(sql)!;
    expect(set.candidates.map((c) => c.nodeId)).toEqual(['win', 'rival']);
  });

  test('duplicate proposal texts dedupe and the set caps at 4 candidates', () => {
    const { sql } = setup();
    insertNode(sql, { id: 'win', value: 0.9, text: 'same text' });
    insertNode(sql, { id: 'dup', value: 0.89, text: 'same text' });
    for (let i = 0; i < 6; i++) insertNode(sql, { id: `r${i}`, value: 0.88 - i * 0.001, text: `rival ${i}` });
    captureAlternateTakes(sql, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 });
    const set = latestAlternateTakeSet(sql)!;
    expect(set.candidates).toHaveLength(4);
    expect(set.candidates.map((c) => c.nodeId)).toEqual(['win', 'r0', 'r1', 'r2']);
  });
});

describe('claimAlternateTakesForTurn — attaching mid-turn captures to the turn', () => {
  test('claims only unclaimed sets', () => {
    const { sql } = setup();
    insertNode(sql, { id: 'w1', value: 0.9, text: 'a' });
    insertNode(sql, { id: 'r1', value: 0.88, text: 'b' });
    captureAlternateTakes(sql, { rootId: 'r', task: 'the task', winnerId: 'w1', epsilon: 0.1, now: 1_000 });
    expect(claimAlternateTakesForTurn(sql, { turnId: 'msg-1', sessionId: 'default', startedAt: 500 })).toBe(1);
    expect(latestAlternateTakeSet(sql)).toMatchObject({ turnId: 'msg-1', sessionId: 'default' });
    // A later turn with no new capture claims nothing (no re-claim).
    expect(claimAlternateTakesForTurn(sql, { turnId: 'msg-2', sessionId: 'default', startedAt: 2_000 })).toBe(0);
    expect(latestAlternateTakeSet(sql)!.turnId).toBe('msg-1');
  });

  test('never claims captures left over from an earlier turn that did not settle', () => {
    const { sql } = setup();
    insertNode(sql, { id: 'w1', value: 0.9, text: 'a' });
    insertNode(sql, { id: 'r1', value: 0.88, text: 'b' });
    // Captured at t=1000 during a turn that aborted before claiming.
    captureAlternateTakes(sql, { rootId: 'r', task: 'the doomed task', winnerId: 'w1', epsilon: 0.1, now: 1_000 });
    // The NEXT completed turn started later — it must purge, not adopt.
    expect(claimAlternateTakesForTurn(sql, { turnId: 'msg-2', sessionId: 'default', startedAt: 2_000 })).toBe(0);
    expect(latestAlternateTakeSet(sql)).toBeNull();
  });

  test('an explicit-id replay after the claim counts nothing and keeps the first turn', () => {
    const { sql } = setup();
    insertNode(sql, { id: 'w1', value: 0.9, text: 'a' });
    insertNode(sql, { id: 'r1', value: 0.88, text: 'b' });
    const id = captureAlternateTakes(sql, { rootId: 'r', task: 'the task', winnerId: 'w1', epsilon: 0.1, now: 1_000 });
    if (!id) throw new Error('expected captureAlternateTakes to produce a take set');
    expect(claimAlternateTakesForTurn(sql, { turnId: 'msg-1', sessionId: 'default', startedAt: 500 })).toBe(1);
    // A replay names the already-claimed set; a missing id names nothing —
    // neither moves a row, so both count zero and the first claim stands.
    expect(claimAlternateTakesForTurn(sql, { turnId: 'msg-2', sessionId: 'default', startedAt: 500, takeIds: [id] })).toBe(0);
    expect(claimAlternateTakesForTurn(sql, { turnId: 'msg-2', sessionId: 'default', startedAt: 500, takeIds: ['take-nope'] })).toBe(0);
    expect(latestAlternateTakeSet(sql)).toMatchObject({ turnId: 'msg-1', sessionId: 'default' });
  });

  test('purgeUnclaimedAlternateTakes drops unclaimed sets and keeps claimed ones', () => {
    const { sql } = setup();
    insertNode(sql, { id: 'w1', value: 0.9, text: 'a' });
    insertNode(sql, { id: 'r1', value: 0.88, text: 'b' });
    captureAlternateTakes(sql, { rootId: 'r', task: 'claimed task', winnerId: 'w1', epsilon: 0.1, now: 1_000 });
    claimAlternateTakesForTurn(sql, { turnId: 'msg-1', sessionId: 'default', startedAt: 500 });

    insertNode(sql, { id: 'w2', value: 0.9, text: 'c' });
    insertNode(sql, { id: 'r2', value: 0.88, text: 'd' });
    captureAlternateTakes(sql, { rootId: 'r', task: 'aborted task', winnerId: 'w2', epsilon: 0.1, now: 2_000 });

    purgeUnclaimedAlternateTakes(sql);
    const remaining = listAlternateTakeSets(sql);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ turnId: 'msg-1', task: 'claimed task' });
  });
});

function capturedSet(sql: ReturnType<typeof makeSql>) {
  insertNode(sql, { id: 'win', value: 0.9, text: 'winning approach' });
  insertNode(sql, { id: 'alt', value: 0.85, text: 'alternative approach' });
  captureAlternateTakes(sql, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 });
  claimAlternateTakesForTurn(sql, { turnId: 'msg-9', sessionId: 'default', startedAt: 0 });
  void sql`INSERT INTO messages (id, session_id, role, content) VALUES ('u-9', 'default', 'user', 'please solve it')`;
  void sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES ('msg-9', 'default', 'u-9', 'assistant', 'I used the winning approach')`;
  return latestAlternateTakeSet(sql)!;
}

describe('recordTakePick — the preference signal', () => {
  test('picking the answered winner records an accepted take_pick row and moves nothing', () => {
    const { sql } = setup();
    const set = capturedSet(sql);
    const result = recordTakePick(sql, { takeId: set.id, nodeId: 'win', scaffoldVersion: 3 });
    expect(result).toMatchObject({ outcome: 'accepted', changedAnswer: false });

    const rows = listTurnOutcomes(sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      turnId: 'msg-9', outcome: 'accepted', source: 'take_pick', confidence: 1,
      userMessage: 'please solve it', assistantResponse: 'I used the winning approach',
      followup: null, scaffoldVersion: 3,
    });
    const statuses = sql<{ id: string; status: string }>`SELECT id, status FROM search_nodes ORDER BY id`;
    expect(statuses.map((r) => r.status)).toEqual(['open', 'open']);
    expect(latestAlternateTakeSet(sql)).toMatchObject({ chosenNodeId: 'win', winnerNodeId: 'win' });
  });

  test('picking a sibling records the correction AND re-points the convergence record', () => {
    const { sql } = setup();
    const set = capturedSet(sql);
    const result = recordTakePick(sql, { takeId: set.id, nodeId: 'alt' });
    expect(result).toMatchObject({ outcome: 'corrected', changedAnswer: true });
    expect(result.chosen.text).toBe('alternative approach');

    const row = listTurnOutcomes(sql)[0]!;
    expect(row).toMatchObject({ outcome: 'corrected', source: 'take_pick', confidence: 1 });
    // The chosen take IS the correction follow-up — GEPA's optimization target.
    expect(row.followup).toBe('alternative approach');

    const win = sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'win'`[0]!;
    const alt = sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'alt'`[0]!;
    expect(win.status).toBe('pruned');
    expect(alt.status).toBe('terminal');
    expect(latestAlternateTakeSet(sql)).toMatchObject({ chosenNodeId: 'alt', winnerNodeId: 'alt' });
  });

  test('a re-pick replaces the previous ledger row (one outcome per turn)', () => {
    const { sql } = setup();
    const set = capturedSet(sql);
    recordTakePick(sql, { takeId: set.id, nodeId: 'alt' });
    recordTakePick(sql, { takeId: set.id, nodeId: 'alt' });
    expect(listTurnOutcomes(sql)).toHaveLength(1);
  });

  test('switching the pick moves the terminal marker to the newly chosen take', () => {
    const { sql } = setup();
    const set = capturedSet(sql);
    recordTakePick(sql, { takeId: set.id, nodeId: 'alt' });
    const switched = recordTakePick(sql, { takeId: set.id, nodeId: 'win' });
    expect(switched).toMatchObject({ outcome: 'corrected', changedAnswer: true });
    const win = sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'win'`[0]!;
    const alt = sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'alt'`[0]!;
    expect(win.status).toBe('terminal');
    expect(alt.status).toBe('pruned');
    expect(latestAlternateTakeSet(sql)).toMatchObject({ chosenNodeId: 'win', winnerNodeId: 'win' });
    expect(listTurnOutcomes(sql)).toHaveLength(1);
  });

  test('rejects unknown take sets and non-candidate nodes', () => {
    const { sql } = setup();
    const set = capturedSet(sql);
    expect(() => recordTakePick(sql, { takeId: 'take-nope', nodeId: 'win' })).toThrow('Unknown take set');
    expect(() => recordTakePick(sql, { takeId: set.id, nodeId: 'stranger' })).toThrow('not a candidate');
  });

  test('the continuation prompt carries the task and the chosen take', () => {
    const { sql } = setup();
    const set = capturedSet(sql);
    const { chosen } = recordTakePick(sql, { takeId: set.id, nodeId: 'alt' });
    const prompt = buildTakeContinuationPrompt(set, chosen);
    expect(prompt).toContain('the task');
    expect(prompt).toContain('alternative approach');
    expect(prompt).toContain('continue with this approach');
  });
});

describe('the take_pick signal feeds R3’s routes for free', () => {
  test('GEPA eval split and scaffold priors consume the pick row', () => {
    const { sql } = setup();
    const set = capturedSet(sql);
    recordTakePick(sql, { takeId: set.id, nodeId: 'alt', scaffoldVersion: 5 });

    const split = buildOutcomeEvalSplit(sql, 4);
    expect(split.train).toHaveLength(1);
    expect(split.train[0]!.expected).toMatchObject({ outcome: 'corrected', followup: 'alternative approach' });

    const rates = realOutcomeScaffoldRates(sql);
    expect(rates.get(5)).toEqual({ accepted: 0, negative: 1 });
  });
});

describe('turn_outcomes legacy CHECK migration', () => {
  test('a pre-take_pick table is rebuilt in place with data preserved', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    execRaw(`CREATE TABLE turn_outcomes (
      id TEXT PRIMARY KEY,
      turn_id TEXT,
      session_id TEXT NOT NULL DEFAULT 'default',
      outcome TEXT NOT NULL CHECK (outcome IN ('accepted','corrected','frustrated','abandoned')),
      confidence REAL NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('explicit','classifier','session_end')),
      user_message TEXT NOT NULL,
      assistant_response TEXT NOT NULL,
      followup TEXT,
      scaffold_version INTEGER,
      created_at INTEGER NOT NULL
    )`);
    void sql`INSERT INTO turn_outcomes (id, turn_id, outcome, confidence, source, user_message, assistant_response, created_at)
        VALUES ('old-1', 't-1', 'accepted', 0.9, 'classifier', 'q', 'a', 111)`;
    // The legacy CHECK rejects the new source…
    expect(() => sql`INSERT INTO turn_outcomes (id, outcome, confidence, source, user_message, assistant_response, created_at)
        VALUES ('new-1', 'accepted', 1, 'take_pick', 'q', 'a', 222)`).toThrow();

    initTurnOutcomeTables(execRaw, sql);

    // …the rebuilt table accepts it and kept the old rows.
    void sql`INSERT INTO turn_outcomes (id, outcome, confidence, source, user_message, assistant_response, created_at)
        VALUES ('new-1', 'accepted', 1, 'take_pick', 'q', 'a', 222)`;
    const rows = listTurnOutcomes(sql);
    expect(rows.map((r) => r.id).sort()).toEqual(['new-1', 'old-1']);
    // Idempotent: a second init leaves the rebuilt table alone.
    initTurnOutcomeTables(execRaw, sql);
    expect(listTurnOutcomes(sql)).toHaveLength(2);
  });
});
