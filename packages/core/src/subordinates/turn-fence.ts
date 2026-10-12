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
    facts_json TEXT,
    cancelled_at INTEGER
  )`);
  // Each opening admitted, by its place in the agent's sequence: what a close names is checked against it (`closes`),
  // its repeats too. A ring of {@link KEPT_OPENINGS} slots an agent: an opening takes its place's slot from the one
  // {@link KEPT_OPENINGS} places older, in the one statement that admits it.
  execRaw(`CREATE TABLE IF NOT EXISTS actor_turn_openings (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id),
    slot     INTEGER NOT NULL,
    seq      INTEGER NOT NULL,
    turn_id  TEXT NOT NULL,
    run_id   TEXT NOT NULL,
    PRIMARY KEY (actor_id, slot)
  )`);
}

/** How many of an agent's newest places in its sequence a close is judged against by name: one naming an older opening
 *  runs, and finds nothing of another execution to change, as every close write is keyed on its own. */
const KEPT_OPENINGS = 64;

/** What a close names (design v2 §3): the execution it closes and the epoch it opened with; null for one never admitted
 *  (stopped, or its preparation failed, before its claim was bound), whose close can end nothing of the fence by place. */
export type ClosedExecution = Pick<FencedOpening, 'turnId' | 'runId'> & { readonly seq: number | null };

/** One opening: the turn, the run it prepares, and its place in the agent's sequence. */
export interface FencedOpening {
  readonly turnId: string;
  readonly runId: string;
  readonly seq: number;
}

/** The agent's newest opening, as the fence holds it. */
export interface FencedRow extends FencedOpening {
  readonly live: boolean;
}

/** The opening a write expects to find open: its place in the sequence, which names it alone. */
export type OpenedAt = Pick<FencedOpening, 'seq'>;

export class TurnFences {
  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Admits an opening newer in the agent's sequence than every one admitted, and refuses, writing nothing, one that is
   * not: an earlier turn's, an earlier run's of the same turn, the same opening delivered again, or a run a Stop cancelled
   * reopening in its recovery. Only new input or a Retry, each a new run, opens the agent again after a Stop. The facts
   * offered its run are kept while it is the same run (its recovery's), and go for any other (a later turn, a Retry).
   */
  open(actorId: string, opening: FencedOpening): boolean {
    const admitted = this.sql<{ seq: number }>`INSERT INTO actor_turn_fence (actor_id, seq, turn_id, run_id) VALUES (${actorId}, ${opening.seq}, ${opening.turnId}, ${opening.runId})
      ON CONFLICT (actor_id) DO UPDATE SET seq = excluded.seq, turn_id = excluded.turn_id, run_id = excluded.run_id, ended_at = NULL, cancelled_at = NULL,
        facts_json = CASE WHEN actor_turn_fence.run_id = excluded.run_id THEN actor_turn_fence.facts_json END
      WHERE excluded.seq > actor_turn_fence.seq
        AND NOT (actor_turn_fence.cancelled_at IS NOT NULL AND actor_turn_fence.run_id = excluded.run_id)
      RETURNING seq`.length > 0;

    if (!admitted) return false;
    void this.sql`INSERT INTO actor_turn_openings (actor_id, slot, seq, turn_id, run_id)
      VALUES (${actorId}, ${opening.seq % KEPT_OPENINGS}, ${opening.seq}, ${opening.turnId}, ${opening.runId})
      ON CONFLICT (actor_id, slot) DO UPDATE SET seq = excluded.seq, turn_id = excluded.turn_id, run_id = excluded.run_id`;

    return true;
  }

  /**
   * Whether a close (its trace, charges, answer metadata, end, settle) may run (design v2 §3): its execution's own close
   * runs after a Stop or a newer opening, so it is judged by the opening it names, never by the fence's current one. One
   * that names an opening as another execution's, or an opening newer than any admitted, is refused, running nothing.
   * One older than the kept openings runs, and finds nothing of another execution to change: every close write is keyed
   * on its own execution.
   */
  closes(actorId: string, closed: ClosedExecution): boolean {
    if (closed.seq === null) return true;

    const opening = this.sql<{ turn_id: string; run_id: string }>`SELECT turn_id, run_id FROM actor_turn_openings
      WHERE actor_id = ${actorId} AND slot = ${closed.seq % KEPT_OPENINGS} AND seq = ${closed.seq}`[0];

    if (opening !== undefined) return opening.turn_id === closed.turnId && opening.run_id === closed.runId;
    const newest = this.row(actorId);

    if (newest === null || closed.seq > newest.seq) return false;

    return closed.seq < newest.seq || (newest.turnId === closed.turnId && newest.runId === closed.runId);
  }

  /** The agent's newest opening, and whether it still runs: neither ended nor stopped. Null before its first. */
  row(actorId: string): FencedRow | null {
    const row = this.sql<{ seq: number; turn_id: string; run_id: string; live: number }>`
      SELECT seq, turn_id, run_id, (ended_at IS NULL AND cancelled_at IS NULL) AS live FROM actor_turn_fence WHERE actor_id = ${actorId}`[0];

    return row === undefined ? null : { seq: row.seq, turnId: row.turn_id, runId: row.run_id, live: row.live === 1 };
  }

  /** The agents with a run admitted here that has not ended, nor been stopped: after a reset of this workspace, each is
   *  recovered. A stopped run's own isolate closes it; nothing of it runs again. */
  openActors(): string[] {
    return this.sql<{ actor_id: string }>`SELECT actor_id FROM actor_turn_fence WHERE ended_at IS NULL AND cancelled_at IS NULL`.map((row) => row.actor_id);
  }

  /** A Stop's cutoff (design v3 C): the agent's open run is cancelled, so no opening of it is admitted again and its
   *  recovery runs only its closes. Answers the opening it cancelled, if one was open. */
  cancel(actorId: string, at: number): OpenedAt | null {
    return this.sql<{ seq: number }>`UPDATE actor_turn_fence SET cancelled_at = ${at}
      WHERE actor_id = ${actorId} AND ended_at IS NULL AND cancelled_at IS NULL RETURNING seq`[0] ?? null;
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
