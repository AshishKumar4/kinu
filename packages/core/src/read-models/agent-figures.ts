import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { summarizeSteps } from '../events/step-stats';
import { UsageSchema } from '../usage';
import type { StepCost } from '../events/types';
import { nextLoopTurn } from '../types/clock';

export interface AgentFigures {
  readonly tokens?: number;
  /** Absent when no call was priced. */
  readonly usd?: number;
  readonly activeMs: number;
  readonly cacheEma: number | null;
  /** When its newest run event was recorded (a step, a model call, a turn's start or end); absent before it ran. */
  readonly lastActiveAt?: number;
}

export const NO_FIGURES: AgentFigures = { activeMs: 0, cacheEma: null };

/** A sum as SQLite's own SUM adds doubles (Kahan-Babuska-Neumaier): the running sum and the error it carries, so a sum
 *  folded a turn at a time is the one a single SUM over every row gave. */
const CompensatedSchema = v.tuple([v.number(), v.number()]);

/** The prompt-cache EMA is summarized over the agent's newest steps, measured or not. */
const AGENT_STEP_WINDOW = 400;

/** One step as the EMA reads it: its input and how much of it was read from the cache, each absent when unreported. */
const WindowStepSchema = v.tuple([v.nullable(v.number()), v.nullable(v.number())]);

const TotalsSchema = v.object({
  input: v.nullable(v.number()),
  output: v.nullable(v.number()),
  usd: v.nullable(CompensatedSchema),
  activeMs: CompensatedSchema,
  /** The newest {@link AGENT_STEP_WINDOW} steps, oldest first. */
  window: v.array(WindowStepSchema),
  /** Its newest folded event's time; absent from totals folded before it was kept, until the next event. */
  last: v.optional(v.number()),
});

type Compensated = v.InferOutput<typeof CompensatedSchema>;

const NO_TOTALS: v.InferOutput<typeof TotalsSchema> = { input: null, output: null, usd: null, activeMs: [0, 0], window: [] };

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
  /** A step's usage as stored, its JSON; null for every other event. */
  readonly step_usage: string | null;
  readonly type: string;
  readonly ts: string;
  /** A turn's end: the time since its start. */
  readonly ms: number | null;
}

/** The run events one event-loop turn folds. A 450-step screenshot turn's events folded at its end in one turn held its
 *  agent's isolate 80-142 ms (the facet loop gate, 2026-10-23), and the platform resets a facet whose turns take 0.1 s
 *  and more, its workspace with it (D14). */
const FOLD_SLICE_EVENTS = 200;

/** Over a database whose workspace schema is initialized, as the workspace's and every agent's isolate's is: main's
 *  isolate reads its own at every turn's end, where asking `sqlite_master` was a statement a turn. */
export async function readAgentFigures(sql: SqlExecutor, actorIds: readonly string[]): Promise<ReadonlyMap<string, AgentFigures>> {
  const figures = new Map<string, AgentFigures>();

  for (const actorId of actorIds) figures.set(actorId, await actorFigures(sql, actorId));

  return figures;
}

/** Folded forward: the events since the last read are added to the totals stored with it, so a turn's end reads its own
 *  turn's events, never the whole history (the join over every turn read 2,999 rows at turn 300), a slice at a time with
 *  the loop let go between slices. The EMA is summarized, as it always was, over the newest {@link AGENT_STEP_WINDOW}
 *  steps, kept with the totals: a step that reported no cache use still pushes an older measured one out. */
async function actorFigures(sql: SqlExecutor, actorId: string): Promise<AgentFigures> {
  const [stored] = sql<{ through: number; totals: string }>`SELECT through, totals FROM agent_figure_folds WHERE actor_id = ${actorId}`;
  let totals = stored === undefined ? NO_TOTALS : v.parse(TotalsSchema, JSON.parse(stored.totals));
  const from = stored?.through ?? 0;
  let through = from;

  for (let events = foldSlice(sql, actorId, through); events.length > 0; events = foldSlice(sql, actorId, through)) {
    totals = folded(totals, events);
    through = events.at(-1)?.seq ?? through;

    if (events.length < FOLD_SLICE_EVENTS) break;
    await nextLoopTurn();
  }

  const { input, output, usd, activeMs, last, window } = totals;

  const steps = window.map(([stepInput, cacheRead]): StepCost => ({
    usage: { ...(stepInput !== null && { input: stepInput }), ...(cacheRead !== null && { cacheRead }) },
  }));

  const cacheEma = summarizeSteps(steps, { windowLimit: AGENT_STEP_WINDOW }).cacheHit.ema;

  if (through > from) {
    void sql`INSERT INTO agent_figure_folds (actor_id, through, totals)
      VALUES (${actorId}, ${through}, ${JSON.stringify({ input, output, usd, activeMs, window, last })})
      ON CONFLICT (actor_id) DO UPDATE SET through = excluded.through, totals = excluded.totals`;
  }

  return {
    ...((input !== null || output !== null) && { tokens: (input ?? 0) + (output ?? 0) }),
    ...(usd !== null && { usd: usd[0] + usd[1] }),
    activeMs: Math.round(activeMs[0] + activeMs[1]),
    cacheEma,
    ...(last !== undefined && { lastActiveAt: last }),
  };
}

/** `totals` with `events` added. */
function folded(totals: v.InferOutput<typeof TotalsSchema>, events: readonly FoldedEvent[]): v.InferOutput<typeof TotalsSchema> {
  let { input, output, usd, activeMs, last } = totals;

  for (const event of events) {
    const at = Date.parse(event.ts);

    if (Number.isFinite(at)) last = Math.max(last ?? at, at);

    if (event.input !== null) input = (input ?? 0) + event.input;

    if (event.output !== null) output = (output ?? 0) + event.output;

    if (event.usd !== null) usd = compensated(usd ?? [0, 0], event.usd);

    if (event.ms !== null) activeMs = compensated(activeMs, event.ms);
  }

  // A step's usage decoded alone: its whole payload, parsed through the run-event schema, was 2.8 of the 202 MB a
  // 150-step turn allocated in its agent's isolate (heap gate, 2026-10-23).
  const window = [...totals.window, ...events.flatMap((event): Array<v.InferOutput<typeof WindowStepSchema>> => {
    if (event.type !== 'step_finish') return [];
    const usage = event.step_usage === null ? undefined : v.parse(UsageSchema, JSON.parse(event.step_usage));

    return [[usage?.input ?? null, usage?.cacheRead ?? null]];
  })].slice(-AGENT_STEP_WINDOW);

  return { input, output, usd, activeMs, window, ...(last !== undefined && { last }) };
}

/** The actor's next {@link FOLD_SLICE_EVENTS} run events a fold reads after the rowid `through`, oldest first. By the actor
 *  index's rowid, never by type: the type index would scan every step the actor ever took. Only those events' `ts` is
 *  read: it is stored after the payload, so reading it walks every overflow page of a tool call's result, and a 450-step
 *  screenshot turn's slice of 200 events held its agent's isolate 70-130 ms doing so (the facet loop gate, 2026-10-23). */
function foldSlice(sql: SqlExecutor, actorId: string, through: number): FoldedEvent[] {
  return sql<FoldedEvent>`
    SELECT e.rowid AS seq, e.type, e.ts,
           CASE WHEN e.type IN ('step_finish', 'model_call') THEN json_extract(e.payload, '$.usage.input') END AS input,
           CASE WHEN e.type IN ('step_finish', 'model_call') THEN json_extract(e.payload, '$.usage.output') END AS output,
           CASE WHEN e.type IN ('step_finish', 'model_call') THEN json_extract(e.payload, '$.usd') END AS usd,
           CASE WHEN e.type = 'step_finish' THEN json_extract(e.payload, '$.usage') END AS step_usage,
           CASE WHEN e.type = 'turn_end' THEN (
             SELECT SUM((julianday(e.ts) - julianday(s.ts)) * 86400000) FROM run_events s INDEXED BY idx_run_events_run_ts
             WHERE s.actor_id = e.actor_id AND s.run_id = e.run_id AND s.type = 'turn_start'
               AND json_extract(s.payload, '$.turnIndex') = json_extract(e.payload, '$.turnIndex')) END AS ms
    FROM run_events e INDEXED BY idx_run_events_actor
    WHERE e.actor_id = ${actorId} AND e.rowid > ${through} AND e.type IN ('step_finish', 'model_call', 'turn_start', 'turn_end')
    ORDER BY e.rowid
    LIMIT ${FOLD_SLICE_EVENTS}`;
}

export function initAgentFiguresTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_figures (
    actor_id TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id),
    figures  TEXT NOT NULL
  )`);
  // An agent's own totals as its last read left them, and the newest of its run events they include.
  execRaw(`CREATE TABLE IF NOT EXISTS agent_figure_folds ( /* derived from run_events: through is a rowid of its */
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
  lastActiveAt: v.optional(v.number()),
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
