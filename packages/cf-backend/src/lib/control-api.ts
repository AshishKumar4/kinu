/**
 * Typed client for `/api/control/*`. Every read is parsed, never cast: operators make destructive decisions from these.
 * Schemas mirror the store rows without importing the DO module graph into the browser bundle.
 */
import { JsonValueSchema, pageSchema, type JsonValue, type Page } from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { ControlAction } from '../control-plane/actions';

const ErrorBodySchema = v.object({ error: v.optional(v.string()) });

const ControlUserRowSchema = v.object({
  userId: v.string(),
  email: v.string(),
  displayName: v.nullable(v.string()),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
  workspaces: v.number(),
});

export type ControlUserRow = v.InferOutput<typeof ControlUserRowSchema>;

const ControlWorkspaceRowSchema = v.object({
  userId: v.string(),
  email: v.string(),
  name: v.string(),
  displayName: v.string(),
  createdAt: v.number(),
  lastSeenAt: v.number(),
  removedAt: v.nullable(v.number()),
});

export type ControlWorkspaceRow = v.InferOutput<typeof ControlWorkspaceRowSchema>;

const ControlFeedbackRowSchema = v.object({
  id: v.string(),
  createdAt: v.number(),
  userId: v.string(),
  email: v.string(),
  note: v.string(),
  route: v.string(),
  workspace: v.nullable(v.string()),
  objectKey: v.nullable(v.string()),
  contentType: v.nullable(v.string()),
  bytes: v.nullable(v.number()),
  userAgent: v.nullable(v.string()),
});

export type ControlFeedbackRow = v.InferOutput<typeof ControlFeedbackRowSchema>;

const ControlAuditRowSchema = v.object({
  id: v.string(),
  at: v.number(),
  actorEmail: v.string(),
  actorUserId: v.string(),
  operation: v.string(),
  targetKind: v.string(),
  target: v.string(),
  /** `pending`: the two-phase write's outcome was never recorded. */
  outcome: v.picklist(['pending', 'ok', 'denied', 'failed']),
  detail: v.string(),
});

export type ControlAuditRow = v.InferOutput<typeof ControlAuditRowSchema>;

const ControlOverviewSchema = v.object({
  users: v.number(),
  workspaces: v.number(),
  workspacesRemoved: v.number(),
  feedback: v.number(),
  auditEntries: v.number(),
  lastAdminActionAt: v.nullable(v.number()),
  activeUsers24h: v.number(),
  activeUsers7d: v.number(),
});

export type ControlOverview = v.InferOutput<typeof ControlOverviewSchema>;

const MonitorIncidentSchema = v.object({
  probe: v.string(),
  detail: v.string(),
  openedAt: v.number(),
  alertedAt: v.nullable(v.number()),
  failures: v.number(),
});

export type MonitorIncident = v.InferOutput<typeof MonitorIncidentSchema>;

const IncidentsSchema = v.object({ incidents: v.array(MonitorIncidentSchema) });

/** `JsonValue` on purpose: panels render as count plus raw JSON rather than duplicating the workspace page's renderers. */
const PanelSchema = v.variant('status', [
  v.object({ status: v.literal('ok'), value: JsonValueSchema }),
  v.object({ status: v.literal('failed'), reason: v.string() }),
]);

export type Panel = v.InferOutput<typeof PanelSchema>;

const WorkspaceDetailSchema = v.object({
  workspace: v.string(),
  /** Action buttons bind to this, not the address bar, so a control acts only on the pair the read proved. */
  userId: v.string(),
  runs: PanelSchema,
  activity: PanelSchema,
  jobs: PanelSchema,
  approvals: PanelSchema,
  consents: PanelSchema,
  executors: PanelSchema,
  shellGrants: PanelSchema,
});

export type WorkspaceDetail = v.InferOutput<typeof WorkspaceDetailSchema>;

/** The two panels an operator acts on, rendered as rows. Narrow on purpose: valibot ignores extra fields. */
export const BackgroundJobRowSchema = v.object({
  id: v.string(),
  kind: v.string(),
  label: v.nullable(v.string()),
  status: v.picklist(['running', 'completed', 'failed', 'cancelled']),
  error: v.nullable(v.string()),
  createdAt: v.number(),
  settledAt: v.nullable(v.number()),
  // Optional by contract: this page parses answers from orchestrators it does not deploy with.
  resumeAttempts: v.optional(v.number()),
  resumeAfter: v.optional(v.nullable(v.number())),
});

export type BackgroundJobRow = v.InferOutput<typeof BackgroundJobRowSchema>;

export const DeferredApprovalRowSchema = v.object({
  id: v.string(),
  command: v.string(),
  executor: v.string(),
  reason: v.string(),
  status: v.picklist(['queued', 'approved', 'denied']),
  requestedAt: v.number(),
  decidedAt: v.nullable(v.number()),
});

export type DeferredApprovalRow = v.InferOutput<typeof DeferredApprovalRowSchema>;

/** `null` when down or unknown-shaped: an invented empty list would say "no jobs" about a failed load. */
export function panelRows<Row>(
  panel: Panel, schema: v.GenericSchema<Row>,
): Row[] | null {
  if (panel.status !== 'ok') return null;
  const parsed = v.safeParse(v.array(schema), panel.value);

  return parsed.success ? parsed.output : null;
}

/** Three states (reconciled, registry unreadable, reconciled on an earlier page), not a boolean. */
const ReconcileSchema = v.variant('status', [
  v.object({ status: v.literal('ok') }),
  v.object({ status: v.literal('failed'), reason: v.string() }),
  v.object({ status: v.literal('skipped'), reason: v.string() }),
]);

export type ReconcileReport = v.InferOutput<typeof ReconcileSchema>;

const UserDetailSchema = v.object({
  user: v.nullable(ControlUserRowSchema),
  workspaces: pageSchema(ControlWorkspaceRowSchema),
  reconcile: ReconcileSchema,
  viewer: v.string(),
});

export type UserDetail = v.InferOutput<typeof UserDetailSchema>;

const AnalyticsResultSchema = v.variant('status', [
  v.object({ status: v.literal('ok'), rows: v.array(v.record(v.string(), v.union([
    v.string(), v.number(), v.boolean(), v.null(),
  ]))) }),
  v.object({ status: v.literal('unconfigured'), missing: v.array(v.string()) }),
  v.object({ status: v.literal('failed'), reason: v.string() }),
]);

const ControlMetricsSchema = v.object({
  windowHours: v.number(),
  missing: v.array(v.string()),
  panels: v.record(v.string(), AnalyticsResultSchema),
});

export type ControlMetrics = v.InferOutput<typeof ControlMetricsSchema>;

export type AnalyticsPanel = v.InferOutput<typeof AnalyticsResultSchema>;

const ActionAnswerSchema = v.object({
  outcome: v.picklist(['ok', 'denied', 'failed']),
  detail: v.string(),
});

export type ActionAnswer = v.InferOutput<typeof ActionAnswerSchema>;

export type { ControlAction, JsonValue };

/**
 * The admin surface answers 404 to non-operators, so "not an operator" stays apart from "no such record";
 * throwing would show "no users" to someone not allowed to ask.
 */
export type ControlAnswer<Value> =
  | { status: 'ok'; value: Value }
  | { status: 'forbidden'; reason: string }
  | { status: 'stale-auth'; reason: string }
  | { status: 'unconfigured'; reason: string }
  | { status: 'failed'; reason: string };

interface ControlRequest {
  method?: string;
  body?: string;
}

async function control<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  init: ControlRequest = {},
): Promise<ControlAnswer<v.InferOutput<Schema>>> {
  const response = await fetch(`/api/control${path}`, {
    ...init,
    headers: { 'content-type': 'application/json' },
  });

  const body = await tolerateAsync(() => response.json(), 'malformed-input');

  if (response.ok) {
    const parsed = v.safeParse(schema, body);

    return parsed.success
      ? { status: 'ok', value: parsed.output }
      // A body this client cannot read is page/Worker version skew; say so rather than throw a valibot path.
      : { status: 'failed', reason: 'the control plane answered in a shape this page cannot read' };
  }

  const error = v.safeParse(ErrorBodySchema, body);

  const reason = (error.success ? error.output.error : undefined)
    ?? `HTTP ${String(response.status)}`;

  if (response.status === 404) return { status: 'forbidden', reason };

  if (response.status === 403) return { status: 'stale-auth', reason };

  if (response.status === 503) return { status: 'unconfigured', reason };

  return { status: 'failed', reason };
}

function pageQuery(cursor: string | null, limit?: number): string {
  const params = new URLSearchParams();

  if (cursor !== null) params.set('cursor', cursor);

  if (limit !== undefined) params.set('limit', String(limit));
  const query = params.toString();

  return query.length > 0 ? `?${query}` : '';
}

export function fetchOverview(): Promise<ControlAnswer<ControlOverview>> {
  return control(ControlOverviewSchema, '/overview');
}

export function fetchUsers(
  cursor: string | null = null, limit?: number,
): Promise<ControlAnswer<Page<ControlUserRow>>> {
  return control(pageSchema(ControlUserRowSchema), `/users${pageQuery(cursor, limit)}`);
}

/** Cursored: rows past the page ceiling must stay reachable. */
export function fetchUserDetail(
  userId: string, cursor: string | null = null, limit?: number,
): Promise<ControlAnswer<UserDetail>> {
  return control(
    UserDetailSchema,
    `/users/${encodeURIComponent(userId)}${pageQuery(cursor, limit)}`,
  );
}

/** Mirrors the store's filter so both agree on what an absent `userId` means. */
export interface WorkspaceListQuery {
  cursor?: string | null;
  limit?: number;
  userId?: string;
  includeRemoved?: boolean;
}

export function fetchWorkspaces(
  options: WorkspaceListQuery = {},
): Promise<ControlAnswer<Page<ControlWorkspaceRow>>> {
  const params = new URLSearchParams();

  if (options.cursor !== undefined && options.cursor !== null) params.set('cursor', options.cursor);

  if (options.limit !== undefined) params.set('limit', String(options.limit));

  if (options.userId !== undefined) params.set('userId', options.userId);

  if (options.includeRemoved === true) params.set('includeRemoved', '1');
  const query = params.toString();

  return control(
    pageSchema(ControlWorkspaceRowSchema),
    `/workspaces${query.length > 0 ? `?${query}` : ''}`,
  );
}

/** `userId` is required: names are unique only per UserDO and `OrchestratorAgent` is addressed globally. */
export function fetchWorkspaceDetail(
  userId: string, name: string,
): Promise<ControlAnswer<WorkspaceDetail>> {
  return control(
    WorkspaceDetailSchema,
    `/workspaces/${encodeURIComponent(name)}?userId=${encodeURIComponent(userId)}`,
  );
}

export function fetchIncidents(): Promise<ControlAnswer<{ incidents: MonitorIncident[] }>> {
  return control(IncidentsSchema, '/incidents');
}

export function fetchFeedback(
  cursor: string | null = null, limit?: number,
): Promise<ControlAnswer<Page<ControlFeedbackRow>>> {
  return control(pageSchema(ControlFeedbackRowSchema), `/feedback${pageQuery(cursor, limit)}`);
}

export function fetchAudit(
  cursor: string | null = null, limit?: number,
): Promise<ControlAnswer<Page<ControlAuditRow>>> {
  return control(pageSchema(ControlAuditRowSchema), `/audit${pageQuery(cursor, limit)}`);
}

export function fetchMetrics(
  hours: number,
  workspace?: string,
  /** Bypass the batch cache; the view's refresh button is the one caller. */
  refresh?: boolean,
): Promise<ControlAnswer<ControlMetrics>> {
  const params = new URLSearchParams({ hours: String(hours) });

  if (workspace !== undefined && workspace.length > 0) params.set('workspace', workspace);

  if (refresh === true) params.set('refresh', '1');

  return control(ControlMetricsSchema, `/metrics?${params.toString()}`);
}

/** `stale-auth` is expected (step-up window lapses with the tab open); the page turns it into "sign in again". */
export function runAction(action: ControlAction): Promise<ControlAnswer<ActionAnswer>> {
  return control(ActionAnswerSchema, '/actions', {
    method: 'POST', body: JSON.stringify(action),
  });
}
