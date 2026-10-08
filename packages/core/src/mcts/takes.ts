/** Alternate takes: competing answers offered to the user, whose pick is recorded in turn_ratings
 *  (source 'take_pick'). */

import { Effect } from 'effect';
import { settle } from '../obs/effect';
import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { recordTurnRating, takePickRating } from '../evolution/ratings';
import {
  initEffectTombstoneTable, effectAlreadyDone, recordEffectDone,
} from '../identity/effect-tombstones';
import type { TurnPairReader } from '../identity/conversation-store';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../utils/evidence-window';

/** One branch settlement's take set; set ids are fresh, so replays are caught by settlement key. */
const BRANCH_SCOPE = 'branch_take';

export const AlternateTakeCandidateSchema = v.object({
  nodeId: v.string(),
  text: v.string(),
  /** The live turn's answer or the branched redirect's. */
  origin: v.picklist(['live', 'branch']),
});

export type AlternateTakeCandidate = v.InferOutput<typeof AlternateTakeCandidateSchema>;

export interface AlternateTakeSet {
  id: string;
  turnId: string | null;
  sessionId: string | null;
  task: string;
  winnerNodeId: string;
  chosenNodeId: string | null;
  candidates: AlternateTakeCandidate[];
  createdAt: number;
}

export interface TakePickRecord {
  /** The user chose an alternate over the delivered answer. */
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
    chosen_node_id TEXT,
    candidates TEXT NOT NULL,
    settlement_key TEXT,
    created_at INTEGER NOT NULL,
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
    { nodeId: `${id}-live`, text: liveText, origin: 'live' },
    { nodeId: `${id}-branch`, text: branchText, origin: 'branch' },
  ];

  const now = input.now ?? nowMs();
  void sql`INSERT INTO alternate_takes
        (actor_id, id, turn_id, session_id, task, chosen_node_id, candidates,
         settlement_key, created_at)
      VALUES
        (${actor.actorId}, ${id}, ${input.turnId}, ${input.sessionId},
         ${input.task.slice(0, 500)},
         ${null}, ${JSON.stringify(candidates)},
         ${settlementKey}, ${now})`;

  if (settlementKey !== null) recordEffectDone(sql, actor, { scope: BRANCH_SCOPE, key: settlementKey });

  return {
    id, turnId: input.turnId, sessionId: input.sessionId, task: input.task.slice(0, 500),
    winnerNodeId: candidates[0].nodeId, chosenNodeId: null,
    candidates, createdAt: now,
  };
}

interface RawTakeRow {
  id: string; turn_id: string | null; session_id: string | null; task: string;
  chosen_node_id: string | null; candidates: string;
  created_at: number;
}

function toTakeSet(r: RawTakeRow): AlternateTakeSet {
  const candidates = v.parse(v.array(AlternateTakeCandidateSchema), JSON.parse(r.candidates));

  return {
    id: r.id, turnId: r.turn_id, sessionId: r.session_id, task: r.task,
    winnerNodeId: r.chosen_node_id ?? candidates[0].nodeId, chosenNodeId: r.chosen_node_id,
    candidates,
    createdAt: r.created_at,
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
 * Record the user's pick: marks the set picked (latest wins) and rates the delivered answer (`takePickRating`).
 * Candidates are synthetic, so no search_nodes row is re-pointed.
 */
export async function recordTakePick(
  sql: SqlExecutor,
  actor: ActorHandle,
  turnPair: TurnPairReader,
  input: { takeId: string; nodeId: string; scaffoldVersion?: number | null; now?: number },
): Promise<TakePickRecord> {
  actor.assertCurrent();

  const row = sql<RawTakeRow>`SELECT * FROM alternate_takes
    WHERE actor_id = ${actor.actorId} AND id = ${input.takeId}`[0];

  if (!row) return settle(Effect.die(new Error(`Unknown take set "${input.takeId}"`)));
  const set = toTakeSet(row);
  const chosen = set.candidates.find((c) => c.nodeId === input.nodeId);

  if (!chosen) return settle(Effect.die(new Error(`Node "${input.nodeId}" is not a candidate of take set "${input.takeId}"`)));

  const now = input.now ?? nowMs();
  const changedAnswer = chosen.nodeId !== set.winnerNodeId;

  void sql`UPDATE alternate_takes
      SET chosen_node_id = ${chosen.nodeId}
      WHERE actor_id = ${actor.actorId} AND id = ${set.id}`;

  let userMessage = set.task;
  let assistantResponse = '';

  if (set.turnId) {
    const pair = await turnPair(set.turnId);

    if (pair) {
      assistantResponse = pair.response ?? '';

      if (pair.request !== null) userMessage = pair.request;
    }
  }

  // A take set with no turn has nothing to rate.
  if (set.turnId) {
    recordTurnRating(sql, actor, {
      ...takePickRating(!changedAnswer),
      turnId: set.turnId,
      source: 'take_pick',
      request: userMessage,
      answer: assistantResponse,
      followup: changedAnswer ? chosen.text : null,
      scaffoldVersion: input.scaffoldVersion ?? null,
      now,
    });
  }

  return {
    changedAnswer,
    chosen,
    set: { ...set, chosenNodeId: chosen.nodeId, winnerNodeId: chosen.nodeId },
  };
}

export function takeEvidence(candidate: AlternateTakeCandidate): string {
  return candidate.origin === 'live' ? "the live turn's answer" : "the branched redirect's answer";
}

export function buildTakeContinuationPrompt(set: AlternateTakeSet, chosen: AlternateTakeCandidate): string {
  const task = evidenceWindow(set.task, EVIDENCE_BUDGETS.taskEcho);

  return (
    `While you answered, the user redirected with "${task}" and that redirect ran `
    + `as a parallel branch. Comparing both answers, the user picked the branch's:\n\n` +
    `${evidenceWindow(chosen.text, EVIDENCE_BUDGETS.takeChosen)}\n\n` +
    `Please continue with this approach: briefly acknowledge the switch, then carry the work forward from it.`
  );
}
