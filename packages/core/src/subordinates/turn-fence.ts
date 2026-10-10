/**
 * The workspace's revocation watermark for an agent's turns (design v3 B), one row an agent: the newest opening it
 * admitted, by its place in the agent's own sequence, and the run that opening prepared, with the facts the workspace
 * first offered that run until it ends. Durable, so an opening or an end refused before a reset of the workspace is
 * refused after it, and bounded, as an agent's turns open one at a time.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { TurnFactsSchema, type TurnFacts } from '../orchestrator/turn-facts';

export function initTurnFenceTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS actor_turn_fence (
    actor_id   TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id),
    seq        INTEGER NOT NULL,
    turn_id    TEXT NOT NULL,
    run_id     TEXT NOT NULL,
    facts_json TEXT
  )`);
}

/** One opening: the turn, the run it prepares, and its place in the agent's sequence. */
export interface TurnOpening {
  readonly turnId: string;
  readonly runId: string;
  readonly seq: number;
}

export class TurnFences {
  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Admits an opening newer in the agent's sequence than every one admitted, and refuses, writing nothing, one that is
   * not: an earlier turn's, an earlier run's of the same turn, or the same opening delivered again. The facts offered its
   * run are kept while it is the same run (its recovery's), and go for any other (a later turn, or the turn's Retry).
   */
  open(actorId: string, opening: TurnOpening): boolean {
    return this.sql<{ seq: number }>`INSERT INTO actor_turn_fence (actor_id, seq, turn_id, run_id) VALUES (${actorId}, ${opening.seq}, ${opening.turnId}, ${opening.runId})
      ON CONFLICT (actor_id) DO UPDATE SET seq = excluded.seq, turn_id = excluded.turn_id, run_id = excluded.run_id,
        facts_json = CASE WHEN actor_turn_fence.run_id = excluded.run_id THEN actor_turn_fence.facts_json END
      WHERE excluded.seq > actor_turn_fence.seq RETURNING seq`.length > 0;
  }

  /** The facts a preparation of the agent's open run is offered: the first it was ever offered, until the run ends. */
  offer(actorId: string, facts: TurnFacts): TurnFacts {
    const [offered] = this.sql<{ facts_json: string | null }>`UPDATE actor_turn_fence SET facts_json = COALESCE(facts_json, ${JSON.stringify(facts)})
      WHERE actor_id = ${actorId} RETURNING facts_json`;

    return offered?.facts_json == null ? facts : v.parse(TurnFactsSchema, JSON.parse(offered.facts_json));
  }

  /**
   * Whether `runId`'s end is the agent's open run's, and if so, ends it: its facts frozen in the agent's store since its
   * preparation, its offer goes. An end delayed past a later opening, a later turn's or a Retry's, is no longer the open
   * run's, and changes nothing here. `runId` null is an end the workspace saw lost with the agent's isolate: its open run's.
   */
  ended(actorId: string, runId: string | null): boolean {
    const ended = this.sql<{ run_id: string }>`UPDATE actor_turn_fence SET facts_json = NULL
      WHERE actor_id = ${actorId} AND (${runId} IS NULL OR run_id = ${runId}) RETURNING run_id`;

    // Nothing ended: the agent's open run is another's, or it has never opened a turn here, which nothing fences.
    return ended.length > 0 || this.sql<{ seq: number }>`SELECT seq FROM actor_turn_fence WHERE actor_id = ${actorId}`.length === 0;
  }
}
