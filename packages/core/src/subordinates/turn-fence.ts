/**
 * The workspace's revocation watermark for an agent's turns (design v3 B), one row an agent: the newest opening it
 * admitted, by its place in the agent's own sequence, the run that opening prepared, whether that run has ended, and the
 * facts the workspace first offered it until it ends. Every write names the opening it expects and changes nothing when
 * another has taken its place. Durable, so what is refused before a reset of the workspace is refused after it, and
 * bounded, as an agent's turns open one at a time.
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
    ended_at   INTEGER,
    facts_json TEXT
  )`);
}

/** One opening: the turn, the run it prepares, and its place in the agent's sequence. */
export interface FencedOpening {
  readonly turnId: string;
  readonly runId: string;
  readonly seq: number;
}

/** The opening a write expects to find open: its place in the sequence, which names it alone. */
export type OpenedAt = Pick<FencedOpening, 'seq'>;

export class TurnFences {
  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Admits an opening newer in the agent's sequence than every one admitted, and refuses, writing nothing, one that is
   * not: an earlier turn's, an earlier run's of the same turn, or the same opening delivered again. The facts offered its
   * run are kept while it is the same run (its recovery's), and go for any other (a later turn, or the turn's Retry).
   */
  open(actorId: string, opening: FencedOpening): boolean {
    return this.sql<{ seq: number }>`INSERT INTO actor_turn_fence (actor_id, seq, turn_id, run_id) VALUES (${actorId}, ${opening.seq}, ${opening.turnId}, ${opening.runId})
      ON CONFLICT (actor_id) DO UPDATE SET seq = excluded.seq, turn_id = excluded.turn_id, run_id = excluded.run_id, ended_at = NULL,
        facts_json = CASE WHEN actor_turn_fence.run_id = excluded.run_id THEN actor_turn_fence.facts_json END
      WHERE excluded.seq > actor_turn_fence.seq RETURNING seq`.length > 0;
  }

  /** The opening now open, or null when the agent's newest run has ended or it never opened one here. */
  /** The agents with a run admitted here that has not ended: after a reset of this workspace, each is recovered. */
  openActors(): string[] {
    return this.sql<{ actor_id: string }>`SELECT actor_id FROM actor_turn_fence WHERE ended_at IS NULL`.map((row) => row.actor_id);
  }

  current(actorId: string): OpenedAt | null {
    return this.sql<{ seq: number }>`SELECT seq FROM actor_turn_fence WHERE actor_id = ${actorId} AND ended_at IS NULL`[0] ?? null;
  }

  /**
   * The facts the preparation `at` is offered: the first its run was ever offered. Null, writing nothing, once another
   * opening took its place or its run ended: a preparation that finished late is no longer the agent's.
   */
  offer(actorId: string, at: OpenedAt, facts: TurnFacts): TurnFacts | null {
    const [offered] = this.sql<{ facts_json: string }>`UPDATE actor_turn_fence SET facts_json = COALESCE(facts_json, ${JSON.stringify(facts)})
      WHERE actor_id = ${actorId} AND seq = ${at.seq} AND ended_at IS NULL RETURNING facts_json`;

    return offered === undefined ? null : v.parse(TurnFactsSchema, JSON.parse(offered.facts_json));
  }

  /**
   * Ends the open run if it is the one expected, and answers the opening it ended: its facts frozen in the agent's store
   * since its preparation, its offer goes, and nothing refills it. An end the agent told names its run; an end the
   * workspace saw lost names the opening it saw open before it asked. One delayed past a later opening, a later turn's or
   * a Retry's, or already applied, ends nothing: null. `'unfenced'` for an agent that never opened a turn here, as one
   * whose turn opened before the fence did: its end is applied as told.
   */
  ended(actorId: string, expected: { readonly runId: string } | OpenedAt): Pick<FencedOpening, 'seq' | 'turnId'> | 'unfenced' | null {
    const runId = 'runId' in expected ? expected.runId : null;
    const seq = 'seq' in expected ? expected.seq : null;

    const [ended] = this.sql<{ seq: number; turn_id: string }>`UPDATE actor_turn_fence SET ended_at = ${Date.now()}, facts_json = NULL
      WHERE actor_id = ${actorId} AND ended_at IS NULL AND (run_id = ${runId} OR seq = ${seq}) RETURNING seq, turn_id`;

    if (ended !== undefined) return { seq: ended.seq, turnId: ended.turn_id };

    return this.sql<{ seq: number }>`SELECT seq FROM actor_turn_fence WHERE actor_id = ${actorId}`.length === 0 ? 'unfenced' : null;
  }
}
