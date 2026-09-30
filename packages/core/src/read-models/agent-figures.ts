import type { SqlExecutor } from '../types/primitives';
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
  const ids = JSON.stringify(actorIds);

  const spend = sql<{ actor_id: string; input: number | null; output: number | null; usd: number | null }>`
    SELECT actor_id,
           SUM(json_extract(payload, '$.usage.input')) AS input,
           SUM(json_extract(payload, '$.usage.output')) AS output,
           SUM(json_extract(payload, '$.usd')) AS usd
    FROM run_events
    WHERE actor_id IN (SELECT value FROM json_each(${ids})) AND type IN ('step_finish', 'model_call')
    GROUP BY actor_id`;

  const turns = sql<{ actor_id: string; ms: number | null }>`
    SELECT s.actor_id, SUM((julianday(e.ts) - julianday(s.ts)) * 86400000) AS ms
    FROM run_events s JOIN run_events e
      ON e.actor_id = s.actor_id AND e.run_id = s.run_id AND e.type = 'turn_end'
     AND json_extract(e.payload, '$.turnIndex') = json_extract(s.payload, '$.turnIndex')
    WHERE s.actor_id IN (SELECT value FROM json_each(${ids})) AND s.type = 'turn_start'
    GROUP BY s.actor_id`;

  const stepsOf = new Map(actorIds.map((actorId) => [actorId, sql<{ payload: string }>`
    SELECT payload FROM run_events
    WHERE actor_id = ${actorId} AND type = 'step_finish'
    ORDER BY ts DESC, rowid DESC
    LIMIT ${AGENT_STEP_WINDOW}`.reverse().map((row) => parseStoredRunEvent(row.payload))
    .flatMap((event): StepCost[] => (event.type === 'step_finish' ? [event] : []))]));

  const spent = new Map(spend.map((row) => [row.actor_id, row]));
  const timed = new Map(turns.map((row) => [row.actor_id, row.ms ?? 0]));

  return new Map(actorIds.map((actorId) => {
    const row = spent.get(actorId);
    const ema = summarizeSteps(stepsOf.get(actorId) ?? [], { windowLimit: AGENT_STEP_WINDOW }).cacheHit.ema;

    return [actorId, {
      ...(row !== undefined && (row.input !== null || row.output !== null) && { tokens: (row.input ?? 0) + (row.output ?? 0) }),
      ...(row?.usd !== null && row?.usd !== undefined && { usd: row.usd }),
      activeMs: Math.round(timed.get(actorId) ?? 0),
      cacheEma: ema,
    } satisfies AgentFigures];
  }));
}

