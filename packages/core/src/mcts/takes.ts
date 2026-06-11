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

import type { SqlExecutor, RawSqlExec } from '../types/primitives.js';
import type { SearchNode } from '../types/mcts.js';
import { recordTurnOutcome } from '../evolution/outcomes.js';
import { nanoid } from '../utils/nanoid.js';
import { nowMs } from '../utils/date.js';

/** Most candidates a take set carries (including the winner). Two near-tied
 *  alternatives are a meaningful choice; ten are noise. */
const MAX_TAKE_CANDIDATES = 4;

export interface AlternateTakeCandidate {
  nodeId: string;
  /** The branch's proposal text (search_nodes.observation). */
  text: string;
  /** Execution-grounded branch value in [0,1] — the score evidence. */
  score: number;
  visits: number;
  depth: number;
}

export interface AlternateTakeSet {
  id: string;
  /** The turn whose answer these takes competed for — claimed at turn end. */
  turnId: string | null;
  sessionId: string | null;
  task: string;
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

export function initAlternateTakesTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS alternate_takes (
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    session_id TEXT,
    task TEXT NOT NULL,
    winner_node_id TEXT NOT NULL,
    chosen_node_id TEXT,
    candidates TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    picked_at INTEGER
  )`);
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
 * Capture the winner's near-tied rivals as an alternate-takes set. Reads the
 * same population converge() decided over (status terminal/open — call BEFORE
 * the tree close prunes the siblings). A rival qualifies when its value is
 * within `epsilon` of the winner's AND it is a genuinely different approach:
 * not the root, not on the winner's own ancestor/descendant path, and not a
 * texual duplicate. Returns the new set id, or null when no real choice
 * exists (fewer than 2 candidates).
 */
export function captureAlternateTakes(
  sql: SqlExecutor,
  input: { task: string; winnerId: string; epsilon: number; now?: number },
): string | null {
  const nodes = sql<SearchNode>`
    SELECT * FROM search_nodes WHERE status IN ('terminal', 'open')`;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const winner = byId.get(input.winnerId);
  if (!winner) return null;

  const winnerPath = ancestorPath(byId, winner.id);
  const seenTexts = new Set([winner.observation.trim()]);
  const rivals = nodes
    .filter((n) => {
      if (n.id === winner.id || n.depth === 0) return false;
      if (n.value < winner.value - input.epsilon) return false;
      // Same-path nodes are refinements of the winner's approach, not rivals.
      if (winnerPath.has(n.id) || ancestorPath(byId, n.id).has(winner.id)) return false;
      const text = n.observation.trim();
      if (!text || seenTexts.has(text)) return false;
      seenTexts.add(text);
      return true;
    })
    .sort((a, b) => b.value - a.value || b.depth - a.depth)
    .slice(0, MAX_TAKE_CANDIDATES - 1);
  if (rivals.length === 0) return null;

  const toCandidate = (n: SearchNode): AlternateTakeCandidate => ({
    nodeId: n.id, text: n.observation, score: n.value, visits: n.visits, depth: n.depth,
  });
  const id = `take-${nanoid()}`;
  sql`INSERT INTO alternate_takes
        (id, turn_id, session_id, task, winner_node_id, chosen_node_id, candidates, created_at, picked_at)
      VALUES
        (${id}, ${null}, ${null}, ${input.task.slice(0, 500)}, ${winner.id}, ${null},
         ${JSON.stringify([toCandidate(winner), ...rivals.map(toCandidate)])},
         ${input.now ?? nowMs()}, ${null})`;
  return id;
}

/** Attach the take sets captured during the just-finished turn (MCTS runs
 *  mid-turn, before the assistant message id exists) to that turn's id.
 *  Returns how many sets were claimed. */
export function claimAlternateTakesForTurn(
  sql: SqlExecutor,
  input: { turnId: string; sessionId: string },
): number {
  const unclaimed = sql<{ id: string }>`
    SELECT id FROM alternate_takes WHERE turn_id IS NULL`;
  for (const row of unclaimed) {
    sql`UPDATE alternate_takes SET turn_id = ${input.turnId}, session_id = ${input.sessionId}
        WHERE id = ${row.id}`;
  }
  return unclaimed.length;
}

interface RawTakeRow {
  id: string; turn_id: string | null; session_id: string | null; task: string;
  winner_node_id: string; chosen_node_id: string | null; candidates: string;
  created_at: number; picked_at: number | null;
}

function toTakeSet(r: RawTakeRow): AlternateTakeSet {
  let candidates: AlternateTakeCandidate[] = [];
  try {
    const parsed = JSON.parse(r.candidates) as unknown;
    if (Array.isArray(parsed)) candidates = parsed as AlternateTakeCandidate[];
  } catch { /* malformed row — surface an empty set rather than crash reads */ }
  return {
    id: r.id, turnId: r.turn_id, sessionId: r.session_id, task: r.task,
    winnerNodeId: r.winner_node_id, chosenNodeId: r.chosen_node_id,
    candidates, createdAt: r.created_at, pickedAt: r.picked_at,
  };
}

/** Recent take sets, newest first. Missing table = no takes (the table is
 *  created by the first MCTS run). */
export function listAlternateTakeSets(sql: SqlExecutor, opts: { limit?: number } = {}): AlternateTakeSet[] {
  try {
    return sql<RawTakeRow>`
      SELECT * FROM alternate_takes ORDER BY created_at DESC, id DESC LIMIT ${opts.limit ?? 50}`
      .map(toTakeSet);
  } catch {
    return [];
  }
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
  if (changedAnswer) {
    sql`UPDATE search_nodes SET status = 'pruned' WHERE id = ${set.winnerNodeId}`;
    sql`UPDATE search_nodes SET status = 'terminal' WHERE id = ${chosen.nodeId}`;
  }
  sql`UPDATE alternate_takes
      SET chosen_node_id = ${chosen.nodeId}, winner_node_id = ${chosen.nodeId}, picked_at = ${now}
      WHERE id = ${set.id}`;

  // The conversation context behind the ledger row — same lookup the
  // explicit-thumbs path uses (messages mirror keyed by the turn id).
  let userMessage = set.task;
  let assistantResponse = '';
  if (set.turnId) {
    try {
      const msg = sql<{ response: string; request: string | null }>`
        SELECT m.content AS response, u.content AS request
        FROM messages m LEFT JOIN messages u ON u.id = m.parent_id
        WHERE m.id = ${set.turnId} LIMIT 1`[0];
      if (msg) {
        assistantResponse = msg.response;
        if (msg.request) userMessage = msg.request;
      }
    } catch { /* messages mirror unavailable — record the verdict anyway */ }
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
    now,
  });

  return {
    outcome,
    changedAnswer,
    chosen,
    set: { ...set, chosenNodeId: chosen.nodeId, winnerNodeId: chosen.nodeId, pickedAt: now },
  };
}

/** The gentle programmatic turn asking the agent to continue with the chosen
 *  approach — single source for both backends' continuation enqueue. */
export function buildTakeContinuationPrompt(set: AlternateTakeSet, chosen: AlternateTakeCandidate): string {
  return (
    `While exploring "${set.task.slice(0, 200)}" you surfaced several near-tied approaches, ` +
    `and the user compared them and picked a different take than the one you answered with:\n\n` +
    `${chosen.text.slice(0, 2000)}\n\n` +
    `Please continue with this approach — briefly acknowledge the switch, then carry the work forward from it.`
  );
}
