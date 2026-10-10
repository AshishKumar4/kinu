/**
 * What main's turn left on the workspace's side, kept on disk from the turn's preparation to its handoff: how the
 * workspace opened it (its continuity, whether it records evolution, and the missions it spends for) and the branches its
 * owner started while it ran. Main's isolate commits the answer and hands the turn over afterwards, and the handoff may land on a later
 * activation than the turn's; the turn's roster is declared from these, never from what one activation held.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { TurnContinuity } from './agent-orchestrator';
import { TurnContinuitySchema } from './terminal-effects';

export interface MainTurnBranch {
  readonly id: string;
  readonly task: string;
}

export interface MainTurnFacts {
  readonly continuity: TurnContinuity;
  readonly evolutionEnabled: boolean;
  /** Its recording and review are scoped by these, never by whichever mission the workspace's governor holds then. */
  readonly missionLabels: readonly string[];
  readonly branches: readonly MainTurnBranch[];
}

const BranchesSchema = v.array(v.object({ id: v.string(), task: v.string() }));

const LabelsSchema = v.array(v.pipe(v.string(), v.nonEmpty()));

const FactsRowSchema = v.object({
  continuity: TurnContinuitySchema, evolution_enabled: v.picklist([0, 1]), mission_labels_json: v.string(), branches_json: v.string(),
});

export function initMainTurnFactsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS main_turn_facts (
    actor_id          TEXT NOT NULL,
    turn_id           TEXT NOT NULL,
    continuity        TEXT NOT NULL,
    evolution_enabled INTEGER NOT NULL,
    mission_labels_json TEXT NOT NULL,
    branches_json     TEXT NOT NULL,
    PRIMARY KEY (actor_id, turn_id)
  )`);
}

/** Main's turns by the id the workspace prepares them under (`announcementOf` its isolate's turn id). */
export class MainTurnFactsStore {
  constructor(private readonly sql: SqlExecutor, private readonly actorId: string) {}

  /** As the turn is prepared, before its isolate hears the preparation; a turn prepared again after a restart keeps
   *  what it opened with. */
  opened(turnId: string, facts: Omit<MainTurnFacts, 'branches'>): void {
    void this.sql`INSERT INTO main_turn_facts (actor_id, turn_id, continuity, evolution_enabled, mission_labels_json, branches_json)
      VALUES (${this.actorId}, ${turnId}, ${facts.continuity}, ${facts.evolutionEnabled ? 1 : 0}, ${JSON.stringify(facts.missionLabels)}, ${'[]'})
      ON CONFLICT (actor_id, turn_id) DO NOTHING`;
  }

  /** A branch the owner started during the turn, before its start is answered. */
  branched(turnId: string, branch: MainTurnBranch): void {
    const facts = this.read(turnId);

    void this.sql`UPDATE main_turn_facts SET branches_json = ${JSON.stringify([...facts.branches, branch])}
      WHERE actor_id = ${this.actorId} AND turn_id = ${turnId}`;
  }

  /** A turn with nothing on disk is one whose handoff already settled, which declares nothing again. */
  read(turnId: string): MainTurnFacts {
    const row = this.sql<v.InferInput<typeof FactsRowSchema>>`SELECT continuity, evolution_enabled, mission_labels_json, branches_json
      FROM main_turn_facts WHERE actor_id = ${this.actorId} AND turn_id = ${turnId}`[0];

    if (row === undefined) return { continuity: 'conversation', evolutionEnabled: false, missionLabels: [], branches: [] };
    const facts = v.parse(FactsRowSchema, row);

    return {
      continuity: facts.continuity,
      evolutionEnabled: facts.evolution_enabled === 1,
      missionLabels: v.parse(LabelsSchema, JSON.parse(facts.mission_labels_json)),
      branches: v.parse(BranchesSchema, JSON.parse(facts.branches_json)),
    };
  }

  /** Once the turn's roster is declared. */
  retire(turnId: string): void {
    void this.sql`DELETE FROM main_turn_facts WHERE actor_id = ${this.actorId} AND turn_id = ${turnId}`;
  }
}
