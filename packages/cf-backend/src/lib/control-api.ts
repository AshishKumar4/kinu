/**
 * Typed client for `/api/control/*`.
 *
 * EVERY READ IS PARSED, not asserted. A response body is raw JSON from the
 * network, so a cast would fabricate its shape and then render it — and the
 * shapes here are exactly the ones an operator makes a destructive decision
 * from. The row schemas are declared once, below, and every fetcher names the
 * one it expects.
 *
 * The row TYPES are inferred from those schemas rather than restated, and the
 * schemas mirror the store's own row declarations. That keeps one shape per row
 * on this side of the wire without importing the Durable Object's module graph
 * into the browser bundle.
 *
 * The Kinu session rides along as an HttpOnly cookie, so the fetches are bare —
 * same as `user-api.ts`, whose `api()` helper this mirrors in behaviour and
 * deliberately does not share: that one hard-codes the `/api/user` prefix.
 */
import { JsonValueSchema, pageSchema, type JsonValue, type Page } from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { ControlAction } from '../control-plane/actions';

const ErrorBodySchema = v.object({ error: v.optional(v.string()) });

/* ── The shapes the plane answers with ───────────────────────────────────── */

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
  /** `pending` is an attempt whose outcome was never recorded — the row the
   *  two-phase write leaves behind when a settlement is lost. */
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

/**
 * One panel of the workspace drilldown.
 *
 * The value is `JsonValue` and that is deliberate rather than lazy: the drilldown
 * renders each panel as a count plus its raw JSON, because re-implementing the
 * seven renderers the workspace page already has would be a second view of the
 * same data that drifts from the first. `JsonValue` is the honest domain type for
 * "whatever that RPC returned, rendered generically" — and it is a parsed type,
 * so a malformed body is refused rather than rendered.
 */
const PanelSchema = v.variant('status', [
  v.object({ status: v.literal('ok'), value: JsonValueSchema }),
  v.object({ status: v.literal('failed'), reason: v.string() }),
]);
export type Panel = v.InferOutput<typeof PanelSchema>;

const WorkspaceDetailSchema = v.object({
  workspace: v.string(),
  /** The account the server resolved this read through. Every action button
   *  binds to THIS, not to the address bar, so a control can only act on the
   *  pair the read already proved. */
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

/**
 * The two panels the drilldown renders as ROWS rather than as raw JSON, because
 * they are the two an operator ACTS on.
 *
 * Narrow on purpose: each names exactly the fields a row and its buttons need,
 * and valibot ignores the rest, so the orchestrator can add a field without this
 * page caring. Declared here beside the other row schemas rather than in the
 * component, because everything the browser parses off this plane is parsed in
 * one module.
 */
export const BackgroundJobRowSchema = v.object({
  id: v.string(),
  kind: v.string(),
  label: v.nullable(v.string()),
  status: v.picklist(['running', 'completed', 'failed', 'cancelled']),
  error: v.nullable(v.string()),
  createdAt: v.number(),
  settledAt: v.nullable(v.number()),
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

/** Read a settled panel as typed rows, or answer `null` when it is down or in a
 *  shape this page does not know. `null` is the honest answer for both: the
 *  panel still renders its own reason, and a row view that invented an empty
 *  list would say "no jobs" about a workspace whose job list failed to load. */
export function panelRows<Row>(
  panel: Panel, schema: v.GenericSchema<Row>,
): Row[] | null {
  if (panel.status !== 'ok') return null;
  const parsed = v.safeParse(v.array(schema), panel.value);
  return parsed.success ? parsed.output : null;
}

/** What a drilldown page did about the index it is showing. Three states, not a
 *  boolean: "reconciled", "the registry could not be read" and "page four of a
 *  walk that reconciled at page one" are three different things to tell an
 *  operator who is deciding whether to remove a workspace. */
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

/* ── The transport ───────────────────────────────────────────────────────── */

/**
 * A control-plane request's answer, or why there is none.
 *
 * The admin surface answers 404 to a non-operator on purpose, so the client has
 * to keep "you are not an operator" apart from "that record does not exist" —
 * and the page renders the first as a sentence rather than as an empty table.
 * Collapsing them into a thrown error would make the page show "no users" to
 * somebody who simply is not allowed to ask.
 */
export type ControlAnswer<Value> =
  | { status: 'ok'; value: Value }
  | { status: 'forbidden'; reason: string }
  | { status: 'stale-auth'; reason: string }
  | { status: 'unconfigured'; reason: string }
  | { status: 'failed'; reason: string };

async function control<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  init: RequestInit = {},
): Promise<ControlAnswer<v.InferOutput<Schema>>> {
  const response = await fetch(`/api/control${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body = await tolerateAsync(() => response.json(), 'malformed-input');
  if (response.ok) {
    const parsed = v.safeParse(schema, body);
    return parsed.success
      ? { status: 'ok', value: parsed.output }
      // Named rather than thrown: a body this client cannot read is a version
      // skew between the page and the Worker, and saying so is more useful than
      // an exception with a valibot path in it.
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

/** Build a `?cursor=&limit=` query from a cursor the previous page returned. */
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

/** One account's profile plus a PAGE of the workspaces it owns. Cursored like
 *  every other list here: an account with more than the page ceiling had every
 *  row past it unreachable while the page said the table was reconciled. */
export function fetchUserDetail(
  userId: string, cursor: string | null = null, limit?: number,
): Promise<ControlAnswer<UserDetail>> {
  return control(
    UserDetailSchema,
    `/users/${encodeURIComponent(userId)}${pageQuery(cursor, limit)}`,
  );
}

/** Which workspaces a list should carry. Mirrors the store's own filter so the
 *  query string and the store agree on what an absent `userId` means. */
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

/** One workspace, named by the account that owns it. The `userId` is required
 *  because a workspace name is unique inside one UserDO and `OrchestratorAgent`
 *  is addressed globally — the pair is the address, the name alone is a guess. */
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
  /** Re-run the queries rather than answering from the 30-second batch cache.
   *  The view's refresh button is the one caller. */
  refresh?: boolean,
): Promise<ControlAnswer<ControlMetrics>> {
  const params = new URLSearchParams({ hours: String(hours) });
  if (workspace !== undefined && workspace.length > 0) params.set('workspace', workspace);
  if (refresh === true) params.set('refresh', '1');
  return control(ControlMetricsSchema, `/metrics?${params.toString()}`);
}

/**
 * Run one admin action.
 *
 * A `stale-auth` answer is the expected path rather than an error: the step-up
 * window is five minutes and an operator who left the tab open will hit it, so
 * the page turns it into "sign in again" instead of a red box.
 */
export function runAction(action: ControlAction): Promise<ControlAnswer<ActionAnswer>> {
  return control(ActionAnswerSchema, '/actions', {
    method: 'POST', body: JSON.stringify(action),
  });
}
