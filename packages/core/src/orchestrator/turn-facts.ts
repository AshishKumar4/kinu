/**
 * What the workspace decided as a turn opened, frozen in the agent's own store at its run's preparation and carried in
 * its handoff (design v2 §2): its continuity, whether it records evolution, and the missions it spends for. Neither a
 * reset of the agent's isolate before it settles nor one of the workspace before it takes the handoff changes them.
 * The branches its owner started while it ran are the workspace's, one row each from their admission.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { TurnContinuitySchema } from './terminal-effects';
import { parseResolvedTurnProfile } from '../profiles/snapshot';
import { parseProfileAuthorityInputs, type ProfileAuthorityInputs, type ResolvedTurnProfile } from '../profiles/resolve';
import type { ExecutionKey } from './execution';

export const TurnFactsSchema = v.object({
  continuity: TurnContinuitySchema,
  evolutionEnabled: v.boolean(),
  /** Its recording and review are scoped by these, never by whichever mission the workspace's governor holds then. */
  missionLabels: v.array(v.pipe(v.string(), v.nonEmpty())),
});

export type TurnFacts = v.InferOutput<typeof TurnFactsSchema>;

/** A turn that settles before the workspace prepared it opened with nothing of the workspace's. */
const UNPREPARED_TURN_FACTS: TurnFacts = Object.freeze({ continuity: 'conversation', evolutionEnabled: false, missionLabels: [] });

/** The authority an execution bound as it resolved (D5): its profile and the inputs it was resolved from. Its recovery
 *  binds it again and resolves nothing, whatever the settings say by then. */
export interface FrozenAuthority {
  readonly profile: ResolvedTurnProfile;
  readonly inputs: ProfileAuthorityInputs;
}

/** An execution as its facts are kept: the logical turn and the run answering it (a head's round is its own turn). */
export type FactsKey = Pick<ExecutionKey, 'turnId' | 'runId'>;

/**
 * One row an execution, by its key: the facts the workspace offered as it was prepared, and the authority it bound,
 * each frozen once and null until then. A turn's recovery continues its key; a Retry, new input or a run's next round
 * is another. Authority inputs are kept once each in `actor_profile_inputs`, by the catalog and listing they hold, as
 * every execution between two settings changes binds the same.
 */
export function initTurnFactsTables(exec: RawSqlExec): void {
  exec(`CREATE TABLE IF NOT EXISTS actor_turn_facts (
    actor_id TEXT NOT NULL, turn_id TEXT NOT NULL, run_id TEXT NOT NULL, facts_json TEXT, profile_json TEXT, inputs_key TEXT,
    PRIMARY KEY(actor_id,turn_id,run_id))`);
  exec(`CREATE TABLE IF NOT EXISTS actor_profile_inputs (
    actor_id TEXT NOT NULL, inputs_key TEXT NOT NULL, inputs_json TEXT NOT NULL,
    PRIMARY KEY(actor_id,inputs_key))`);
}

/** The inputs' identity: whose catalog, the catalog the envelope's digest names, and the listing its revision names. */
function inputsKeyOf(inputs: ProfileAuthorityInputs): string {
  const { authority, version, digest } = inputs.envelope;
  const owner = authority.kind === 'account' ? `account/${authority.accountId}` : 'local';

  return `${owner}:${String(version)}:${digest}:${inputs.provider.revision}`;
}

/** An agent's executions' facts and frozen authority, in its own store beside its claims on them. */
export class TurnFactsStore {
  constructor(private readonly sql: SqlExecutor, private readonly actorId: string) {}

  /** As the execution is prepared; prepared again, by its recovery or a re-read, it keeps what it first opened with. */
  freeze(key: FactsKey, facts: TurnFacts): void {
    void this.sql`INSERT INTO actor_turn_facts (actor_id, turn_id, run_id, facts_json) VALUES (${this.actorId}, ${key.turnId}, ${key.runId}, ${JSON.stringify(facts)})
      ON CONFLICT (actor_id, turn_id, run_id) DO UPDATE SET facts_json = COALESCE(actor_turn_facts.facts_json, excluded.facts_json)`;
  }

  /** The bind transition's record, once, before any model or tool work: a later bind of the same key keeps the first. */
  bind(key: FactsKey, authority: FrozenAuthority): void {
    const inputsKey = inputsKeyOf(authority.inputs);

    void this.sql`INSERT INTO actor_profile_inputs (actor_id, inputs_key, inputs_json) VALUES (${this.actorId}, ${inputsKey}, ${JSON.stringify(authority.inputs)})
      ON CONFLICT (actor_id, inputs_key) DO NOTHING`;
    void this.sql`INSERT INTO actor_turn_facts (actor_id, turn_id, run_id, profile_json, inputs_key) VALUES (${this.actorId}, ${key.turnId}, ${key.runId}, ${JSON.stringify(authority.profile)}, ${inputsKey})
      ON CONFLICT (actor_id, turn_id, run_id) DO UPDATE SET profile_json = COALESCE(actor_turn_facts.profile_json, excluded.profile_json),
        inputs_key = COALESCE(actor_turn_facts.inputs_key, excluded.inputs_key)`;
  }

  /** Null before the execution first bound. */
  frozen(key: FactsKey): FrozenAuthority | null {
    const row = this.sql<{ profile_json: string | null; inputs_json: string | null }>`
      SELECT f.profile_json, i.inputs_json FROM actor_turn_facts f
        LEFT JOIN actor_profile_inputs i ON i.actor_id = f.actor_id AND i.inputs_key = f.inputs_key
      WHERE f.actor_id = ${this.actorId} AND f.turn_id = ${key.turnId} AND f.run_id = ${key.runId}`[0];

    if (row === undefined || row.profile_json === null || row.inputs_json === null) return null;

    return {
      profile: parseResolvedTurnProfile({ value: JSON.parse(row.profile_json) }),
      inputs: parseProfileAuthorityInputs({ value: JSON.parse(row.inputs_json) }),
    };
  }

  of(key: FactsKey): TurnFacts {
    const row = this.sql<{ facts_json: string | null }>`SELECT facts_json FROM actor_turn_facts WHERE actor_id = ${this.actorId} AND turn_id = ${key.turnId} AND run_id = ${key.runId}`[0];

    return row?.facts_json === null || row === undefined ? UNPREPARED_TURN_FACTS : v.parse(TurnFactsSchema, JSON.parse(row.facts_json));
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
