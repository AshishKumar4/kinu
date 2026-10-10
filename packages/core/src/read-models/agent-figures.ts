import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { parseStoredRunEvent } from '../events/recorder';
import { summarizeSteps } from '../events/step-stats';
import type { StepCost } from '../events/types';

export interface AgentFigures {
  readonly tokens?: number;
  /** Absent when no call was priced. */
  readonly usd?: number;
  readonly activeMs: number;
  readonly cacheEma: number | null;
}

export const NO_FIGURES: AgentFigures = { activeMs: 0, cacheEma: null };

/** A sum as SQLite's own SUM adds doubles (Kahan-Babuska-Neumaier): the running sum and the error it carries, so a sum
 *  folded a turn at a time is the one a single SUM over every row gave. */
const CompensatedSchema = v.tuple([v.number(), v.number()]);

const TotalsSchema = v.object({
  input: v.nullable(v.number()),
  output: v.nullable(v.number()),
  usd: v.nullable(CompensatedSchema),
  activeMs: CompensatedSchema,
  cacheEma: v.nullable(v.number()),
});

type Compensated = v.InferOutput<typeof CompensatedSchema>;

const NO_TOTALS: v.InferOutput<typeof TotalsSchema> = { input: null, output: null, usd: null, activeMs: [0, 0], cacheEma: null };

function compensated([sum, error]: Compensated, value: number): Compensated {
  const next = sum + value;

  return [next, error + (Math.abs(sum) > Math.abs(value) ? sum - next + value : value - next + sum)];
}

interface FoldedEvent {
  readonly seq: number;
  /** A step's or a model call's; null for every other event. */
  readonly input: number | null;
  readonly output: number | null;
  readonly usd: number | null;
  /** A step's own payload, typed where every stored event is (`parseStoredRunEvent`); null for every other event. */
  readonly step: string | null;
  /** A turn's end: the time since its start. */
  readonly ms: number | null;
}

/** Over a database whose workspace schema is initialized, as the workspace's and every agent's isolate's is: main's
 *  isolate reads its own at every turn's end, where asking `sqlite_master` was a statement a turn. */
export function readAgentFigures(sql: SqlExecutor, actorIds: readonly string[]): ReadonlyMap<string, AgentFigures> {
  if (actorIds.length === 0) return new Map();

  return new Map(actorIds.map((actorId) => [actorId, actorFigures(sql, actorId)]));
}

/** Folded forward: the events since the last read are added to the totals stored with it, so a turn's end reads its own
 *  turn's events, never the whole history (the join over every turn read 2,999 rows at turn 300). The EMA continues
 *  from the one stored, where it was summarized over the newest 400 steps: the weight a step 400 back still carries,
 *  0.8^400, is below a double's precision. */
function actorFigures(sql: SqlExecutor, actorId: string): AgentFigures {
  const [stored] = sql<{ through: number; totals: string }>`SELECT through, totals FROM agent_figure_folds WHERE actor_id = ${actorId}`;
  const totals = stored === undefined ? NO_TOTALS : v.parse(TotalsSchema, JSON.parse(stored.totals));

  // By the actor index's rowid, never by type: the type index would scan every step the actor ever took.
  const events = sql<FoldedEvent>`
    SELECT e.rowid AS seq,
           CASE WHEN e.type IN ('step_finish', 'model_call') THEN json_extract(e.payload, '$.usage.input') END AS input,
           CASE WHEN e.type IN ('step_finish', 'model_call') THEN json_extract(e.payload, '$.usage.output') END AS output,
           CASE WHEN e.type IN ('step_finish', 'model_call') THEN json_extract(e.payload, '$.usd') END AS usd,
           CASE WHEN e.type = 'step_finish' THEN e.payload END AS step,
           CASE WHEN e.type = 'turn_end' THEN (
             SELECT SUM((julianday(e.ts) - julianday(s.ts)) * 86400000) FROM run_events s INDEXED BY idx_run_events_run_ts
             WHERE s.actor_id = e.actor_id AND s.run_id = e.run_id AND s.type = 'turn_start'
               AND json_extract(s.payload, '$.turnIndex') = json_extract(e.payload, '$.turnIndex')) END AS ms
    FROM run_events e INDEXED BY idx_run_events_actor
    WHERE e.actor_id = ${actorId} AND e.rowid > ${stored?.through ?? 0}
    ORDER BY e.ts, e.rowid`;

  let { input, output, usd, activeMs } = totals;

  for (const event of events) {
    if (event.input !== null) input = (input ?? 0) + event.input;

    if (event.output !== null) output = (output ?? 0) + event.output;

    if (event.usd !== null) usd = compensated(usd ?? [0, 0], event.usd);

    if (event.ms !== null) activeMs = compensated(activeMs, event.ms);
  }

  const steps = events.flatMap((event): StepCost[] => {
    const step = event.step === null ? null : parseStoredRunEvent(event.step);

    return step?.type === 'step_finish' ? [step] : [];
  });

  const cacheEma = summarizeSteps(steps, { windowLimit: steps.length, emaFrom: totals.cacheEma }).cacheHit.ema;

  if (events.length > 0) {
    // Reduced, not spread: an agent's first read folds its whole history.
    const through = events.reduce((newest, event) => Math.max(newest, event.seq), 0);

    void sql`INSERT INTO agent_figure_folds (actor_id, through, totals)
      VALUES (${actorId}, ${through}, ${JSON.stringify({ input, output, usd, activeMs, cacheEma })})
      ON CONFLICT (actor_id) DO UPDATE SET through = excluded.through, totals = excluded.totals`;
  }

  return {
    ...((input !== null || output !== null) && { tokens: (input ?? 0) + (output ?? 0) }),
    ...(usd !== null && { usd: usd[0] + usd[1] }),
    activeMs: Math.round(activeMs[0] + activeMs[1]),
    cacheEma,
  };
}

export function initAgentFiguresTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_figures (
    actor_id TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id),
    figures  TEXT NOT NULL
  )`);
  // An agent's own totals as its last read left them, and the newest of its run events they include.
  execRaw(`CREATE TABLE IF NOT EXISTS agent_figure_folds (
    actor_id TEXT PRIMARY KEY,
    through  INTEGER NOT NULL,
    totals   TEXT NOT NULL
  )`);
}

const AgentFiguresSchema = v.object({
  tokens: v.optional(v.number()),
  usd: v.optional(v.number()),
  activeMs: v.number(),
  cacheEma: v.nullable(v.number()),
});

export function recordAgentFigures(sql: SqlExecutor, actorId: string, figures: AgentFigures): void {
  void sql`INSERT INTO agent_figures (actor_id, figures) VALUES (${actorId}, ${JSON.stringify(figures)})
    ON CONFLICT (actor_id) DO UPDATE SET figures = excluded.figures`;
}

export function reportedAgentFigures(sql: SqlExecutor, actorIds: readonly string[]): ReadonlyMap<string, AgentFigures> {
  if (actorIds.length === 0) return new Map();

  return new Map(sql<{ actor_id: string; figures: string }>`SELECT actor_id, figures FROM agent_figures`
    .filter((row) => actorIds.includes(row.actor_id))
    .map((row) => [row.actor_id, v.parse(AgentFiguresSchema, JSON.parse(row.figures))]));
}
