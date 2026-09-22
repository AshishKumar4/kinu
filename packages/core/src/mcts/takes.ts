/**
 * Alternate takes: near-tied MCTS terminal candidates offered to the user, whose pick is recorded
 * in turn_outcomes (source 'take_pick'). converge() captures them before closing the tree.
 */

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { SearchNode } from '../types/mcts';
import { recordTurnOutcome } from '../evolution/outcomes';
import {
  initEffectTombstoneTable, effectAlreadyDone, recordEffectDone,
} from '../identity/effect-tombstones';
import { conversationTurnPair } from '../identity/conversation-store';
import type { SessionTranscriptReader } from '../session/transcript';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';

/** One branch settlement's take set; set ids are fresh, so replays are caught by settlement key. */
const BRANCH_SCOPE = 'branch_take';

/** Most candidates a take set carries, including the winner. */
const MAX_TAKE_CANDIDATES = 4;

/** Where a take set came from. Only 'mcts' has real search_nodes to re-point on pick. */
export type AlternateTakeSource = 'mcts' | 'branch' | 'heads';

export interface AlternateTakeCandidate {
  nodeId: string;
  text: string;
  score: number;
  visits: number;
  depth: number;
  /** Branch-sourced sets only: the live turn's answer or the branched redirect's. */
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
  turnId: string | null;
  sessionId: string | null;
  task: string;
  source: AlternateTakeSource;
  winnerNodeId: string;
  chosenNodeId: string | null;
  candidates: AlternateTakeCandidate[];
  createdAt: number;
  pickedAt: number | null;
}

export interface TakePickRecord {
  outcome: 'accepted' | 'corrected';
  changedAnswer: boolean;
  chosen: AlternateTakeCandidate;
  set: AlternateTakeSet;
}

export interface TakePickOutcome extends TakePickRecord {
  continuationQueued: boolean;
}

export function initAlternateTakesTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS alternate_takes (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    turn_id TEXT,
    session_id TEXT,
    task TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'mcts',
    winner_node_id TEXT NOT NULL,
    chosen_node_id TEXT,
    candidates TEXT NOT NULL,
    settlement_key TEXT,
    created_at INTEGER NOT NULL,
    picked_at INTEGER,
    PRIMARY KEY (actor_id, id)
  )`);
  // Unique so a replayed settlement fails instead of adding a second set; NULL keys stay distinct.
  // Keyed by owner first so one actor's settlement cannot collide with another's.
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alternate_takes_settlement
      ON alternate_takes(actor_id, settlement_key)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_alternate_takes_actor
      ON alternate_takes(actor_id, created_at DESC, id DESC)`);
  initEffectTombstoneTable(execRaw);
}

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
 * The winner's near-tied rivals, highest value first: within `epsilon`, not the root, off the
 * winner's own path, not textual duplicates; capped at MAX_TAKE_CANDIDATES-1. Shared by takes
 * capture and the convergence tie-break so both use one near-tie population.
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

      if (winnerPath.has(n.id) || ancestorPath(byId, n.id).has(winner.id)) return false;
      const text = n.observation.trim();

      if (!text || seenTexts.has(text)) return false;
      seenTexts.add(text);

      return true;
    })
    .sort((a, b) => b.value - a.value || b.depth - a.depth)
    .slice(0, MAX_TAKE_CANDIDATES - 1);
}

/** Capture near-tied rivals before the tree close prunes them; null when fewer than 2 candidates. */
export function captureAlternateTakes(
  sql: SqlExecutor,
  actor: ActorHandle,
  input: { rootId: string; task: string; winnerId: string; epsilon: number; now?: number },
): string | null {
  actor.assertCurrent();

  const nodes = sql<SearchNode>`
    SELECT * FROM search_nodes
    WHERE actor_id = ${actor.actorId} AND root_id = ${input.rootId}
      AND status IN ('terminal', 'open')`;

  const winner = nodes.find((n) => n.id === input.winnerId);

  if (!winner) return null;

  const rivals = findNearTiedRivals(nodes, winner, input.epsilon);

  if (rivals.length === 0) return null;

  const toCandidate = (n: SearchNode): AlternateTakeCandidate => ({
    nodeId: n.id, text: n.observation, score: n.value, visits: n.visits, depth: n.depth,
  });

  const id = `take-${nanoid()}`;
  void sql`INSERT INTO alternate_takes
        (actor_id, id, turn_id, session_id, task, source, winner_node_id, chosen_node_id,
         candidates, created_at, picked_at)
      VALUES
        (${actor.actorId}, ${id}, ${null}, ${null}, ${input.task.slice(0, 500)}, ${'mcts'},
         ${winner.id}, ${null},
         ${JSON.stringify([toCandidate(winner), ...rivals.map(toCandidate)])},
         ${input.now ?? nowMs()}, ${null})`;

  return id;
}

/**
 * Persist a Steer-as-Branch pair as a take set already claimed against the live turn: A is the
 * live answer, B the redirect's. Synthetic ids never touch search_nodes; null when texts match.
 */
export function recordBranchTakeSet(
  sql: SqlExecutor,
  actor: ActorHandle,
  input: {
    task: string; turnId: string; sessionId: string;
    liveText: string; branchText: string; now?: number;
    /** The branch's durable identity; a replay with the same key returns the set the first attempt wrote. */
    settlementKey?: string;
  },
): AlternateTakeSet | null {
  actor.assertCurrent();
  const settlementKey = input.settlementKey ?? null;

  if (settlementKey !== null) {
    const stored = sql<RawTakeRow>`
      SELECT * FROM alternate_takes
      WHERE actor_id = ${actor.actorId} AND settlement_key = ${settlementKey} LIMIT 1`[0];

    if (stored) return toTakeSet(stored);

    // The key is recorded but its row is gone; re-minting would be the duplicate the key prevents.
    if (effectAlreadyDone(sql, actor, BRANCH_SCOPE, settlementKey)) return null;
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
        (actor_id, id, turn_id, session_id, task, source, winner_node_id, chosen_node_id, candidates,
         settlement_key, created_at, picked_at)
      VALUES
        (${actor.actorId}, ${id}, ${input.turnId}, ${input.sessionId},
         ${input.task.slice(0, 500)}, ${'branch'},
         ${candidates[0].nodeId}, ${null}, ${JSON.stringify(candidates)},
         ${settlementKey}, ${now}, ${null})`;

  if (settlementKey !== null) recordEffectDone(sql, actor, { scope: BRANCH_SCOPE, key: settlementKey }, now);

  return {
    id, turnId: input.turnId, sessionId: input.sessionId, task: input.task.slice(0, 500),
    source: 'branch', winnerNodeId: candidates[0].nodeId, chosenNodeId: null,
    candidates, createdAt: now, pickedAt: null,
  };
}

/** Attach take sets captured during the just-finished turn to its id; stale unclaimed sets from
 *  earlier turns are purged, not misattributed. Returns how many sets were claimed. */
export function claimAlternateTakesForTurn(
  sql: SqlExecutor,
  actor: ActorHandle,
  input: {
    turnId: string; sessionId: string; startedAt: number;
    /** The takes this turn competed against. Named because the claim is replayable: a retry must not
     *  claim a later turn's rows. Absent selects whatever is unclaimed now. */
    takeIds?: readonly string[];
  },
): number {
  actor.assertCurrent();
  const actorId = actor.actorId;
  void sql`DELETE FROM alternate_takes
    WHERE actor_id = ${actorId} AND turn_id IS NULL AND created_at < ${input.startedAt}`;

  if (input.takeIds === undefined) {
    const claimed = sql<{ id: string }>`UPDATE alternate_takes
        SET turn_id = ${input.turnId}, session_id = ${input.sessionId}
        WHERE actor_id = ${actorId} AND turn_id IS NULL RETURNING id`;

    return claimed.length;
  }

  let claimed = 0;

  for (const id of input.takeIds) {
    const moved = sql<{ id: string }>`UPDATE alternate_takes
        SET turn_id = ${input.turnId}, session_id = ${input.sessionId}
        WHERE actor_id = ${actorId} AND id = ${id} AND turn_id IS NULL RETURNING id`;

    claimed += moved.length;
  }

  return claimed;
}

/** The unclaimed takes right now, recorded so a replayable claim's retry acts on the same set. */
export function unclaimedAlternateTakeIds(sql: SqlExecutor, actor: ActorHandle): string[] {
  actor.assertCurrent();

  return sql<{ id: string }>`SELECT id FROM alternate_takes
    WHERE actor_id = ${actor.actorId} AND turn_id IS NULL`
    .map((row) => row.id);
}

/** Drop unclaimed take sets when a turn settles without an id to claim them with. */
export function purgeUnclaimedAlternateTakes(
  sql: SqlExecutor,
  actor: ActorHandle,
  /** Named so a replayed purge cannot delete a later turn's captures. */
  takeIds?: readonly string[],
): void {
  actor.assertCurrent();
  const actorId = actor.actorId;

  if (takeIds === undefined) {
    void sql`DELETE FROM alternate_takes WHERE actor_id = ${actorId} AND turn_id IS NULL`;

    return;
  }

  for (const id of takeIds) {
    void sql`DELETE FROM alternate_takes
      WHERE actor_id = ${actorId} AND id = ${id} AND turn_id IS NULL`;
  }
}

interface RawTakeRow {
  id: string; turn_id: string | null; session_id: string | null; task: string;
  source: string | null;
  winner_node_id: string; chosen_node_id: string | null; candidates: string;
  created_at: number; picked_at: number | null;
}

function readTakeSource(stored: string | null): AlternateTakeSource {
  if (stored === 'branch') return 'branch';

  if (stored === 'heads') return 'heads';

  return 'mcts';
}

function toTakeSet(r: RawTakeRow): AlternateTakeSet {
  return {
    id: r.id, turnId: r.turn_id, sessionId: r.session_id, task: r.task,
    source: readTakeSource(r.source),
    winnerNodeId: r.winner_node_id, chosenNodeId: r.chosen_node_id,
    candidates: v.parse(AlternateTakeCandidatesSchema, JSON.parse(r.candidates)),
    createdAt: r.created_at, pickedAt: r.picked_at,
  };
}

export function listAlternateTakeSets(
  sql: SqlExecutor, actor: ActorHandle, opts: { limit?: number } = {},
): AlternateTakeSet[] {
  actor.assertCurrent();

  return sql<RawTakeRow>`
    SELECT * FROM alternate_takes WHERE actor_id = ${actor.actorId}
    ORDER BY created_at DESC, id DESC LIMIT ${opts.limit ?? 50}`
    .map(toTakeSet);
}

export function latestAlternateTakeSet(sql: SqlExecutor, actor: ActorHandle): AlternateTakeSet | null {
  return listAlternateTakeSets(sql, actor, { limit: 1 })[0] ?? null;
}

/**
 * Record the user's pick: marks the set picked (latest wins), re-points the convergence record
 * when a sibling beat the winner, and writes turn_outcomes ('accepted' or 'corrected').
 */
export async function recordTakePick(
  sql: SqlExecutor,
  actor: ActorHandle,
  transcript: SessionTranscriptReader,
  input: { takeId: string; nodeId: string; scaffoldVersion?: number | null; now?: number },
): Promise<TakePickRecord> {
  actor.assertCurrent();

  const row = sql<RawTakeRow>`SELECT * FROM alternate_takes
    WHERE actor_id = ${actor.actorId} AND id = ${input.takeId}`[0];

  if (!row) throw new Error(`Unknown take set "${input.takeId}"`);
  const set = toTakeSet(row);
  const chosen = set.candidates.find((c) => c.nodeId === input.nodeId);

  if (!chosen) throw new Error(`Node "${input.nodeId}" is not a candidate of take set "${input.takeId}"`);

  const now = input.now ?? nowMs();
  const changedAnswer = chosen.nodeId !== set.winnerNodeId;

  // Branch-sourced candidates are synthetic; there is no convergence record to re-point.
  if (changedAnswer && set.source === 'mcts') {
    // One statement, so a crash cannot leave neither node terminal.
    void sql`UPDATE search_nodes SET status = CASE
        WHEN id = ${set.winnerNodeId} THEN 'pruned'
        WHEN id = ${chosen.nodeId} THEN 'terminal'
        ELSE status END
      WHERE actor_id = ${actor.actorId} AND id IN (${set.winnerNodeId}, ${chosen.nodeId})`;
  }

  void sql`UPDATE alternate_takes
      SET chosen_node_id = ${chosen.nodeId}, winner_node_id = ${chosen.nodeId}, picked_at = ${now}
      WHERE actor_id = ${actor.actorId} AND id = ${set.id}`;

  let userMessage = set.task;
  let assistantResponse = '';

  if (set.turnId) {
    const pair = await conversationTurnPair(transcript, set.turnId);

    if (pair) {
      assistantResponse = pair.response ?? '';

      if (pair.request !== null) userMessage = pair.request;
    }
  }

  const outcome = changedAnswer ? 'corrected' : 'accepted';
  recordTurnOutcome(sql, actor, {
    turnId: set.turnId,
    sessionId: set.sessionId ?? 'default',
    outcome,
    confidence: 1,
    source: 'take_pick',
    userMessage,
    assistantResponse,
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

export function takeEvidence(candidate: AlternateTakeCandidate): string {
  if (candidate.origin === 'live') return "the live turn's answer";

  if (candidate.origin === 'branch') return "the branched redirect's answer";

  return `score ${candidate.score.toFixed(2)} · ${candidate.visits} visit${candidate.visits === 1 ? '' : 's'} · depth ${candidate.depth}`;
}

function takeFraming(source: AlternateTakeSource, task: string): string {
  if (source === 'branch') {
    return `While you answered, the user redirected with "${task}" and that redirect ran `
      + `as a parallel branch. Comparing both answers, the user picked the branch's:`;
  }

  if (source === 'heads') {
    return `While exploring "${task}" you fanned out into parallel reasoning heads, `
      + `and the user compared their findings and picked a different head's answer than the one you merged to:`;
  }

  return `While exploring "${task}" you surfaced several near-tied approaches, `
    + `and the user compared them and picked a different take than the one you answered with:`;
}

export function buildTakeContinuationPrompt(set: AlternateTakeSet, chosen: AlternateTakeCandidate): string {
  const framing = takeFraming(set.source, evidenceWindow(set.task, EVIDENCE_BUDGETS.taskEcho));

  return (
    `${framing}\n\n` +
    `${evidenceWindow(chosen.text, EVIDENCE_BUDGETS.takeChosen)}\n\n` +
    `Please continue with this approach — briefly acknowledge the switch, then carry the work forward from it.`
  );
}
