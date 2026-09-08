import * as v from 'valibot';
import { PlanReviewStore } from '../plans/review';
import { tableExists } from '../identity/schema';
import type { SqlExecutor } from '../types/primitives';
import type { TaskPlan } from './plan-scope';

const Approval = v.object({ kinuEvent: v.literal('plan_approved'), planId: v.string(), revision: v.pipe(v.number(), v.integer(), v.minValue(1)), decision: v.literal('approve') });

/** Only a running durable host submission can associate new tasks with a plan.
 * Client body/message metadata alone is not authority. Recovered submissions
 * retain the same message identity and immutable approved revision. */
export function approvedTaskPlan(sql: SqlExecutor, messageId: string | null): TaskPlan | null {
  if (messageId === null || !tableExists(sql, 'cf_think_submissions')) return null;
  const rows = sql<{ metadata_json: string; idempotency_key: string }>`
    SELECT metadata_json,idempotency_key FROM cf_think_submissions
    WHERE status='running' AND EXISTS (SELECT 1 FROM json_each(messages_json) WHERE json_extract(value,'$.id')=${messageId})`;
  for (const row of rows) {
    const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), Approval), row.metadata_json);
    if (!parsed.success) continue;
    const input = parsed.output;
    const prefix = `plan:${input.planId}:${input.revision}:approve:`;
    if (!row.idempotency_key.startsWith(prefix) || !/^\d+$/.test(row.idempotency_key.slice(prefix.length))) continue;
    const plan = new PlanReviewStore(sql).get(input.planId, input.revision);
    if (plan?.status === 'approved' && plan.sessionId === 'default') return { id: plan.id, revision: plan.revision, sessionId: plan.sessionId };
  }
  return null;
}
