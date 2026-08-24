/**
 * `/api/control/*` — the admin control plane's HTTP surface.
 *
 * THE GATE IS IN THIS FILE AND NOWHERE ELSE. Every handler below goes through
 * `admin()` before it touches a binding, and `admin()` is the only place the
 * operator allowlist, the dev-identity refusal and the step-up window are
 * consulted. The backend audit of this Worker recorded that `run-events-routes.ts`
 * relies on an ownership check performed in `server.ts` rather than in its own
 * handlers; that pattern is not copied here, because a route whose authorization
 * lives in its caller is one refactor away from being unguarded.
 *
 * ROUTES
 *   GET  /api/control/overview               fleet counts + last admin action
 *   GET  /api/control/users                  ?cursor=&limit=   cursored
 *   GET  /api/control/users/:userId          profile + that account's live roster,
 *                                            reconciled from its UserDO on read
 *   GET  /api/control/workspaces             ?cursor=&limit=&userId=&includeRemoved=
 *   GET  /api/control/workspaces/:name       runs, spend, jobs, approvals, executors
 *   GET  /api/control/incidents              synthetic-monitoring ledger
 *   GET  /api/control/feedback               ?cursor=&limit=   cursored
 *   GET  /api/control/metrics                ?hours=&workspace=
 *   GET  /api/control/audit                  ?cursor=&limit=   cursored
 *   POST /api/control/actions                the only mutation; fresh auth required
 *
 * ONE MUTATION ENDPOINT, not one per action. The action is a discriminated union
 * validated by `ControlActionSchema`, which is what makes "every mutation is
 * audited" checkable by reading one function instead of trusting eight.
 */
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { getAgentByName } from 'agents';
import type { Page, PageRequest } from '@kinu.run/core';
import * as v from 'valibot';
import type { AuthIdentity } from '../auth/session';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from '../user/user-do';
import { err, json, safeJson } from '../lib/http';
import { ownerCaller } from '../user/workspace-capability';
import { MONITOR_SINGLETON, type MonitorDO } from '../monitor/monitor-do';
import {
  actorDigest, adminCaller, adminDenialMessage, adminDenialStatus, authorizeAdmin,
  reportAdminDenial, type AuthorizedAdmin, type ControlCaller,
} from './admin-caller';
import { controlPlaneStub } from './stub';
import {
  ControlActionSchema, describeAction, runControlAction,
  type ActionEnv, type ActionIdentity,
} from './actions';
import { controlPlaneMetrics, type MetricsRequest } from './metrics';
import { CONTROL_PAGE_MAX, type AuditOutcome } from './control-plane-do';
import type { WorkspaceFilter } from './store';

/** Bound on the per-workspace detail reads. Each is a separate Durable Object
 *  query and the panel shows a recent window, not a history — the history has
 *  its own cursored route on the workspace itself. */
const DETAIL_WINDOW = 25;

/** Incidents are a small ledger — one row per probe — so this is a sanity bound
 *  rather than a page size. */
const INCIDENT_MAX = 100;

export type ControlEnv = ActionEnv & {
  CONTROL_PLANE_ADMINS?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_SQL_API_TOKEN?: string;
  MonitorDO: DurableObjectNamespace<MonitorDO>;
};

/**
 * Route an admin request, or decline the path.
 *
 * Returns `null` for anything outside `/api/control/`, so `server.ts` can hang
 * it in its table the same way every other route module is hung.
 */
export async function handleControlRequest(
  request: Request,
  env: ControlEnv,
  identity: AuthIdentity,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/control/') && url.pathname !== '/api/control') return null;

  // Authorize as a READER first, for every method. A recognized operator whose
  // sign-in has gone stale is authorized here and refused at the mutation check
  // below — which is deliberate, because it is the only way an attempted
  // mutation by a real operator gets an audit row instead of vanishing into a
  // 403.
  const authorization = authorizeAdmin(env, identity, { mutating: false });
  if (!authorization.ok) {
    reportAdminDenial(authorization.denial, url.pathname, request.method);
    return err(adminDenialStatus(authorization.denial), adminDenialMessage(authorization.denial));
  }
  const admin = authorization.admin;

  try {
    const caller = await adminCaller(env, admin);
    return await dispatch(request, env, url, admin, caller);
  } catch (cause) {
    diagnostics.failure('control_plane.request_failed', toKinuError({
      doing: 'serving an admin control-plane request',
      cause,
      otherwise: 'unavailable',
    }), { path: url.pathname, method: request.method });
    return err(500, renderThrownChain({ cause }));
  }
}

async function dispatch(
  request: Request,
  env: ControlEnv,
  url: URL,
  admin: AuthorizedAdmin,
  caller: ControlCaller,
): Promise<Response> {
  const segments = url.pathname.replace(/^\/api\/control\/?/, '').split('/').filter(Boolean);
  const head = segments[0] ?? '';
  const stub = controlPlaneStub(env);

  if (request.method === 'POST') {
    return head === 'actions'
      ? await handleAction(request, env, admin, caller)
      : err(404, 'Not found');
  }
  if (request.method !== 'GET') return err(405, 'GET or POST');

  switch (head) {
    case 'overview':
      return json(await stub.overview(caller));

    case 'users': {
      const userId = segments[1];
      if (userId === undefined) return json(await stub.listUsers(caller, pageQuery(url)));
      return await handleUserDetail(env, admin, caller, userId);
    }

    case 'workspaces': {
      const name = segments[1] === undefined ? undefined : decodeURIComponent(segments[1]);
      if (name === undefined) {
        // Built in statements: an absent `?userId=` must leave the property
        // ABSENT, because the store treats `userId: ''` as a filter that matches
        // no account rather than as no filter at all.
        const filter: WorkspaceFilter = {
          includeRemoved: url.searchParams.get('includeRemoved') === '1',
        };
        const userId = url.searchParams.get('userId');
        if (userId !== null) filter.userId = userId;
        return json(await stub.listWorkspaces(caller, pageQuery(url), filter));
      }
      return json(await workspaceDetail(env, name));
    }

    case 'incidents':
      return json({ incidents: await env.MonitorDO
        .get(env.MonitorDO.idFromName(MONITOR_SINGLETON))
        .listIncidents(INCIDENT_MAX) });

    case 'feedback':
      return json(await stub.listFeedback(caller, pageQuery(url)));

    case 'audit':
      return json(await stub.listAudit(caller, pageQuery(url)));

    case 'metrics': {
      const ask: MetricsRequest = { hours: numberParam(url, 'hours') ?? 24 };
      const workspace = url.searchParams.get('workspace');
      if (workspace !== null) ask.workspace = workspace;
      return json(await controlPlaneMetrics(env, ask));
    }

    default:
      return err(404, 'Not found');
  }
}

/* ── The mutation ────────────────────────────────────────────────────────── */

/**
 * Run one admin action, and write an audit row whichever way it goes.
 *
 * THE ORDER MATTERS AND IT IS THE POINT OF THIS FUNCTION. A stale sign-in, a
 * malformed body and a refusal by the owning object are all audited, because the
 * attempts an operator surface most needs to have recorded are the ones that did
 * not work. Only a caller who never got past `admin()` produces no row, and that
 * one is not an operator action at all — it is reported as
 * `control_plane.denied` instead.
 */
async function handleAction(
  request: Request,
  env: ControlEnv,
  admin: AuthorizedAdmin,
  caller: ControlCaller,
): Promise<Response> {
  const body = await safeJson(request, ControlActionSchema);
  if (body === null) {
    await audit(env, admin, caller, {
      operation: 'action_rejected', targetKind: 'request', target: '',
      outcome: 'denied', detail: 'the request body is not a recognized control action',
    });
    return err(400, 'unrecognized control action');
  }

  const described = describeAction(body);
  if (!admin.fresh) {
    await audit(env, admin, caller, {
      ...described, outcome: 'denied', detail: 'refused: the sign-in was not fresh',
    });
    return err(403, adminDenialMessage('stale_auth'));
  }

  const started = Date.now();
  const outcome = await runControlAction(env, body);
  const entry: AuditRequest = {
    ...described,
    outcome: outcome.outcome,
    detail: outcome.detail,
    durationMs: Date.now() - started,
  };
  if (outcome.affected !== undefined) entry.affected = outcome.affected;
  await audit(env, admin, caller, entry);
  // A refusal by the owning object is a 409, not a 500: the request was
  // well-formed and authorized, and the state said no.
  const status = outcome.outcome === 'ok' ? 200 : outcome.outcome === 'denied' ? 409 : 502;
  return json({ outcome: outcome.outcome, detail: outcome.detail }, { status });
}

/**
 * Append the audit row.
 *
 * A failure to write the row is NOT swallowed into the action's own result: the
 * action either happened or it did not, and losing the record of it is a
 * separate, worse fact that deserves its own reported failure. It cannot undo
 * the action, so it does not pretend to.
 */
interface AuditRequest extends ActionIdentity {
  outcome: AuditOutcome;
  detail: string;
  /** How many things changed. Absent when the action has no count worth
   *  recording, which is different from zero. */
  affected?: number;
  durationMs?: number;
}

async function audit(
  env: ControlEnv,
  admin: AuthorizedAdmin,
  caller: ControlCaller,
  entry: AuditRequest,
): Promise<void> {
  try {
    await controlPlaneStub(env).recordAudit(caller, {
      actorEmail: admin.email,
      actorUserId: admin.userId,
      actorDigest: await actorDigest(env, admin.email),
      operation: entry.operation,
      targetKind: entry.targetKind,
      target: entry.target,
      outcome: entry.outcome,
      detail: entry.detail,
    });
  } catch (cause) {
    diagnostics.failure('control_plane.audit_write_failed', toKinuError({
      doing: 'appending an admin audit row',
      cause,
      otherwise: 'unavailable',
    }), { operation: entry.operation, outcome: entry.outcome });
  }
}

/* ── Reads that reach through to the owning object ───────────────────────── */

/**
 * One account: its index row, and its roster read from the UserDO that owns it.
 *
 * Reconciling on every open is what makes the index safe to be behind. The
 * roster read is the source of truth, `replaceUserWorkspaces` settles the
 * difference, and the response is built from the reconciled rows — so an
 * operator never sees a list this request already knew was stale.
 */
async function handleUserDetail(
  env: ControlEnv,
  admin: AuthorizedAdmin,
  caller: ControlCaller,
  userId: string,
): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(userId)) return err(400, 'not a user id');
  const stub = controlPlaneStub(env);
  const user = await stub.getUser(caller, userId);

  const roster = await readRoster(env, userId);
  if (roster.status === 'ok') {
    await stub.replaceUserWorkspaces(caller, userId, roster.workspaces);
  }
  const workspaces = await stub.listWorkspaces(caller, { limit: CONTROL_PAGE_MAX }, {
    userId, includeRemoved: true,
  });
  return json({
    user,
    workspaces,
    // Stated rather than hidden: a reconcile that could not run means the rows
    // above are the index's own belief, and an operator deciding to remove a
    // workspace should know which of the two they are looking at.
    reconciled: roster.status === 'ok',
    ...(roster.status === 'ok' ? undefined : { reconcileError: roster.reason }),
    viewer: admin.email,
  });
}

/** The subset of a roster entry the index stores. Named because both the walk
 *  and `replaceUserWorkspaces`' parameter are shaped by it. */
interface RosterWorkspace {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
}

type RosterRead =
  | { status: 'ok'; workspaces: RosterWorkspace[] }
  | { status: 'failed'; reason: string };

/**
 * Walk one account's whole roster.
 *
 * `UserDO.listWorkspaces` is cursored and caps a page at its own
 * `WORKSPACE_LIST_LIMIT`, so a reconcile that read one page would silently
 * tombstone every workspace past that limit. The walk is bounded by a page count
 * rather than left open, because an unbounded loop over a remote cursor is a
 * subrequest budget nobody set — and it reports partial rather than pretending,
 * because a reconcile that stopped early must not be allowed to tombstone the
 * rows it never read.
 *
 * No limit is passed: `clampRosterLimit` THROWS on anything it dislikes and
 * caps at its own maximum anyway, so the roster's own default is the right page
 * size and this caller has no business naming one.
 */
async function readRoster(env: ControlEnv, userId: string): Promise<RosterRead> {
  const MAX_PAGES = 25;
  try {
    const owner = await ownerCaller(env);
    const user: DurableObjectStub<UserDO> = env.UserDO.get(env.UserDO.idFromName(userId));
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
    // The walk ran out of pages before the roster ran out of rows. Tombstoning
    // on a partial read would delete rows that exist, so this is a failure.
    return {
      status: 'failed',
      reason: `the roster did not end within ${String(MAX_PAGES)} pages; the index was left alone`,
    };
  } catch (cause) {
    return { status: 'failed', reason: renderThrownChain({ cause }) };
  }
}

/**
 * One workspace, read from the Durable Object that owns it.
 *
 * Every field comes from an existing `@callable`. Each is settled independently
 * so one unavailable surface degrades to a stated reason instead of blanking the
 * page — a workspace whose sandbox is down still has runs, jobs and approvals
 * worth reading, and that is exactly the workspace an operator is looking at.
 */
async function workspaceDetail(env: ControlEnv, workspace: string): Promise<WorkspaceDetail> {
  const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, workspace);
  const [runs, activity, jobs, approvals, consents, executors, grants] = await Promise.allSettled([
    agent.getRunSummaries({ limit: DETAIL_WINDOW }),
    agent.getActivitySnapshot({ steps: DETAIL_WINDOW, logs: DETAIL_WINDOW }),
    agent.listBackgroundJobs(DETAIL_WINDOW),
    agent.listDeferredApprovals(),
    agent.listPendingConsents(),
    agent.getExecutors(),
    agent.getShellApprovalGrants(),
  ]);
  return {
    workspace,
    runs: settled(runs),
    activity: settled(activity),
    jobs: settled(jobs),
    approvals: settled(approvals),
    consents: settled(consents),
    executors: settled(executors),
    shellGrants: settled(grants),
  };
}

/** A panel's value, or why it has none. Never a silent `null`: a missing panel
 *  and an empty one are different facts and an operator has to be able to tell
 *  them apart. */
export type SettledPanel<Value> =
  | { status: 'ok'; value: Value }
  | { status: 'failed'; reason: string };

/**
 * One workspace as the drilldown reads it.
 *
 * Each panel is generic over what its `@callable` returns, so the response type
 * follows the orchestrator's own contracts rather than restating them — and a
 * caller reading `runs.value` gets `Page<RunSummary>`, not `unknown`.
 */
export interface WorkspaceDetail {
  workspace: string;
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

/* ── Query parsing ───────────────────────────────────────────────────────── */

const CursorParamSchema = v.pipe(v.string(), v.nonEmpty());

/** Read `?cursor=&limit=` into the repo's own `PageRequest`. A malformed limit
 *  is dropped rather than rejected — the store clamps it — but a malformed
 *  cursor is passed through so the store can refuse it, because silently
 *  restarting a walk from the top looks like success and repeats rows. */
function pageQuery(url: URL): PageRequest {
  // Statements, not spreads: `PageRequest` distinguishes an ABSENT cursor (start
  // at the beginning) from a present one, and a spread that produced
  // `cursor: undefined` would read as present-and-malformed to a store that
  // refuses a cursor it did not issue.
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

/** Re-exported so the browser client and the tests describe a page with the same
 *  type the store produces, rather than a second declaration of it. */
export type { Page, PageRequest };
