import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { tableExists } from '../identity/schema';
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

const AGENT_STEP_WINDOW = 400;

export const NO_FIGURES: AgentFigures = { activeMs: 0, cacheEma: null };

export function readAgentFigures(sql: SqlExecutor, actorIds: readonly string[]): ReadonlyMap<string, AgentFigures> {
  if (actorIds.length === 0 || !tableExists(sql, 'run_events')) return new Map();

  return new Map(actorIds.map((actorId) => [actorId, actorFigures(sql, actorId)]));
}

function actorFigures(sql: SqlExecutor, actorId: string): AgentFigures {
  const [spend] = sql<{ input: number | null; output: number | null; usd: number | null }>`
    SELECT SUM(json_extract(payload, '$.usage.input')) AS input,
           SUM(json_extract(payload, '$.usage.output')) AS output,
           SUM(json_extract(payload, '$.usd')) AS usd
    FROM run_events
    WHERE actor_id = ${actorId} AND type IN ('step_finish', 'model_call')`;

  const [turns] = sql<{ ms: number | null }>`
    SELECT SUM((julianday(e.ts) - julianday(s.ts)) * 86400000) AS ms
    FROM run_events s JOIN run_events e
      ON e.actor_id = s.actor_id AND e.run_id = s.run_id AND e.type = 'turn_end'
     AND json_extract(e.payload, '$.turnIndex') = json_extract(s.payload, '$.turnIndex')
    WHERE s.actor_id = ${actorId} AND s.type = 'turn_start'`;

  const steps = sql<{ payload: string }>`
    SELECT payload FROM run_events
    WHERE actor_id = ${actorId} AND type = 'step_finish'
    ORDER BY ts DESC, rowid DESC
    LIMIT ${AGENT_STEP_WINDOW}`.reverse().map((row) => parseStoredRunEvent(row.payload))
    .flatMap((event): StepCost[] => (event.type === 'step_finish' ? [event] : []));

  return {
    ...(spend !== undefined && (spend.input !== null || spend.output !== null) && { tokens: (spend.input ?? 0) + (spend.output ?? 0) }),
    ...(spend?.usd !== null && spend?.usd !== undefined && { usd: spend.usd }),
    activeMs: Math.round(turns?.ms ?? 0),
    cacheEma: summarizeSteps(steps, { windowLimit: AGENT_STEP_WINDOW }).cacheHit.ema,
  };
}

export function initAgentFiguresTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_figures (
    actor_id TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id),
    figures  TEXT NOT NULL
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
