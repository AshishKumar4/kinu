/**
 * What the workspace decided as a turn opened, frozen in the agent's own store at its run's preparation and carried in
 * its handoff (design v2 §2): its continuity, whether it records evolution, and the missions it spends for. Neither a
 * reset of the agent's isolate before it settles nor one of the workspace before it takes the handoff changes them.
 * The branches its owner started while it ran are the workspace's, one row each from their admission.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { TurnContinuitySchema } from './terminal-effects';
import { parseResolvedTurnProfile, type ResolvedTurnProfile } from '../profiles/snapshot';

export const TurnFactsSchema = v.object({
  continuity: TurnContinuitySchema,
  evolutionEnabled: v.boolean(),
  /** Its recording and review are scoped by these, never by whichever mission the workspace's governor holds then. */
  missionLabels: v.array(v.pipe(v.string(), v.nonEmpty())),
});

export type TurnFacts = v.InferOutput<typeof TurnFactsSchema>;

/** A turn that settles before the workspace prepared it opened with nothing of the workspace's. */
const UNPREPARED_TURN_FACTS: TurnFacts = Object.freeze({ continuity: 'conversation', evolutionEnabled: false, missionLabels: [] });

/** One row an execution: a run, which a turn's recovery continues and its Retry starts anew. `profile_json`: the profile
 *  the run first assembled on, frozen before any model or tool work; null until then. */
export function initTurnFactsTables(exec: RawSqlExec): void {
  exec(`CREATE TABLE IF NOT EXISTS actor_turn_facts (
    actor_id TEXT NOT NULL, run_id TEXT NOT NULL, facts_json TEXT NOT NULL, profile_json TEXT,
    PRIMARY KEY(actor_id,run_id))`);
}

/** An agent's executions' facts, in its own store beside its claims on them. */
export class TurnFactsStore {
  constructor(private readonly sql: SqlExecutor, private readonly actorId: string) {}

  /** As the run is prepared; prepared again, by the turn's recovery or a re-read, it keeps what it first opened with. A
   *  Retry is a new run, which opens with the facts of its own preparation. Answers the profile the run froze as it first
   *  assembled ({@link freezeProfile}), which its recovery assembles on: null for a run that never assembled. */
  freeze(runId: string, facts: TurnFacts): ResolvedTurnProfile | null {
    const [kept] = this.sql<{ profile_json: string | null }>`INSERT INTO actor_turn_facts (actor_id, run_id, facts_json) VALUES (${this.actorId}, ${runId}, ${JSON.stringify(facts)})
      ON CONFLICT (actor_id, run_id) DO UPDATE SET facts_json = actor_turn_facts.facts_json RETURNING profile_json`;

    return kept === undefined || kept.profile_json === null ? null : parseResolvedTurnProfile({ value: JSON.parse(kept.profile_json) });
  }

  /** The run's final profile, frozen once, as it first assembled: its recovery assembles on it and resolves nothing. */
  freezeProfile(runId: string, profile: ResolvedTurnProfile): void {
    void this.sql`UPDATE actor_turn_facts SET profile_json = ${JSON.stringify(profile)}
      WHERE actor_id = ${this.actorId} AND run_id = ${runId} AND profile_json IS NULL`;
  }

  /** Null before the run first assembled. */
  frozenProfile(runId: string): ResolvedTurnProfile | null {
    const row = this.sql<{ profile_json: string | null }>`SELECT profile_json FROM actor_turn_facts WHERE actor_id = ${this.actorId} AND run_id = ${runId}`[0];

    return row?.profile_json === null || row === undefined ? null : parseResolvedTurnProfile({ value: JSON.parse(row.profile_json) });
  }

  of(runId: string): TurnFacts {
    const row = this.sql<{ facts_json: string }>`SELECT facts_json FROM actor_turn_facts WHERE actor_id = ${this.actorId} AND run_id = ${runId}`[0];

    return row === undefined ? UNPREPARED_TURN_FACTS : v.parse(TurnFactsSchema, JSON.parse(row.facts_json));
  }
}

export function initTurnBranchesTable(exec: RawSqlExec): void {
  exec(`CREATE TABLE IF NOT EXISTS turn_branches (
    actor_id TEXT NOT NULL, turn_id TEXT NOT NULL, head_id TEXT NOT NULL,
    PRIMARY KEY(actor_id,turn_id,head_id))`);
}

/** The branches the owner started during an agent's turns, by the turn each redirected (`head_journal` names none). */
export class TurnBranchesStore {
  constructor(private readonly sql: SqlExecutor, private readonly actorId: string) {}

  /** Before the branch's start is answered. */
  admitted(turnId: string, headId: string): void {
    void this.sql`INSERT INTO turn_branches (actor_id, turn_id, head_id) VALUES (${this.actorId}, ${turnId}, ${headId}) ON CONFLICT DO NOTHING`;
  }

  of(turnId: string): string[] {
    return this.sql<{ head_id: string }>`SELECT head_id FROM turn_branches WHERE actor_id = ${this.actorId} AND turn_id = ${turnId} ORDER BY rowid`
      .map((row) => row.head_id);
  }

  /** Once the turn's roster is declared. */
  retire(turnId: string): void {
    void this.sql`DELETE FROM turn_branches WHERE actor_id = ${this.actorId} AND turn_id = ${turnId}`;
  }
}
