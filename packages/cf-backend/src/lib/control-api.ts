/**
 * Typed client for `/api/control/*`. Every read is parsed, never cast: operators make destructive decisions from these.
 * Rows are parsed by the store's own schemas; the envelopes below are this page's narrow projections.
 */
import { Effect } from 'effect';
import { AccountLimitsSchema, JsonValueSchema, pageSchema, type JsonValue, type Page } from '@kinu.run/core';
import {
  ControlAuditRowSchema, ControlMetricsSchema, ControlOverviewSchema, ControlUserRowSchema, ControlWorkspaceRowSchema,
  ControlFeedbackRowSchema, MonitorIncidentSchema, type ControlAuditRow, type ControlFeedbackRow, type ControlMetrics,
  type ControlOverview, type ControlWorkspaceRow, type MonitorIncident,
} from '@kinu.run/core/control-plane';
import { settle, tolerateAsync } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { ControlAction } from '../control-plane/actions';
import { refusal, respond } from './http';

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
  status: v.picklist(['running', 'serving', 'completed', 'failed', 'cancelled']),
  error: v.nullable(v.string()),
  createdAt: v.number(),
  settledAt: v.nullable(v.number()),
  // Optional by contract: this page parses answers from orchestrators it does not deploy with. The lease epoch is the
  // times the job was interrupted and re-driven.
  epoch: v.optional(v.number()),
  resumeAfter: v.optional(v.nullable(v.number())),
});

export type BackgroundJobRow = v.InferOutput<typeof BackgroundJobRowSchema>;

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

/** An account's row with its limits read in its own object; null where that object could not be read. */
const AccountRowSchema = v.object({ ...ControlUserRowSchema.entries, limits: v.nullable(AccountLimitsSchema) });

export type AccountRow = v.InferOutput<typeof AccountRowSchema>;

const UserDetailSchema = v.object({
  user: v.nullable(ControlUserRowSchema),
  workspaces: pageSchema(ControlWorkspaceRowSchema),
  reconcile: ReconcileSchema,
  limits: AccountLimitsSchema,
  viewer: v.string(),
});

type UserDetail = v.InferOutput<typeof UserDetailSchema>;

const ActionAnswerSchema = v.object({
  outcome: v.picklist(['ok', 'denied', 'failed']),
  detail: v.string(),
  /** What an action made, where it made something to hand on: an invite link's path. */
  result: v.optional(JsonValueSchema),
});

type ActionAnswer = v.InferOutput<typeof ActionAnswerSchema>;

export type { ControlAction, JsonValue };

/**
 * The admin surface answers 404 to non-operators, so "not an operator" stays apart from "no such record";
 * throwing would show "no users" to someone not allowed to ask.
 */
export type ControlAnswer<Value> =
  | { status: 'ok'; value: Value }
  | { status: 'forbidden'; reason: string }
  | { status: 'stale-auth'; reason: string }
  | { status: 'access-expired'; reason: string }
  | { status: 'unconfigured'; reason: string }
  | { status: 'failed'; reason: string };

export const ACCESS_EXPIRED = 'Your Access sign-in expired: sign in again';

function control<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  asked: { readonly method?: string; readonly json?: ControlAction } = {},
): Effect.Effect<ControlAnswer<v.InferOutput<Schema>>> {
  const url = `/api/control${path}`;

  return Effect.gen(function* () {
    // Cloudflare Access fronts this route: once its sign-in lapses it redirects to its own origin, which a fetch may not
    // follow ("Failed to fetch"). Held, the redirect is the answer, and only a page load can sign in again.
    const response = yield* respond(url, { ...asked, redirect: 'manual' });

    if (response.type === 'opaqueredirect') return { status: 'access-expired', reason: ACCESS_EXPIRED };

    if (!response.ok) {
      const { message: reason } = yield* refusal(response, asked.method ?? 'GET', url);

      if (response.status === 404) return { status: 'forbidden', reason };

      if (response.status === 403) return { status: 'stale-auth', reason };

      if (response.status === 503) return { status: 'unconfigured', reason };

      return { status: 'failed', reason };
    }

    const parsed = v.safeParse(schema, yield* Effect.promise(() => tolerateAsync(() => response.json(), 'malformed-input')));

    return parsed.success
      ? { status: 'ok', value: parsed.output }
      // A body this client cannot read is page/Worker version skew; say so rather than throw a valibot path.
      : { status: 'failed', reason: 'the control plane answered in a shape this page cannot read' };
  });
}

function pageQuery(cursor: string | null, limit?: number): string {
  const params = new URLSearchParams();

  if (cursor !== null) params.set('cursor', cursor);

  if (limit !== undefined) params.set('limit', String(limit));
  const query = params.toString();

  return query.length > 0 ? `?${query}` : '';
}

export function fetchOverview(): Promise<ControlAnswer<ControlOverview>> {
  return settle(control(ControlOverviewSchema, '/overview'));
}

export function fetchUsers(
  cursor: string | null = null, limit?: number,
): Promise<ControlAnswer<Page<AccountRow>>> {
  return settle(control(pageSchema(AccountRowSchema), `/users${pageQuery(cursor, limit)}`));
}

/** Cursored: rows past the page ceiling must stay reachable. */
export function fetchUserDetail(
  userId: string, cursor: string | null = null, limit?: number,
): Promise<ControlAnswer<UserDetail>> {
  return settle(control(
    UserDetailSchema,
    `/users/${encodeURIComponent(userId)}${pageQuery(cursor, limit)}`,
  ));
}

/** Mirrors the store's filter so both agree on what an absent `userId` means. */
interface WorkspaceListQuery {
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

  return settle(control(
    pageSchema(ControlWorkspaceRowSchema),
    `/workspaces${query.length > 0 ? `?${query}` : ''}`,
  ));
}

/** `userId` is required: names are unique only per UserDO and `OrchestratorAgent` is addressed globally. */
export function fetchWorkspaceDetail(
  userId: string, name: string,
): Promise<ControlAnswer<WorkspaceDetail>> {
  return settle(control(
    WorkspaceDetailSchema,
    `/workspaces/${encodeURIComponent(name)}?userId=${encodeURIComponent(userId)}`,
  ));
}

export function fetchIncidents(): Promise<ControlAnswer<{ incidents: MonitorIncident[] }>> {
  return settle(control(IncidentsSchema, '/incidents'));
}

export function fetchFeedback(
  cursor: string | null = null, limit?: number,
): Promise<ControlAnswer<Page<ControlFeedbackRow>>> {
  return settle(control(pageSchema(ControlFeedbackRowSchema), `/feedback${pageQuery(cursor, limit)}`));
}

export function fetchAudit(
  cursor: string | null = null, limit?: number,
): Promise<ControlAnswer<Page<ControlAuditRow>>> {
  return settle(control(pageSchema(ControlAuditRowSchema), `/audit${pageQuery(cursor, limit)}`));
}

export function fetchMetrics(hours: number, workspace?: string): Promise<ControlAnswer<ControlMetrics>> {
  const params = new URLSearchParams({ hours: String(hours) });

  if (workspace !== undefined && workspace.length > 0) params.set('workspace', workspace);

  return settle(control(ControlMetricsSchema, `/metrics?${params.toString()}`));
}

/** `stale-auth` is expected (step-up window lapses with the tab open); the page turns it into "sign in again". */
export function runAction(action: ControlAction): Promise<ControlAnswer<ActionAnswer>> {
  return settle(control(ActionAnswerSchema, '/actions', { method: 'POST', json: action }));
}
