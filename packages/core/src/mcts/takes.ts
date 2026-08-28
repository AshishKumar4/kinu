/**
 * Alternate Takes — near-tied MCTS terminal candidates surfaced to the user
 * as comparable "takes", whose pick becomes a real preference signal.
 *
 * Capture happens at convergence time (converge() calls
 * captureAlternateTakes BEFORE closing the tree, while near-tied siblings
 * are still distinguishable from mid-search prunes). The pick lands in the
 * R3 outcome ledger (turn_outcomes, source 'take_pick') and re-points the
 * convergence record in search_nodes when the user prefers a sibling —
 * the ledger write is the point; the carousel is just the surface.
 */

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { SearchNode } from '../types/mcts';
import { recordTurnOutcome } from '../evolution/outcomes';
import { reconcileColumns } from '../identity/columns';
import {
  initEffectTombstoneTable, effectAlreadyDone, recordEffectDone,
} from '../identity/effect-tombstones';
import { conversationTurnPair } from '../identity/conversation-store';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';

/** One branch settlement's take set. A branch's terminal effect can be replayed
 *  after the set persisted but before the disposition was recorded, and this
 *  table has no natural conflict to catch that: every set id is a fresh
 *  `take-${nanoid()}`. */
const BRANCH_SCOPE = 'branch_take';

/** Most candidates a take set carries (including the winner). Two near-tied
 *  alternatives are a meaningful choice; ten are noise. */
const MAX_TAKE_CANDIDATES = 4;

/** Where a take set came from: near-tied MCTS convergence rivals, a mid-turn
 *  Steer-as-Branch redirect run as a parallel head, or the comparable reports of
 *  an agents-fork fan-out. ONE pipeline — the comparison +
 *  pick→ledger flow is identical for all three (synthetic-id sources skip the
 *  search_nodes re-point; only 'mcts' has real nodes to move). */
export type AlternateTakeSource = 'mcts' | 'branch' | 'heads';

export interface AlternateTakeCandidate {
  nodeId: string;
  /** The branch's proposal text (search_nodes.observation). */
  text: string;
  /** Execution-grounded branch value in [0,1] — the score evidence. */
  score: number;
  visits: number;
  depth: number;
  /** Branch-sourced sets only: which side of the split this candidate is —
   *  the live turn's answer or the branched redirect's. MCTS candidates carry
   *  real node scores instead. */
  origin?: 'live' | 'branch';
}

const AlternateTakeCandidatesSchema: v.GenericSchema<AlternateTakeCandidate[]> = v.array(v.object({
  nodeId: v.string(),
  text: v.string(),
  score: v.number(),
  visits: v.number(),
  depth: v.number(),
  origin: v.optional(v.picklist(['live', 'branch'])),
}));

export interface AlternateTakeSet {
  id: string;
  /** The turn whose answer these takes competed for — claimed at turn end. */
  turnId: string | null;
  sessionId: string | null;
  task: string;
  source: AlternateTakeSource;
  /** The node currently serving as the converged answer (re-pointed on pick). */
  winnerNodeId: string;
  chosenNodeId: string | null;
  /** Winner first, then near-tied siblings by descending score. */
  candidates: AlternateTakeCandidate[];
  createdAt: number;
  pickedAt: number | null;
}

/** What a pick changed: the ledger outcome it recorded and whether the
 *  answer node moved (a sibling pick re-points the convergence record). */
export interface TakePickRecord {
  outcome: 'accepted' | 'corrected';
  changedAnswer: boolean;
  chosen: AlternateTakeCandidate;
  set: AlternateTakeSet;
}

/** The backend pick result surfaces consume: the record plus whether a
 *  continuation turn was queued for a changed answer. */
export interface TakePickOutcome extends TakePickRecord {
  continuationQueued: boolean;
}

export function initAlternateTakesTable(execRaw: RawSqlExec, sql: SqlExecutor): void {
  execRaw(`CREATE TABLE IF NOT EXISTS alternate_takes (
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    session_id TEXT,
    task TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'mcts',
    winner_node_id TEXT NOT NULL,
    chosen_node_id TEXT,
    candidates TEXT NOT NULL,
    settlement_key TEXT,
    created_at INTEGER NOT NULL,
    picked_at INTEGER
  )`);
  // Tables created before Steer-as-Branch lack the source column; tables created
  // before branch settlement was keyed lack the settlement key.
  reconcileColumns(sql, execRaw, 'alternate_takes', {
    source: `TEXT NOT NULL DEFAULT 'mcts'`,
    settlement_key: 'TEXT',
  });
  // UNIQUE so the invariant is the database's rather than the caller's: a
  // replayed settlement that got past the tombstone read would fail here instead
  // of adding a second set for one branch. SQLite treats NULLs as distinct, so
  // every unkeyed set is unaffected.
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alternate_takes_settlement
      ON alternate_takes(settlement_key)`);
  initEffectTombstoneTable(execRaw);
}

/** Node ids on the path from `node` up to the root (inclusive of `node`). */
function ancestorPath(byId: ReadonlyMap<string, SearchNode>, nodeId: string): Set<string> {
  const path = new Set<string>();
  let current = byId.get(nodeId);
  while (current && !path.has(current.id)) {
    path.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

/**
 * The winner's near-tied rivals among `nodes`, highest value first. A rival
 * qualifies when its value is within `epsilon` of the winner's AND it is a
 * genuinely different approach: not the root, not on the winner's own
 * ancestor/descendant path, and not a textual duplicate. Caps at
 * MAX_TAKE_CANDIDATES-1. Pure — shared by Alternate-Takes capture and the
 * test-based convergence tie-break (DO-NOW #3), so both reason over the SAME
 * near-tie population.
 */
export function findNearTiedRivals(
  nodes: readonly SearchNode[],
  winner: SearchNode,
  epsilon: number,
): SearchNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const winnerPath = ancestorPath(byId, winner.id);
  const seenTexts = new Set([winner.observation.trim()]);
  return nodes
    .filter((n) => {
      if (n.id === winner.id || n.depth === 0) return false;
      if (n.value < winner.value - epsilon) return false;
      // Same-path nodes are refinements of the winner's approach, not rivals.
      if (winnerPath.has(n.id) || ancestorPath(byId, n.id).has(winner.id)) return false;
      const text = n.observation.trim();
      if (!text || seenTexts.has(text)) return false;
      seenTexts.add(text);
      return true;
    })
    .sort((a, b) => b.value - a.value || b.depth - a.depth)
    .slice(0, MAX_TAKE_CANDIDATES - 1);
}

/**
 * Capture the winner's near-tied rivals as an alternate-takes set. Reads the
 * same population converge() decided over — this search's tree, status
 * terminal/open, read BEFORE the tree close prunes the siblings. Returns the
 * new set id, or null when no real choice exists (fewer than 2 candidates).
 */
export function captureAlternateTakes(
  sql: SqlExecutor,
  input: { rootId: string; task: string; winnerId: string; epsilon: number; now?: number },
): string | null {
  const nodes = sql<SearchNode>`
    SELECT * FROM search_nodes
    WHERE root_id = ${input.rootId} AND status IN ('terminal', 'open')`;
  const winner = nodes.find((n) => n.id === input.winnerId);
  if (!winner) return null;

  const rivals = findNearTiedRivals(nodes, winner, input.epsilon);
  if (rivals.length === 0) return null;

  const toCandidate = (n: SearchNode): AlternateTakeCandidate => ({
    nodeId: n.id, text: n.observation, score: n.value, visits: n.visits, depth: n.depth,
  });
  const id = `take-${nanoid()}`;
  void sql`INSERT INTO alternate_takes
        (id, turn_id, session_id, task, source, winner_node_id, chosen_node_id, candidates, created_at, picked_at)
      VALUES
        (${id}, ${null}, ${null}, ${input.task.slice(0, 500)}, ${'mcts'}, ${winner.id}, ${null},
         ${JSON.stringify([toCandidate(winner), ...rivals.map(toCandidate)])},
         ${input.now ?? nowMs()}, ${null})`;
  return id;
}

/**
 * Persist a Steer-as-Branch pair as an alternate-takes set, already claimed
 * against the live turn: candidate A is the answer the live turn gave (the
 * winner until the user says otherwise), candidate B the branched redirect's
 * answer. The synthetic node ids never touch search_nodes — recordTakePick
 * skips the convergence re-point for branch-sourced sets. Returns null when
 * the two answers are textually identical (no real choice to offer).
 */
export function recordBranchTakeSet(
  sql: SqlExecutor,
  input: {
    task: string; turnId: string; sessionId: string;
    liveText: string; branchText: string; now?: number;
    /** The branch's durable identity, for a caller whose settlement can be
     *  replayed. Every set id here is a fresh `take-${nanoid()}`, so without a
     *  key a replay after the set persisted but before the disposition was
     *  recorded inserts a SECOND set for one branch and broadcasts a different
     *  take-set id. With one, the replay returns the set the first attempt
     *  wrote. */
    settlementKey?: string;
  },
): AlternateTakeSet | null {
  const settlementKey = input.settlementKey ?? null;
  if (settlementKey !== null) {
    const stored = sql<RawTakeRow>`
      SELECT * FROM alternate_takes WHERE settlement_key = ${settlementKey} LIMIT 1`[0];
    if (stored) return toTakeSet(stored);
    // The key is recorded but its row is gone. The set existed; re-minting one
    // is exactly the duplicate the key exists to prevent.
    if (effectAlreadyDone(sql, BRANCH_SCOPE, settlementKey)) return null;
  }

  const liveText = input.liveText.trim();
  const branchText = input.branchText.trim();
  if (!liveText || !branchText || liveText === branchText) return null;

  const id = `take-${nanoid()}`;
  const candidates: AlternateTakeCandidate[] = [
    { nodeId: `${id}-live`, text: liveText, score: 0.5, visits: 1, depth: 0, origin: 'live' },
    { nodeId: `${id}-branch`, text: branchText, score: 0.5, visits: 1, depth: 0, origin: 'branch' },
  ];
  const now = input.now ?? nowMs();
  void sql`INSERT INTO alternate_takes
        (id, turn_id, session_id, task, source, winner_node_id, chosen_node_id, candidates,
         settlement_key, created_at, picked_at)
      VALUES
        (${id}, ${input.turnId}, ${input.sessionId}, ${input.task.slice(0, 500)}, ${'branch'},
         ${candidates[0]!.nodeId}, ${null}, ${JSON.stringify(candidates)},
         ${settlementKey}, ${now}, ${null})`;
  // Same synchronous pass as the insert: the tombstone is what answers the
  // replay once this row has been retired.
  if (settlementKey !== null) recordEffectDone(sql, BRANCH_SCOPE, settlementKey, now);
  return {
    id, turnId: input.turnId, sessionId: input.sessionId, task: input.task.slice(0, 500),
    source: 'branch', winnerNodeId: candidates[0]!.nodeId, chosenNodeId: null,
    candidates, createdAt: now, pickedAt: null,
  };
}

/** Attach the take sets captured during the just-finished turn (MCTS runs
 *  mid-turn, before the assistant message id exists) to that turn's id.
 *  The claim is scoped to this turn's window: stale unclaimed sets left by a
 *  turn that never claimed (aborted/errored, or completed without a message
 *  id) are purged instead of misattributed into the preference ledger.
 *  Returns how many sets were claimed. */
export function claimAlternateTakesForTurn(
  sql: SqlExecutor,
  input: {
    turnId: string; sessionId: string; startedAt: number;
    /** The takes this turn actually competed against, read when the turn settled.
     *
     *  Named rather than re-selected, because this call is REPLAYABLE: a retry
     *  arriving after a later turn has captured its own unclaimed takes would
     *  otherwise claim that turn's rows for this one. Absent keeps the live
     *  behaviour — select whatever is unclaimed now — for a caller whose claim
     *  nothing can replay. */
    takeIds?: readonly string[];
  },
): number {
  void sql`DELETE FROM alternate_takes WHERE turn_id IS NULL AND created_at < ${input.startedAt}`;
  const unclaimed = input.takeIds === undefined
    ? sql<{ id: string }>`SELECT id FROM alternate_takes WHERE turn_id IS NULL`
    : input.takeIds.map((id) => ({ id }));
  let claimed = 0;
  for (const row of unclaimed) {
    // Guarded on STILL being unclaimed: a recorded id another turn already
    // claimed is not this turn's to take back.
    void sql`UPDATE alternate_takes SET turn_id = ${input.turnId}, session_id = ${input.sessionId}
        WHERE id = ${row.id} AND turn_id IS NULL`;
    claimed += 1;
  }
  return claimed;
}

/** The unclaimed takes as they stand right now — what a REPLAYABLE claim records
 *  so its retry acts on the set the turn actually competed against. */
export function unclaimedAlternateTakeIds(sql: SqlExecutor): string[] {
  return sql<{ id: string }>`SELECT id FROM alternate_takes WHERE turn_id IS NULL`
    .map((row) => row.id);
}

/** Drop unclaimed take sets when a turn settles without an id to claim them
 *  with (aborted, errored, or no assistant message) — they competed for an
 *  answer that no longer exists, so the next turn must not inherit them. */
export function purgeUnclaimedAlternateTakes(
  sql: SqlExecutor,
  /** The takes this turn competed against. Named for the same reason the claim
   *  names them: an unqualified purge on a replay deletes a LATER turn's
   *  captures. */
  takeIds?: readonly string[],
): void {
  if (takeIds === undefined) {
    void sql`DELETE FROM alternate_takes WHERE turn_id IS NULL`;
    return;
  }
  for (const id of takeIds) {
    void sql`DELETE FROM alternate_takes WHERE id = ${id} AND turn_id IS NULL`;
  }
}

interface RawTakeRow {
  id: string; turn_id: string | null; session_id: string | null; task: string;
  source: string | null;
  winner_node_id: string; chosen_node_id: string | null; candidates: string;
  created_at: number; picked_at: number | null;
}

function toTakeSet(r: RawTakeRow): AlternateTakeSet {
  return {
    id: r.id, turnId: r.turn_id, sessionId: r.session_id, task: r.task,
    source: r.source === 'branch' ? 'branch' : r.source === 'heads' ? 'heads' : 'mcts',
    winnerNodeId: r.winner_node_id, chosenNodeId: r.chosen_node_id,
    candidates: v.parse(AlternateTakeCandidatesSchema, JSON.parse(r.candidates)),
    createdAt: r.created_at, pickedAt: r.picked_at,
  };
}

/** Recent take sets, newest first. */
export function listAlternateTakeSets(sql: SqlExecutor, opts: { limit?: number } = {}): AlternateTakeSet[] {
  return sql<RawTakeRow>`
    SELECT * FROM alternate_takes ORDER BY created_at DESC, id DESC LIMIT ${opts.limit ?? 50}`
    .map(toTakeSet);
}

export function latestAlternateTakeSet(sql: SqlExecutor): AlternateTakeSet | null {
  return listAlternateTakeSets(sql, { limit: 1 })[0] ?? null;
}

/**
 * Record the user's pick — THE preference signal:
 *  - marks the set picked (re-pickable; the latest pick wins),
 *  - re-points the convergence record when a sibling beat the answered
 *    winner (chosen → terminal, previous winner → pruned),
 *  - writes the turn_outcomes row (source 'take_pick', confidence 1):
 *    'accepted' when the answered winner was confirmed, 'corrected' when a
 *    sibling was preferred — with the chosen text as the correction
 *    follow-up, so GEPA/EMA/scaffold-prior routes consume it unchanged.
 */
export function recordTakePick(
  sql: SqlExecutor,
  input: { takeId: string; nodeId: string; scaffoldVersion?: number | null; now?: number },
): TakePickRecord {
  const row = sql<RawTakeRow>`SELECT * FROM alternate_takes WHERE id = ${input.takeId}`[0];
  if (!row) throw new Error(`Unknown take set "${input.takeId}"`);
  const set = toTakeSet(row);
  const chosen = set.candidates.find((c) => c.nodeId === input.nodeId);
  if (!chosen) throw new Error(`Node "${input.nodeId}" is not a candidate of take set "${input.takeId}"`);

  const now = input.now ?? nowMs();
  const changedAnswer = chosen.nodeId !== set.winnerNodeId;
  // Branch-sourced candidates are synthetic (live answer vs head answer) —
  // there is no convergence record in search_nodes to re-point.
  if (changedAnswer && set.source === 'mcts') {
    void sql`UPDATE search_nodes SET status = 'pruned' WHERE id = ${set.winnerNodeId}`;
    void sql`UPDATE search_nodes SET status = 'terminal' WHERE id = ${chosen.nodeId}`;
  }
  void sql`UPDATE alternate_takes
      SET chosen_node_id = ${chosen.nodeId}, winner_node_id = ${chosen.nodeId}, picked_at = ${now}
      WHERE id = ${set.id}`;

  // The conversation context behind the ledger row — same lookup the
  // explicit-thumbs path uses, through the canonical conversation store.
  let userMessage = set.task;
  let assistantResponse = '';
  if (set.turnId) {
    const pair = conversationTurnPair(sql, set.turnId);
    if (pair) {
      assistantResponse = pair.response ?? '';
      if (pair.request !== null) userMessage = pair.request;
    }
  }

  const outcome = changedAnswer ? 'corrected' : 'accepted';
  recordTurnOutcome(sql, {
    turnId: set.turnId,
    sessionId: set.sessionId ?? 'default',
    outcome,
    confidence: 1,
    source: 'take_pick',
    userMessage,
    assistantResponse,
    // A sibling pick IS the correction: the candidate the user actually wanted.
    followup: changedAnswer ? chosen.text : null,
    scaffoldVersion: input.scaffoldVersion ?? null,
    evidence: changedAnswer
      ? 'the user picked an alternate take over the delivered answer'
      : 'the user re-picked the delivered answer over its alternates',
    now,
  });

  return {
    outcome,
    changedAnswer,
    chosen,
    set: { ...set, chosenNodeId: chosen.nodeId, winnerNodeId: chosen.nodeId, pickedAt: now },
  };
}

/** One-line score evidence under a take's text — the shared presentation
 *  helper for every surface (web chip, TUI overlay, classic listing).
 *  Branch-sourced candidates have no node scores; their evidence is which
 *  side of the split they are. */
export function takeEvidence(candidate: AlternateTakeCandidate): string {
  if (candidate.origin === 'live') return "the live turn's answer";
  if (candidate.origin === 'branch') return "the branched redirect's answer";
  return `score ${candidate.score.toFixed(2)} · ${candidate.visits} visit${candidate.visits === 1 ? '' : 's'} · depth ${candidate.depth}`;
}

/** The gentle programmatic turn asking the agent to continue with the chosen
 *  approach — single source for both backends' continuation enqueue. */
export function buildTakeContinuationPrompt(set: AlternateTakeSet, chosen: AlternateTakeCandidate): string {
  const framing = set.source === 'branch'
    ? `While you answered, the user redirected with "${evidenceWindow(set.task, EVIDENCE_BUDGETS.taskEcho)}" and that redirect ran ` +
      `as a parallel branch. Comparing both answers, the user picked the branch's:`
    : set.source === 'heads'
    ? `While exploring "${evidenceWindow(set.task, EVIDENCE_BUDGETS.taskEcho)}" you fanned out into parallel reasoning heads, ` +
      `and the user compared their findings and picked a different head's answer than the one you merged to:`
    : `While exploring "${evidenceWindow(set.task, EVIDENCE_BUDGETS.taskEcho)}" you surfaced several near-tied approaches, ` +
      `and the user compared them and picked a different take than the one you answered with:`;
  return (
    `${framing}\n\n` +
    `${evidenceWindow(chosen.text, EVIDENCE_BUDGETS.takeChosen)}\n\n` +
    `Please continue with this approach — briefly acknowledge the switch, then carry the work forward from it.`
  );
}
