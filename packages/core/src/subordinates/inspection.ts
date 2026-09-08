import * as v from 'valibot';
import { RunEventRecorder, RunEventSchema, RUN_EVENT_LIMIT_MAX } from '../events/recorder';
import { getRunSummaries } from '../read-models/runs';
import { getChatHistoryPage } from '../read-models/status';
import { pageSchema, SeekCursorSchema, type Page, type PageRequest } from '../read-models/page';
import type { RunEvent } from '../events/types';
import { ERROR_CODES, KinuError, refusalOf } from '../obs/error';
import { UsageSchema } from '../usage';
import { JsonObjectSchema } from '../utils/json';
import { tableExists } from '../identity/schema';
import type { SqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../state/actor-handle';
import { SubordinateRosterEntrySchema, SubordinateRosterStore } from './roster';
import { DELEGATION_MAX_DEPTH } from './depth';
import { PlanReviewStore, PlanReviewSchema } from '../plans/review';
import { readPlanTasks, AgentTaskTreeSchema } from '../tasks/store';

const PathSchema = v.pipe(v.array(v.pipe(v.string(), v.nonEmpty(), v.regex(/^[^/\0]+$/))), v.maxLength(DELEGATION_MAX_DEPTH));
const PageRequestSchema: v.GenericSchema<PageRequest> = v.strictObject({
  cursor: v.optional(SeekCursorSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
});
const IndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const EventQuerySchema = v.strictObject({
  since: v.optional(IndexSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(RUN_EVENT_LIMIT_MAX))),
});
export const WorkspacePlanReferenceSchema = v.strictObject({
  path: PathSchema, id: v.pipe(v.string(), v.nonEmpty()),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type WorkspacePlanReference = v.InferOutput<typeof WorkspacePlanReferenceSchema>;

export const SubordinateInspectionRequestSchema = v.variant('view', [
  v.strictObject({ path: PathSchema, view: v.literal('plans'), page: PageRequestSchema }),
  v.strictObject({ ...WorkspacePlanReferenceSchema.entries, view: v.literal('plan') }),
  v.strictObject({ ...WorkspacePlanReferenceSchema.entries, view: v.literal('planTasks') }),
  v.strictObject({ path: PathSchema, view: v.literal('children'), page: PageRequestSchema }),
  v.strictObject({ path: PathSchema, view: v.literal('history'), page: PageRequestSchema }),
  v.strictObject({ path: PathSchema, view: v.literal('runs'), page: PageRequestSchema }),
  v.strictObject({ path: PathSchema, view: v.literal('events'), runId: v.pipe(v.string(), v.nonEmpty()), query: EventQuerySchema }),
]);
export type SubordinateInspectionRequest = v.InferOutput<typeof SubordinateInspectionRequestSchema>;

const HistorySchema = v.object({
  id: v.string(), role: v.picklist(['user', 'assistant', 'system']), content: v.string(),
  createdAt: v.union([v.string(), v.number()]), metadata: v.optional(JsonObjectSchema),
});
const SummarySchema = v.object({
  runId: v.string(), eventCount: v.number(), startedAt: v.number(),
  causedBy: v.nullable(v.string()), userMessage: v.nullable(v.string()), status: v.nullable(v.string()),
  usage: UsageSchema, turnsWithoutUsage: v.number(),
});
const EventPageSchema: v.GenericSchema<Page<RunEvent, number>> = v.variant('status', [
  v.object({ status: v.literal('more'), items: v.array(RunEventSchema), next: IndexSchema }),
  v.object({ status: v.literal('end'), items: v.array(RunEventSchema) }),
]);
export const SubordinateInspectionResultSchema = v.variant('view', [
  v.object({ view: v.literal('plans'), path: PathSchema, page: pageSchema(PlanReviewSchema) }),
  v.object({ view: v.literal('plan'), path: PathSchema, plan: PlanReviewSchema }),
  v.object({ view: v.literal('planTasks'), path: PathSchema, tasks: v.array(AgentTaskTreeSchema) }),
  v.object({ view: v.literal('children'), path: PathSchema, page: pageSchema(SubordinateRosterEntrySchema) }),
  v.object({ view: v.literal('history'), path: PathSchema, page: pageSchema(HistorySchema) }),
  v.object({ view: v.literal('runs'), path: PathSchema, page: pageSchema(SummarySchema) }),
  v.object({ view: v.literal('events'), path: PathSchema, runId: v.string(), page: EventPageSchema }),
  v.object({ reason: v.picklist(ERROR_CODES), error: v.string(), view: v.literal('missing'), path: PathSchema }),
]);
export type SubordinateInspectionResult = v.InferOutput<typeof SubordinateInspectionResultSchema>;

export function missingSubordinateHistory(path: string[]): SubordinateInspectionResult {
  return { ...refusalOf(new KinuError('missing', 'The requested subordinate or retained history is unavailable.')), view: 'missing', path };
}

/** Reads existing actor tables. No schema initialization or live actor state. */
export function readSubordinateInspection(
  sql: SqlExecutor,
  actor: ActorHandle,
  raw: SqlExec,
  request: SubordinateInspectionRequest,
): SubordinateInspectionResult {
  const path = request.path;
  switch (request.view) {
    case 'plans':
      if (!tableExists(sql, 'plan_reviews')) return missingSubordinateHistory(path);
      return { view: 'plans', path, page: new PlanReviewStore(sql).listPage('default', request.page) };
    case 'plan':
    case 'planTasks': {
      if (!tableExists(sql, 'plan_reviews')) return missingSubordinateHistory(path);
      const plan = new PlanReviewStore(sql).get(request.id, request.revision);
      if (!plan || plan.sessionId !== 'default') return missingSubordinateHistory(path);
      if (request.view === 'plan') return { view: 'plan', path, plan };
      if (!tableExists(sql, 'plan_task_links')) return missingSubordinateHistory(path);
      return { view: 'planTasks', path, tasks: readPlanTasks(sql, actor, plan) };
    }
    case 'children': {
      if (!tableExists(sql, 'actor_subordinates')) return missingSubordinateHistory(path);
      const roster = new SubordinateRosterStore(raw);
      return { view: 'children', path, page: roster.listPage(request.page) };
    }
    case 'history':
      if (!tableExists(sql, 'assistant_messages') && !tableExists(sql, 'messages')) return missingSubordinateHistory(path);
      return { view: 'history', path, page: getChatHistoryPage(sql, actor, request.page) };
    case 'runs':
      if (!tableExists(sql, 'run_events')) return missingSubordinateHistory(path);
      return { view: 'runs', path, page: getRunSummaries(new RunEventRecorder(sql, actor), request.page.cursor, request.page.limit) };
    case 'events': {
      if (!tableExists(sql, 'run_events')) return missingSubordinateHistory(path);
      const recorder = new RunEventRecorder(sql, actor);
      if (recorder.runSeq(request.runId) === null) return missingSubordinateHistory(path);
      const limit = request.query.limit ?? 200;
      const fetched = recorder.read(request.runId, { since: request.query.since, limit: limit + 1 });
      const items = fetched.slice(0, limit);
      const last = items.at(-1);
      const page = fetched.length > limit && last
        ? { status: 'more', items, next: last.eventIndex + 1 } satisfies v.InferOutput<typeof EventPageSchema>
        : { status: 'end', items } satisfies v.InferOutput<typeof EventPageSchema>;
      return { view: 'events', path, runId: request.runId, page };
    }
  }
}
