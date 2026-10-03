/**
 * Live trials (docs/EVOLUTION-REDESIGN.md §5): a waiting candidate runs against the incumbent on the main agent,
 * one trial at a time, off until the owner turns them on. The unit is a cache segment: a turn whose request finds the
 * prompt cache cold opens one, and its arm (a seeded 50/50 hash of trial and segment ids, the same on both backends)
 * holds for every turn in it, so the prompt and tools never change inside a cached prefix. Rated segments are checked
 * at 10, 20 and 30 per arm, each one-sided at α = 0.05/3.
 */
import type { ActorHandle } from '../identity/actor-handle';
import {
  drawArm, LOOK_EVERY, mean, trialDecision, type ArmTurns, type LiveTrial, type TrialArm, type TrialTurn, type TrialVerdict,
} from './trial-rules';
import type { SqlExecutor } from '../types/primitives';
import { nowMs } from '../utils/date';
import { nanoid } from '../utils/nanoid';
import { listTurnRatings } from './ratings';
import {
  artifactEditRefusal, artifactVersion, bundledArtifact, settleArtifact, waitingCandidate, type ArtifactVersion,
} from './artifacts';

interface TrialRow { trial_id: string; artifact_id: string; version: number; started_at: number; looks: number }

export function runningTrial(sql: SqlExecutor, actor: ActorHandle): LiveTrial | null {
  actor.assertCurrent();

  const [row] = sql<TrialRow>`SELECT trial_id, artifact_id, version, started_at, looks FROM artifact_trials
    WHERE actor_id = ${actor.actorId} AND status = 'running' LIMIT 1`;

  return row === undefined ? null : {
    trialId: row.trial_id, artifactId: row.artifact_id, version: row.version, startedAt: row.started_at, looks: row.looks,
  };
}

/** What one turn runs: each artifact's body by id, and the trial arm that chose them. */
export interface TurnArtifacts {
  readonly bodies: Readonly<Record<string, string>>;
  readonly trial: TrialTurn | null;
}

/**
 * The bodies one turn runs: each artifact's current version, and on the main agent during a trial the candidate's
 * body in a candidate segment. One read of the store when no trial runs, as before trials existed. A cold cache opens
 * a segment; otherwise the turn joins the last one.
 */
export function turnArtifactBodies(sql: SqlExecutor, actor: ActorHandle, turn: {
  readonly answerId: string;
  readonly cacheCold: boolean;
  readonly main: boolean;
  readonly now?: number;
}): TurnArtifacts {
  actor.assertCurrent();

  const rows = sql<{ artifact_id: string; version: number; body: string; status: string }>`
    SELECT artifact_id, version, body, status FROM artifact_versions
    WHERE actor_id = ${actor.actorId} AND status IN ('current', 'trial')`;

  const bodies = Object.fromEntries(rows.filter((row) => row.status === 'current').map((row) => [row.artifact_id, row.body]));
  const candidate = rows.find((row) => row.status === 'trial');
  const trial = candidate === undefined || !turn.main ? null : runningTrial(sql, actor);

  if (candidate === undefined || trial === null) return { bodies, trial: null };
  const now = turn.now ?? nowMs();

  const [last] = sql<{ segment_id: string; arm: string }>`SELECT segment_id, arm FROM trial_turns
    WHERE actor_id = ${actor.actorId} AND trial_id = ${trial.trialId} ORDER BY at DESC LIMIT 1`;

  const segmentId = turn.cacheCold || last === undefined ? `seg-${nanoid()}` : last.segment_id;
  const arm = drawArm(trial.trialId, segmentId);

  void sql`INSERT INTO trial_turns (actor_id, trial_id, turn_id, segment_id, arm, at)
    VALUES (${actor.actorId}, ${trial.trialId}, ${turn.answerId}, ${segmentId}, ${arm}, ${now})
    ON CONFLICT(actor_id, trial_id, turn_id) DO NOTHING`;

  return {
    bodies: arm === 'candidate' ? { ...bodies, [candidate.artifact_id]: candidate.body } : bodies,
    trial: { trialId: trial.trialId, segmentId, arm },
  };
}

/** Starts the oldest waiting candidate's trial when the owner has trials on and none runs. */
export function startTrial(sql: SqlExecutor, actor: ActorHandle, now = nowMs()): LiveTrial | null {
  if (runningTrial(sql, actor) !== null) return null;
  const candidate = waitingCandidate(sql, actor);

  if (candidate === null) return null;
  const trialId = `trial-${nanoid()}`;

  settleArtifact(sql, actor, { artifactId: candidate.artifactId, version: candidate.version, status: 'trial', now });
  void sql`INSERT INTO artifact_trials (actor_id, trial_id, artifact_id, version, status, started_at)
    VALUES (${actor.actorId}, ${trialId}, ${candidate.artifactId}, ${candidate.version}, 'running', ${now})`;

  return { trialId, artifactId: candidate.artifactId, version: candidate.version, startedAt: now, looks: 0 };
}

/** Per arm: each rated segment's mean satisfaction, every rated turn's `corrected`, every recorded turn's errors and steps. */
function armTurns(sql: SqlExecutor, actor: ActorHandle, trial: LiveTrial, arm: TrialArm): ArmTurns {
  const turns = sql<{ turn_id: string; segment_id: string; errors: number | null; steps: number | null }>`
    SELECT t.turn_id, t.segment_id, s.errors, s.steps FROM trial_turns t
    LEFT JOIN turn_struggles s ON s.actor_id = t.actor_id AND s.turn_id = t.turn_id
    WHERE t.actor_id = ${actor.actorId} AND t.trial_id = ${trial.trialId} AND t.arm = ${arm}`;

  const ratings = new Map(listTurnRatings(sql, actor, { turnIds: turns.map((turn) => turn.turn_id) }).map((r) => [r.turnId, r]));
  const bySegment = new Map<string, number[]>();

  for (const turn of turns) {
    const rating = ratings.get(turn.turn_id);

    if (rating !== undefined) bySegment.set(turn.segment_id, [...(bySegment.get(turn.segment_id) ?? []), rating.score]);
  }

  const recorded = turns.filter((turn) => turn.errors !== null && turn.steps !== null);

  return {
    scores: [...bySegment.values()].map(mean),
    corrected: [...ratings.values()].map((rating) => rating.corrected),
    errors: recorded.map((turn) => turn.errors ?? 0),
    steps: recorded.map((turn) => turn.steps ?? 0),
    segments: bySegment.size,
  };
}

function settleTrial(sql: SqlExecutor, actor: ActorHandle, trial: LiveTrial, decided: TrialVerdict & { readonly at: number }): void {
  const { at: now, ...verdict } = decided;
  settleArtifact(sql, actor, {
    artifactId: trial.artifactId, version: trial.version, status: verdict.decision === 'kept' ? 'current' : 'rolled_back', now,
  });
  void sql`UPDATE artifact_trials SET status = ${verdict.decision}, decided_at = ${now}, verdict = ${JSON.stringify(verdict)}
    WHERE actor_id = ${actor.actorId} AND trial_id = ${trial.trialId}`;
  void sql`INSERT INTO evolution_events (actor_id, type, message, data, created_at)
    VALUES (${actor.actorId}, ${`artifact_${verdict.decision}`}, ${`${trial.artifactId} v${String(trial.version)}: ${verdict.why}`},
      ${JSON.stringify({ artifactId: trial.artifactId, version: trial.version, trialId: trial.trialId, verdict })}, ${now})`;
}

/** A trial whose candidate no longer passes the static checks is a plumbing error: it reverts, never promotes. */
function plumbingVerdict(why: string): TrialVerdict {
  const none = { diff: 0, lo: 0, hi: 0 };

  return {
    decision: 'reverted', why, segments: { candidate: 0, incumbent: 0 }, satisfaction: none,
    corrected: { candidate: 0, incumbent: 0 }, errors: none, steps: none,
  };
}

/** One look at the running trial; the decision, when one is due, settles it and writes its changelog entry. */
export function advanceTrial(sql: SqlExecutor, actor: ActorHandle, now = nowMs()): TrialVerdict | null {
  const trial = runningTrial(sql, actor);

  if (trial === null) return null;
  const version: ArtifactVersion | null = artifactVersion(sql, actor, trial.artifactId, trial.version);
  const parent = version?.parent === null || version?.parent === undefined ? null : artifactVersion(sql, actor, trial.artifactId, version.parent);

  const broken = version === null ? 'the candidate is gone' : artifactEditRefusal(sql, actor, {
    artifactId: trial.artifactId, before: parent?.body ?? bundledArtifact(trial.artifactId) ?? '', after: version.body, record: false,
  });

  if (broken !== null) {
    const verdict = plumbingVerdict(`plumbing error: ${broken}`);

    settleTrial(sql, actor, trial, { ...verdict, at: now });

    return verdict;
  }

  const candidate = armTurns(sql, actor, trial, 'candidate');
  const incumbent = armTurns(sql, actor, trial, 'incumbent');
  const verdict = trialDecision(candidate, incumbent, trial, now);

  if (verdict === null) {
    const look = Math.floor(Math.min(candidate.segments, incumbent.segments) / LOOK_EVERY);

    if (look > trial.looks) void sql`UPDATE artifact_trials SET looks = ${look} WHERE actor_id = ${actor.actorId} AND trial_id = ${trial.trialId}`;

    return null;
  }

  settleTrial(sql, actor, trial, { ...verdict, at: now });

  return verdict;
}
