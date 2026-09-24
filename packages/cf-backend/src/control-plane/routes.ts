/** `/api/control/*`: the operator gate is the first middleware; Access, the app's first gate, sets the required `access`. One audited mutation endpoint. */
import { Hono, type Context } from 'hono';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import type { Page, PageRequest } from '@kinu.run/core';
import * as v from 'valibot';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from '../user/user-do';
import { err, json, safeJson } from '@kinu.run/core';
import { ownerCaller } from '@kinu.run/core';
import { MONITOR_SINGLETON, type MonitorDO } from '../monitor/monitor-do';
import {
  actorDigest, adminCaller, adminDenialMessage, adminDenialStatus, authorizeAdmin,
  reportAdminDenial, type AdminGateEnv, type AuthorizedAdmin, type ControlCaller,
} from './admin-caller';
import { rawParam, type ApiVariables, type FamilyEnv } from '../api/context';
import { controlPlaneStub } from './stub';
import {
  ControlActionSchema, describeAction, runControlAction, UserIdSchema,
  type ActionEnv, type ActionIdentity, type ActionRegistry, type ActionTarget,
} from './actions';
import { controlPlaneMetrics } from '@kinu.run/core/control-plane';
import type { AnalyticsSqlEnv, MetricsRequest } from '@kinu.run/core/control-plane';
import type {
  AuditOutcome, AuditSettlement, ControlAuditRow, ControlPlaneDO, OperationMarker,
} from './control-plane-do';
import type {
  AuditDraft, RosterWorkspace, WorkspaceFilter,
} from '@kinu.run/core/control-plane';
import type { IndexFeedSink } from './index-feed';
import type { ObjectNamespace } from '@kinu.run/core';

/** Panels show a recent window; history has its own cursored route on the workspace. */
const DETAIL_WINDOW = 25;

const INCIDENT_MAX = 100;

type ControlPlaneReach = IndexFeedSink & Pick<ControlPlaneDO,
  | 'overview'
  | 'listUsers'
  | 'getUser'
  | 'listWorkspaces'
  | 'listFeedback'
  | 'listAudit'
  | 'replaceUserWorkspaces'
  | 'recordAudit'
  | 'settleAudit'
>;

type ControlTarget = ActionTarget & Pick<OrchestratorAgent,
  | 'getRunSummaries'
  | 'getActivitySnapshot'
  | 'listBackgroundJobs'
  | 'listDeferredApprovals'
  | 'listPendingConsents'
  | 'getExecutors'
>;

type ControlRegistry = ActionRegistry & Pick<UserDO, 'listWorkspaces'>;

export interface ControlEnv<Id> extends ActionEnv<Id>, AdminGateEnv, AnalyticsSqlEnv {
  ControlPlaneDO: ObjectNamespace<Id, ControlPlaneReach>;
  OrchestratorAgent: ObjectNamespace<Id, ControlTarget>;
  UserDO: ObjectNamespace<Id, ControlRegistry>;
  MonitorDO: ObjectNamespace<Id, Pick<MonitorDO, 'listIncidents'>>;
}

interface ControlContext<Id> {
  env: ControlEnv<Id>;
  admin: AuthorizedAdmin;
  caller: ControlCaller;
}

interface ControlVariables extends ApiVariables {
  control: ControlContext<unknown>;
}

type ControlContextOf = Context<FamilyEnv<ControlEnv<unknown>, ControlVariables>>;

/** Each section answers its whole subtree. */
export const controlRoutes = new Hono<FamilyEnv<ControlEnv<unknown>, ControlVariables>>();

// Past the operator gate a throw is recorded and answered 500.
controlRoutes.onError((cause, c) => {
  diagnostics.failure('control_plane.request_failed', toKinuError({
    doing: 'serving an admin control-plane request',
    cause,
    otherwise: 'unavailable',
  }), { path: new URL(c.req.url).pathname, method: c.req.method });

  return err(500, renderThrownChain({ cause }));
});

// Reader first: a stale operator is refused, and audited, at `handleAction`'s mutation check.
controlRoutes.use('/api/control/*', async (c, next) => {
  const authorization = authorizeAdmin(c.env, c.get('identity'), c.get('access'), { mutating: false });

  if (!authorization.ok) {
    reportAdminDenial(authorization.denial, new URL(c.req.url).pathname, c.req.method);

    return err(adminDenialStatus(authorization.denial), adminDenialMessage(authorization.denial));
  }

  const admin = authorization.admin;
  c.set('control', { env: c.env, admin, caller: await adminCaller(c.env, admin) });
  await next();
});

controlRoutes.post('/api/control/actions/*', async (c) => {
  const { env, admin, caller } = c.get('control');

  return handleAction(c.req.raw, env, admin, caller);
});

controlRoutes.post('/api/control/*', async () => err(404, 'Not found'));

controlRoutes.get('/api/control/overview/*', async (c) => {
  const { env, caller } = c.get('control');

  return json({ body: await controlPlaneStub(env).overview(caller) });
});

controlRoutes.get('/api/control/users/:userId/*', async (c) => handleUserDetail(c.get('control'), rawParam(c, 'userId'), new URL(c.req.url)));

controlRoutes.get('/api/control/users/*', pagedRead((store, caller, page) => store.listUsers(caller, page)));

controlRoutes.get('/api/control/workspaces/:name/*', async (c) => {
  const name = decodeURIComponent(rawParam(c, 'name'));
  // Required: without `?userId=` the name resolves whichever account's global DO holds it.
  const owner = new URL(c.req.url).searchParams.get('userId');

  if (owner === null || !v.is(UserIdSchema, owner)) {
    return err(400, 'a workspace read must name the account that owns it (?userId=)');
  }

  return handleWorkspaceDetail(c.get('control').env, owner, name);
});

controlRoutes.get('/api/control/workspaces/*', async (c) => workspaceList(c));

controlRoutes.get('/api/control/incidents/*', async (c) => json({
  body: {
    incidents: await c.env.MonitorDO
      .get(c.env.MonitorDO.idFromName(MONITOR_SINGLETON))
      .listIncidents(INCIDENT_MAX),
  },
}));

controlRoutes.get('/api/control/feedback/*', pagedRead((store, caller, page) => store.listFeedback(caller, page)));

controlRoutes.get('/api/control/audit/*', pagedRead((store, caller, page) => store.listAudit(caller, page)));

controlRoutes.get('/api/control/metrics/*', async (c) => {
  const url = new URL(c.req.url);
  const ask: MetricsRequest = { hours: numberParam(url, 'hours') ?? 24 };
  const workspace = url.searchParams.get('workspace');

  if (workspace !== null) ask.workspace = workspace;

  if (url.searchParams.get('refresh') === '1') ask.forceRefresh = true;

  return json({ body: await controlPlaneMetrics(c.env, ask) });
});

controlRoutes.get('/api/control/*', async () => err(404, 'Not found'));

controlRoutes.all('/api/control/*', async () => err(405, 'GET or POST'));

/** A cursored index read. */
function pagedRead<Body>(read: (store: ControlPlaneReach, caller: ControlCaller, page: PageRequest) => Promise<Body>) {
  return async (c: ControlContextOf): Promise<Response> => {
    const { env, caller } = c.get('control');

    return json({ body: await read(controlPlaneStub(env), caller, pageQuery(new URL(c.req.url))) });
  };
}

async function workspaceList(c: ControlContextOf): Promise<Response> {
  const { env, caller } = c.get('control');
  const url = new URL(c.req.url);

  // An absent `?userId=` must leave the property absent: `userId: ''` matches no account.
  const filter: WorkspaceFilter = {
    includeRemoved: url.searchParams.get('includeRemoved') === '1',
  };

  const userId = url.searchParams.get('userId');

  if (userId !== null) filter.userId = userId;

  return json({ body: await controlPlaneStub(env).listWorkspaces(caller, pageQuery(url), filter) });
}

/**
 * The intent row is written before the mutation and a failed write stops it; a lost settlement
 * stays visible as pending (`listPendingAudit`). Stale sign-ins and malformed bodies are audited too.
 */
async function handleAction<Id>(
  request: Request,
  env: ControlEnv<Id>,
  admin: AuthorizedAdmin,
  caller: ControlCaller,
): Promise<Response> {
  const body = await safeJson(request, ControlActionSchema);

  if (body === null) {
    return await refuse({ env, admin, caller }, {
      operation: 'action_rejected', targetKind: 'request', target: '',
    }, {
      status: 400,
      message: 'unrecognized control action',
      detail: 'the request body is not a recognized control action',
      reason: 'unrecognized_action',
    });
  }

  const described = describeAction(body);

  if (!admin.fresh) {
    return await refuse({ env, admin, caller }, described, {
      status: 403,
      message: adminDenialMessage('stale_auth'),
      detail: 'refused: the sign-in was not fresh',
      reason: 'stale_auth',
    });
  }

  // PHASE ONE. Nothing below this line runs unless the attempt is on the record.
  let intent: ControlAuditRow;

  try {
    intent = await appendAudit(env, admin, caller, { ...described, outcome: 'pending', detail: PENDING_DETAIL });
  } catch (cause) {
    reportAuditFailure('intent', { cause }, described.operation);

    return err(503, AUDIT_UNAVAILABLE);
  }

  const outcome = await runControlAction(env, body);

  // PHASE TWO. The action has already happened; this records how it ended.
  try {
    const settlement: AuditSettlementRequest = {
      id: intent.id,
      outcome: outcome.outcome,
      detail: outcome.detail,
      actorDigest: await actorDigest(env, admin.email),
      reason: outcome.reason,
      code: outcome.code,
    };

    await controlPlaneStub(env).settleAudit(caller, settlement);
  } catch (cause) {
    reportAuditFailure('settle', { cause }, described.operation);

    // Not a success: the audit row is unfinished.
    return err(500, `${AUDIT_UNSETTLED} (audit row ${intent.id})`);
  }

  const status = ACTION_STATUS[outcome.outcome];

  return json({ body: { outcome: outcome.outcome, detail: outcome.detail } }, { status });
}

/** An owning-object refusal is 409, not 500: well-formed, authorized, and the state said no. */
const ACTION_STATUS: Readonly<Record<AuditSettlement, number>> = { ok: 200, denied: 409, failed: 502 };

const PENDING_DETAIL = 'in flight: the outcome has not been recorded';

const AUDIT_UNAVAILABLE =
  'the admin audit log could not record this attempt, so nothing was run';

const AUDIT_UNSETTLED =
  'the action ran and its outcome could not be recorded; the attempt is still pending in the audit log';

/** One terminal row, no pending phase; the audit write is still fail-closed. */
async function refuse<Id>(
  control: ControlContext<Id>,
  identity: ActionIdentity,
  refusal: { status: number; message: string; detail: string; reason: string },
): Promise<Response> {
  const { env, admin, caller } = control;

  try {
    await appendAudit(env, admin, caller, {
      ...identity, outcome: 'denied', detail: refusal.detail, reason: refusal.reason,
    });
  } catch (cause) {
    reportAuditFailure('intent', { cause }, identity.operation);

    return err(503, AUDIT_UNAVAILABLE);
  }

  return err(refusal.status, refusal.message);
}

/** Throws on failure; every caller treats that as fatal to the request. */
interface AuditSettlementRequest extends OperationMarker {
  id: string;
  outcome: AuditSettlement;
  detail: string;
}

async function appendAudit<Id>(
  env: ControlEnv<Id>,
  admin: AuthorizedAdmin,
  caller: ControlCaller,
  entry: ActionIdentity & { outcome: AuditOutcome; detail: string; reason?: string },
): Promise<ControlAuditRow> {
  const draft: AuditDraft & OperationMarker = {
    actorEmail: admin.email,
    actorUserId: admin.userId,
    actorDigest: await actorDigest(env, admin.email),
    operation: entry.operation,
    targetKind: entry.targetKind,
    target: entry.target,
    outcome: entry.outcome,
    detail: entry.detail,
  };

  if (entry.reason !== undefined) draft.reason = entry.reason;

  return await controlPlaneStub(env).recordAudit(caller, draft);
}

/** Both audit phases share one searchable event; phase stays queryable. */
function reportAuditFailure(
  phase: 'intent' | 'settle', failure: { cause: unknown }, operation: string,
): void {
  diagnostics.failure('control_plane.audit_write_failed', toKinuError({
    doing: 'writing an admin audit row',
    cause: failure.cause,
    otherwise: 'unavailable',
  }), { operation, phase });
}

/**
 * Reconciles on the first page only: `replaceUserWorkspaces` rewrites `last_seen_at`, the cursor's
 * order column, so reconciling mid-walk would repeat and skip rows.
 */
async function handleUserDetail<Id>(control: ControlContext<Id>, userId: string, url: URL): Promise<Response> {
  const { env, admin, caller } = control;

  // Same shape the action schema demands, so drilldown and actions agree on a userId.
  if (!v.is(UserIdSchema, userId)) return err(400, 'not a user id');
  const stub = controlPlaneStub(env);
  const user = await stub.getUser(caller, userId);

  const request = pageQuery(url);
  const reconcile = await reconcileRoster(env, caller, userId, request.cursor === undefined);
  const workspaces = await stub.listWorkspaces(caller, request, { userId, includeRemoved: true });

  return json({ body: { user, workspaces, reconcile, viewer: admin.email } });
}

export type ReconcileReport =
  | { status: 'ok' }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string };

const CONTINUATION = 'this walk reconciled on its first page; these rows are from that same read';

async function reconcileRoster<Id>(
  env: ControlEnv<Id>,
  caller: ControlCaller,
  userId: string,
  firstPage: boolean,
): Promise<ReconcileReport> {
  if (!firstPage) return { status: 'skipped', reason: CONTINUATION };
  const roster = await readRoster(env, userId);

  if (roster.status !== 'ok') return { status: 'failed', reason: roster.reason };
  await controlPlaneStub(env).replaceUserWorkspaces(caller, userId, roster.workspaces);

  return { status: 'ok' };
}

type RosterRead =
  | { status: 'ok'; workspaces: RosterWorkspace[] }
  | { status: 'failed'; reason: string };

/**
 * Walks every roster page, else rows past `WORKSPACE_LIST_LIMIT` get tombstoned. Page-count bounded
 * and reports partial. No limit is passed: `clampRosterLimit` throws on values it dislikes.
 */
async function readRoster<Id>(env: ControlEnv<Id>, userId: string): Promise<RosterRead> {
  const MAX_PAGES = 25;

  try {
    const owner = await ownerCaller(env);
    const user = env.UserDO.get(env.UserDO.idFromName(userId));
    const workspaces: RosterWorkspace[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = await user.listWorkspaces(owner, cursor === null ? {} : { cursor });

      for (const row of answer.entries) {
        workspaces.push({
          name: row.name,
          displayName: row.displayName,
          createdAt: row.createdAt,
          lastVisited: row.lastVisited,
        });
      }

      cursor = answer.nextCursor;

      if (cursor === null) return { status: 'ok', workspaces };
    }

    // Tombstoning on a partial read would delete rows that exist, so this is a failure.
    return {
      status: 'failed',
      reason: `the roster did not end within ${String(MAX_PAGES)} pages; the index was left alone`,
    };
  } catch (cause) {
    return { status: 'failed', reason: renderThrownChain({ cause }) };
  }
}

/**
 * Resolved through the owner via `claimOwnedWorkspace`, exactly as an action is. Panels settle
 * independently so one unavailable surface degrades to a stated reason.
 */
async function handleWorkspaceDetail<Id>(
  env: ControlEnv<Id>, userId: string, workspace: string,
): Promise<Response> {
  const owned = await claimOwnedWorkspace(env, userId, workspace);

  if (!owned.ok) return err(owned.status, owned.error);
  const agent = owned.agent;

  const [runs, activity, jobs, approvals, consents, executors, grants] = await Promise.allSettled([
    agent.getRunSummaries({ limit: DETAIL_WINDOW }),
    agent.getActivitySnapshot({ steps: DETAIL_WINDOW, logs: DETAIL_WINDOW }),
    agent.listBackgroundJobs(DETAIL_WINDOW),
    agent.listDeferredApprovals(),
    agent.listPendingConsents(),
    agent.getExecutors(),
    agent.getShellApprovalGrants(),
  ]);

  const detail: WorkspaceDetail = {
    workspace,
    userId,
    runs: settled(runs),
    activity: settled(activity),
    jobs: settled(jobs),
    approvals: settled(approvals),
    consents: settled(consents),
    executors: settled(executors),
    shellGrants: settled(grants),
  };

  return json({ body: detail });
}

/** Never a silent `null`: a missing panel and an empty one are different facts. */
export type SettledPanel<Value> =
  | { status: 'ok'; value: Value }
  | { status: 'failed'; reason: string };

export interface WorkspaceDetail {
  workspace: string;
  /** Echoed so action buttons bind to the pair the read proved, not the address bar. */
  userId: string;
  runs: SettledPanel<Awaited<ReturnType<OrchestratorAgent['getRunSummaries']>>>;
  activity: SettledPanel<Awaited<ReturnType<OrchestratorAgent['getActivitySnapshot']>>>;
  jobs: SettledPanel<Awaited<ReturnType<OrchestratorAgent['listBackgroundJobs']>>>;
  approvals: SettledPanel<Awaited<ReturnType<OrchestratorAgent['listDeferredApprovals']>>>;
  consents: SettledPanel<Awaited<ReturnType<OrchestratorAgent['listPendingConsents']>>>;
  executors: SettledPanel<Awaited<ReturnType<OrchestratorAgent['getExecutors']>>>;
  shellGrants: SettledPanel<Awaited<ReturnType<OrchestratorAgent['getShellApprovalGrants']>>>;
}

function settled<Value>(result: PromiseSettledResult<Value>): SettledPanel<Value> {
  return result.status === 'fulfilled'
    ? { status: 'ok', value: result.value }
    : { status: 'failed', reason: renderThrownChain({ cause: result.reason }) };
}

const CursorParamSchema = v.pipe(v.string(), v.nonEmpty());

/** A malformed limit is dropped (the store clamps); a malformed cursor passes through for the store to refuse. */
function pageQuery(url: URL): PageRequest {
  // Statements, not spreads: `cursor: undefined` would read as present-and-malformed to the store.
  const request: PageRequest = {};
  const cursor = v.safeParse(CursorParamSchema, url.searchParams.get('cursor'));

  if (cursor.success) request.cursor = { after: cursor.output };
  const limit = numberParam(url, 'limit');

  if (limit !== undefined) request.limit = limit;

  return request;
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);

  if (raw === null) return undefined;
  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : undefined;
}

export type { Page, PageRequest };
