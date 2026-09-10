/**
 * Alternate Takes — near-tie capture at convergence, the turn claim, and the
 * pick that writes the explicit preference into the R3 outcome ledger
 * (turn_outcomes, source 'take_pick') and re-points the convergence record.
 */
import { describe, test, expect } from 'bun:test';
import { makeSql, createTestActor, createTestWorkspace } from './helpers';
import type { ActorHandle } from '../src/identity/actor-handle';
import {
  initAlternateTakesTable, captureAlternateTakes, claimAlternateTakesForTurn,
  purgeUnclaimedAlternateTakes,
  listAlternateTakeSets, latestAlternateTakeSet, recordTakePick,
  buildTakeContinuationPrompt,
} from '../src/mcts/takes';
import { buildOutcomeEvalSplit } from '../src/evolution/eval-split';
import {
  listTurnOutcomes, realOutcomeScaffoldRates,
} from '../src/evolution/outcomes';

/** The PRODUCTION schema plus this module's own table: the eval split the pick
 *  feeds reconstructs process evidence from the message and run-event ledgers,
 *  so a hand-picked subset here would test a workspace shape that never ships. */
function setup() {
  const { db, sql, execRaw } = createTestWorkspace();
  initAlternateTakesTable(execRaw);
  // A real directory row, not a bare handle: the pick reads the turn pair out
  // of the actor-scoped conversation store, so the fixture needs the actor the
  // production readers would resolve for this workspace.
  const actor = createTestActor(sql, execRaw, 'ws-takes', 'takes');
  return { db, sql, execRaw, actor };
}

/** `search_nodes` is keyed `(actor_id, id)` now, so the owning actor is part of
 *  the row rather than of the reader's WHERE clause alone. A seed that omitted
 *  it would write rows no production reader can see. */
function insertNode(
  sql: ReturnType<typeof makeSql>,
  actor: ActorHandle,
  node: { id: string; parentId?: string | null; value: number; depth?: number; status?: string; text?: string; visits?: number },
) {
  void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, action, observation, value, visits, depth, status)
      VALUES (${actor.actorId}, 'r', ${node.id}, ${node.parentId ?? null}, ${'the task'}, ${node.text ?? node.id},
              ${node.text ?? `proposal ${node.id}`}, ${node.value}, ${node.visits ?? 1},
              ${node.depth ?? 1}, ${node.status ?? 'open'})`;
}

describe('captureAlternateTakes — the near-tie epsilon rule', () => {
  test('a dominant winner with no near-tied rival captures nothing', () => {
    const { sql, actor } = setup();
    insertNode(sql, actor, { id: 'win', value: 0.9 });
    insertNode(sql, actor, { id: 'far', value: 0.5 });
    expect(captureAlternateTakes(sql, actor, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 })).toBeNull();
    expect(listAlternateTakeSets(sql, actor)).toHaveLength(0);
  });

  test('near-tied rivals become a take set: winner first, then by descending score', () => {
    const { sql, actor } = setup();
    insertNode(sql, actor, { id: 'win', value: 0.9, text: 'approach A' });
    insertNode(sql, actor, { id: 'close1', value: 0.85, text: 'approach B' });
    insertNode(sql, actor, { id: 'close2', value: 0.88, text: 'approach C' });
    insertNode(sql, actor, { id: 'far', value: 0.4, text: 'approach D' });
    const id = captureAlternateTakes(sql, actor, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 });
    expect(id).toBeTruthy();
    const set = latestAlternateTakeSet(sql, actor)!;
    expect(set.winnerNodeId).toBe('win');
    expect(set.turnId).toBeNull();
    expect(set.chosenNodeId).toBeNull();
    expect(set.candidates.map((c) => c.nodeId)).toEqual(['win', 'close2', 'close1']);
    expect(set.candidates[0]).toMatchObject({ text: 'approach A', score: 0.9, depth: 1 });
  });

  test('the winner’s own ancestors/descendants and the root are not rivals', () => {
    const { sql, actor } = setup();
    insertNode(sql, actor, { id: 'root', value: 0.9, depth: 0, text: 'the task' });
    insertNode(sql, actor, { id: 'parent', parentId: 'root', value: 0.89, depth: 1, text: 'same path parent' });
    insertNode(sql, actor, { id: 'win', parentId: 'parent', value: 0.9, depth: 2, text: 'winning leaf' });
    insertNode(sql, actor, { id: 'child', parentId: 'win', value: 0.87, depth: 3, text: 'refinement of winner' });
    insertNode(sql, actor, { id: 'rival', parentId: 'root', value: 0.86, depth: 1, text: 'genuinely different' });
    captureAlternateTakes(sql, actor, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 });
    const set = latestAlternateTakeSet(sql, actor)!;
    expect(set.candidates.map((c) => c.nodeId)).toEqual(['win', 'rival']);
  });

  test('duplicate proposal texts dedupe and the set caps at 4 candidates', () => {
    const { sql, actor } = setup();
    insertNode(sql, actor, { id: 'win', value: 0.9, text: 'same text' });
    insertNode(sql, actor, { id: 'dup', value: 0.89, text: 'same text' });
    for (let i = 0; i < 6; i++) insertNode(sql, actor, { id: `r${i}`, value: 0.88 - i * 0.001, text: `rival ${i}` });
    captureAlternateTakes(sql, actor, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 });
    const set = latestAlternateTakeSet(sql, actor)!;
    expect(set.candidates).toHaveLength(4);
    expect(set.candidates.map((c) => c.nodeId)).toEqual(['win', 'r0', 'r1', 'r2']);
  });
});

describe('claimAlternateTakesForTurn — attaching mid-turn captures to the turn', () => {
  test('claims only unclaimed sets', () => {
    const { sql, actor } = setup();
    insertNode(sql, actor, { id: 'w1', value: 0.9, text: 'a' });
    insertNode(sql, actor, { id: 'r1', value: 0.88, text: 'b' });
    captureAlternateTakes(sql, actor, { rootId: 'r', task: 'the task', winnerId: 'w1', epsilon: 0.1, now: 1_000 });
    expect(claimAlternateTakesForTurn(sql, actor, { turnId: 'msg-1', sessionId: 'default', startedAt: 500 })).toBe(1);
    expect(latestAlternateTakeSet(sql, actor)).toMatchObject({ turnId: 'msg-1', sessionId: 'default' });
    // A later turn with no new capture claims nothing (no re-claim).
    expect(claimAlternateTakesForTurn(sql, actor, { turnId: 'msg-2', sessionId: 'default', startedAt: 2_000 })).toBe(0);
    expect(latestAlternateTakeSet(sql, actor)!.turnId).toBe('msg-1');
  });

  test('never claims captures left over from an earlier turn that did not settle', () => {
    const { sql, actor } = setup();
    insertNode(sql, actor, { id: 'w1', value: 0.9, text: 'a' });
    insertNode(sql, actor, { id: 'r1', value: 0.88, text: 'b' });
    // Captured at t=1000 during a turn that aborted before claiming.
    captureAlternateTakes(sql, actor, { rootId: 'r', task: 'the doomed task', winnerId: 'w1', epsilon: 0.1, now: 1_000 });
    // The NEXT completed turn started later — it must purge, not adopt.
    expect(claimAlternateTakesForTurn(sql, actor, { turnId: 'msg-2', sessionId: 'default', startedAt: 2_000 })).toBe(0);
    expect(latestAlternateTakeSet(sql, actor)).toBeNull();
  });

  test('an explicit-id replay after the claim counts nothing and keeps the first turn', () => {
    const { sql, actor } = setup();
    insertNode(sql, actor, { id: 'w1', value: 0.9, text: 'a' });
    insertNode(sql, actor, { id: 'r1', value: 0.88, text: 'b' });
    const id = captureAlternateTakes(sql, actor, { rootId: 'r', task: 'the task', winnerId: 'w1', epsilon: 0.1, now: 1_000 });
    if (!id) throw new Error('expected captureAlternateTakes to produce a take set');
    expect(claimAlternateTakesForTurn(sql, actor, { turnId: 'msg-1', sessionId: 'default', startedAt: 500 })).toBe(1);
    // A replay names the already-claimed set; a missing id names nothing —
    // neither moves a row, so both count zero and the first claim stands.
    expect(claimAlternateTakesForTurn(sql, actor, { turnId: 'msg-2', sessionId: 'default', startedAt: 500, takeIds: [id] })).toBe(0);
    expect(claimAlternateTakesForTurn(sql, actor, { turnId: 'msg-2', sessionId: 'default', startedAt: 500, takeIds: ['take-nope'] })).toBe(0);
    expect(latestAlternateTakeSet(sql, actor)).toMatchObject({ turnId: 'msg-1', sessionId: 'default' });
  });

  test('purgeUnclaimedAlternateTakes drops unclaimed sets and keeps claimed ones', () => {
    const { sql, actor } = setup();
    insertNode(sql, actor, { id: 'w1', value: 0.9, text: 'a' });
    insertNode(sql, actor, { id: 'r1', value: 0.88, text: 'b' });
    captureAlternateTakes(sql, actor, { rootId: 'r', task: 'claimed task', winnerId: 'w1', epsilon: 0.1, now: 1_000 });
    claimAlternateTakesForTurn(sql, actor, { turnId: 'msg-1', sessionId: 'default', startedAt: 500 });

    insertNode(sql, actor, { id: 'w2', value: 0.9, text: 'c' });
    insertNode(sql, actor, { id: 'r2', value: 0.88, text: 'd' });
    captureAlternateTakes(sql, actor, { rootId: 'r', task: 'aborted task', winnerId: 'w2', epsilon: 0.1, now: 2_000 });

    purgeUnclaimedAlternateTakes(sql, actor);
    const remaining = listAlternateTakeSets(sql, actor);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ turnId: 'msg-1', task: 'claimed task' });
  });
});

function capturedSet(sql: ReturnType<typeof makeSql>, actor: ActorHandle) {
  insertNode(sql, actor, { id: 'win', value: 0.9, text: 'winning approach' });
  insertNode(sql, actor, { id: 'alt', value: 0.85, text: 'alternative approach' });
  captureAlternateTakes(sql, actor, { rootId: 'r', task: 'the task', winnerId: 'win', epsilon: 0.1 });
  claimAlternateTakesForTurn(sql, actor, { turnId: 'msg-9', sessionId: 'default', startedAt: 0 });
  // The pair the pick attributes from, under the actor that owns the turn:
  // `recordTakePick` resolves it through the actor-scoped conversation store.
  void sql`INSERT INTO messages (actor_id, id, session_id, role, content)
    VALUES (${actor.actorId}, 'u-9', 'default', 'user', 'please solve it')`;
  void sql`INSERT INTO messages (actor_id, id, session_id, parent_id, role, content)
    VALUES (${actor.actorId}, 'msg-9', 'default', 'u-9', 'assistant', 'I used the winning approach')`;
  return latestAlternateTakeSet(sql, actor)!;
}

describe('recordTakePick — the preference signal', () => {
  test('picking the answered winner records an accepted take_pick row and moves nothing', () => {
    const { sql, actor } = setup();
    const set = capturedSet(sql, actor);
    const result = recordTakePick(sql, actor, { takeId: set.id, nodeId: 'win', scaffoldVersion: 3 });
    expect(result).toMatchObject({ outcome: 'accepted', changedAnswer: false });

    const rows = listTurnOutcomes(sql, actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      turnId: 'msg-9', outcome: 'accepted', source: 'take_pick', confidence: 1,
      userMessage: 'please solve it', assistantResponse: 'I used the winning approach',
      followup: null, scaffoldVersion: 3,
    });
    const statuses = sql<{ id: string; status: string }>`SELECT id, status FROM search_nodes ORDER BY id`;
    expect(statuses.map((r) => r.status)).toEqual(['open', 'open']);
    expect(latestAlternateTakeSet(sql, actor)).toMatchObject({ chosenNodeId: 'win', winnerNodeId: 'win' });
  });

  test('picking a sibling records the correction AND re-points the convergence record', () => {
    const { sql, actor } = setup();
    const set = capturedSet(sql, actor);
    const result = recordTakePick(sql, actor, { takeId: set.id, nodeId: 'alt' });
    expect(result).toMatchObject({ outcome: 'corrected', changedAnswer: true });
    expect(result.chosen.text).toBe('alternative approach');

    const row = listTurnOutcomes(sql, actor)[0]!;
    expect(row).toMatchObject({ outcome: 'corrected', source: 'take_pick', confidence: 1 });
    // The chosen take IS the correction follow-up — GEPA's optimization target.
    expect(row.followup).toBe('alternative approach');

    const win = sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'win'`[0]!;
    const alt = sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'alt'`[0]!;
    expect(win.status).toBe('pruned');
    expect(alt.status).toBe('terminal');
    expect(latestAlternateTakeSet(sql, actor)).toMatchObject({ chosenNodeId: 'alt', winnerNodeId: 'alt' });
  });

  test('a re-pick replaces the previous ledger row (one outcome per turn)', () => {
    const { sql, actor } = setup();
    const set = capturedSet(sql, actor);
    recordTakePick(sql, actor, { takeId: set.id, nodeId: 'alt' });
    recordTakePick(sql, actor, { takeId: set.id, nodeId: 'alt' });
    expect(listTurnOutcomes(sql, actor)).toHaveLength(1);
  });

  test('switching the pick moves the terminal marker to the newly chosen take', () => {
    const { sql, actor } = setup();
    const set = capturedSet(sql, actor);
    recordTakePick(sql, actor, { takeId: set.id, nodeId: 'alt' });
    const switched = recordTakePick(sql, actor, { takeId: set.id, nodeId: 'win' });
    expect(switched).toMatchObject({ outcome: 'corrected', changedAnswer: true });
    const win = sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'win'`[0]!;
    const alt = sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'alt'`[0]!;
    expect(win.status).toBe('terminal');
    expect(alt.status).toBe('pruned');
    expect(latestAlternateTakeSet(sql, actor)).toMatchObject({ chosenNodeId: 'win', winnerNodeId: 'win' });
    expect(listTurnOutcomes(sql, actor)).toHaveLength(1);
  });

  test('rejects unknown take sets and non-candidate nodes', () => {
    const { sql, actor } = setup();
    const set = capturedSet(sql, actor);
    expect(() => recordTakePick(sql, actor, { takeId: 'take-nope', nodeId: 'win' })).toThrow('Unknown take set');
    expect(() => recordTakePick(sql, actor, { takeId: set.id, nodeId: 'stranger' })).toThrow('not a candidate');
  });

  test('the continuation prompt carries the task and the chosen take', () => {
    const { sql, actor } = setup();
    const set = capturedSet(sql, actor);
    const { chosen } = recordTakePick(sql, actor, { takeId: set.id, nodeId: 'alt' });
    const prompt = buildTakeContinuationPrompt(set, chosen);
    expect(prompt).toContain('the task');
    expect(prompt).toContain('alternative approach');
    expect(prompt).toContain('continue with this approach');
  });
});

describe('the take_pick signal feeds R3’s routes for free', () => {
  test('GEPA eval split and scaffold priors consume the pick row', () => {
    const { sql, actor } = setup();
    const set = capturedSet(sql, actor);
    recordTakePick(sql, actor, { takeId: set.id, nodeId: 'alt', scaffoldVersion: 5 });

    const split = buildOutcomeEvalSplit(sql, actor, 4);
    expect(split.train).toHaveLength(1);
    expect(split.train[0]!.expected).toMatchObject({ outcome: 'corrected', followup: 'alternative approach' });

    const rates = realOutcomeScaffoldRates(sql, actor);
    expect(rates.get(5)).toEqual({ accepted: 0, negative: 1 });
  });
});
