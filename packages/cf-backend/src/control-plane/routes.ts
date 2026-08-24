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
import { claimOwnedWorkspace } from '../user/workspace-ownership';
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
import type {
  AuditOutcome, AuditSettlement, ControlAuditRow, OperationMarker,
} from './control-plane-do';
import type { AuditDraft, WorkspaceFilter } from './store';

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
      return await handleUserDetail(env, admin, caller, userId, url);
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
      // A workspace name is not an address — `?userId=` is what makes it one.
      // Required rather than optional: the alternative resolves the global
      // Durable Object for whatever account happens to hold that name first,
      // which is the reach this route exists to bound.
      const owner = url.searchParams.get('userId');
      if (owner === null || !USER_ID.test(owner)) {
        return err(400, 'a workspace read must name the account that owns it (?userId=)');
      }
      return await handleWorkspaceDetail(env, owner, name);
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
      if (url.searchParams.get('refresh') === '1') ask.forceRefresh = true;
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
 * THE ORDER MATTERS AND IT IS THE POINT OF THIS FUNCTION.
 *
 * THE INTENT IS WRITTEN BEFORE THE MUTATION RUNS, and a failure to write it
 * STOPS the mutation. An audit log that is appended after the fact records only
 * the actions that happened to be followed by a working audit log; the one it
 * misses is the one taken while the plane was degraded, which is exactly the
 * action an operator later needs to find. Writing first inverts the failure:
 * either the attempt is on the record, or it never happened.
 *
 * THE SETTLEMENT CAN STILL BE LOST, and that is visible rather than hidden. A
 * pending row is the durable statement "this ran and nobody recorded how it
 * ended", which `listPendingAudit` surfaces; the response is a failure, so the
 * operator knows to go and look.
 *
 * A stale sign-in and a malformed body are audited too, because the attempts an
 * operator surface most needs recorded are the ones that did not work. Only a
 * caller who never got past `admin()` produces no row, and that one is not an
 * operator action at all — it is reported as `control_plane.denied` instead.
 */
async function handleAction(
  request: Request,
  env: ControlEnv,
  admin: AuthorizedAdmin,
  caller: ControlCaller,
): Promise<Response> {
  const body = await safeJson(request, ControlActionSchema);
  if (body === null) {
    return await refuse(env, admin, caller, {
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
    return await refuse(env, admin, caller, described, {
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
      // The thrown arm's classification, and `undefined` on every other — which
      // the marker publishes as an empty slot. Written with the rest of the
      // settlement rather than assigned after it, so one statement carries the
      // whole shape a settled attempt reports.
      code: outcome.code,
    };
    await controlPlaneStub(env).settleAudit(caller, settlement);
  } catch (cause) {
    reportAuditFailure('settle', { cause }, described.operation);
    // Not a success, whatever the action did. The operator is told the row is
    // unfinished and where to find it, because the alternative is a green answer
    // over an audit log that cannot say what happened.
    return err(500, `${AUDIT_UNSETTLED} (audit row ${intent.id})`);
  }

  // A refusal by the owning object is a 409, not a 500: the request was
  // well-formed and authorized, and the state said no.
  const status = outcome.outcome === 'ok' ? 200 : outcome.outcome === 'denied' ? 409 : 502;
  return json({ outcome: outcome.outcome, detail: outcome.detail }, { status });
}

/** What a pending row says while its action is in flight. Read by an operator,
 *  so it states the fact rather than leaving the column empty. */
const PENDING_DETAIL = 'in flight: the outcome has not been recorded';

const AUDIT_UNAVAILABLE =
  'the admin audit log could not record this attempt, so nothing was run';
const AUDIT_UNSETTLED =
  'the action ran and its outcome could not be recorded; the attempt is still pending in the audit log';

/**
 * Audit a refusal this plane made, and answer with it.
 *
 * One terminal row: there is no mutation to bracket, so a pending phase would
 * describe an action that was never going to run. The audit write is still
 * fail-closed — an operator told "refused" by a plane that recorded nothing has
 * been told half the truth.
 */
async function refuse(
  env: ControlEnv,
  admin: AuthorizedAdmin,
  caller: ControlCaller,
  identity: ActionIdentity,
  refusal: { status: number; message: string; detail: string; reason: string },
): Promise<Response> {
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

/**
 * Append one row, with the operator's digest attached.
 *
 * Throws on failure, and every caller treats that as fatal to the request. That
 * is the whole change from the version this replaced, which caught the failure,
 * logged a line and returned success over an action nobody recorded.
 */
interface AuditSettlementRequest extends OperationMarker {
  id: string;
  outcome: AuditSettlement;
  detail: string;
}

async function appendAudit(
  env: ControlEnv,
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

/* ── Reads that reach through to the owning object ───────────────────────── */

/** A UserDO name. The one shape a `userId` may take on this surface, spelled
 *  once because the detail route and the workspace route both refuse anything
 *  else. */
const USER_ID = /^[a-f0-9]{32}$/;

/**
 * One account: its index row, and a cursored page of the workspaces it owns.
 *
 * RECONCILED ON THE FIRST PAGE, NEVER MID-WALK. The roster read is the source of
 * truth and `replaceUserWorkspaces` settles the difference, so opening an
 * account repairs its rows before any of them are shown. But that reconcile
 * REWRITES `last_seen_at`, which is the column the cursor orders on — running it
 * again on page two would reorder the list underneath a walk already in
 * progress, and a walk whose ordering changes silently repeats and skips rows.
 * So the walk reconciles once, at the top, and says so.
 *
 * PAGED, because an account with more than `CONTROL_PAGE_MAX` workspaces
 * previously had every row past 200 unreachable while the page's own copy said
 * the table was reconciled.
 */
async function handleUserDetail(
  env: ControlEnv,
  admin: AuthorizedAdmin,
  caller: ControlCaller,
  userId: string,
  url: URL,
): Promise<Response> {
  if (!USER_ID.test(userId)) return err(400, 'not a user id');
  const stub = controlPlaneStub(env);
  const user = await stub.getUser(caller, userId);

  const request = pageQuery(url);
  const reconcile = await reconcileRoster(env, caller, userId, request.cursor === undefined);
  const workspaces = await stub.listWorkspaces(caller, request, { userId, includeRemoved: true });
  return json({ user, workspaces, reconcile, viewer: admin.email });
}

/**
 * What a drilldown page did about the index it is showing.
 *
 * Three states, not a boolean, because "reconciled", "the registry could not be
 * read" and "this is page four of a walk that reconciled at page one" are three
 * different things to tell an operator who is deciding whether to remove a
 * workspace.
 */
export type ReconcileReport =
  | { status: 'ok' }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string };

const CONTINUATION = 'this walk reconciled on its first page; these rows are from that same read';

async function reconcileRoster(
  env: ControlEnv,
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
 * RESOLVED THROUGH THE OWNER, exactly as an action is. The panels below are a
 * workspace's conversation runs, its spend, its pending approvals and its
 * standing shell grants — reading them for the wrong account is the same
 * cross-user reach as acting on it, and `OrchestratorAgent` is addressed by a
 * name that is unique only inside one UserDO. `claimOwnedWorkspace` refuses
 * before any panel RPC is issued.
 *
 * Every field comes from an existing `@callable`. Each is settled independently
 * so one unavailable surface degrades to a stated reason instead of blanking the
 * page — a workspace whose sandbox is down still has runs, jobs and approvals
 * worth reading, and that is exactly the workspace an operator is looking at.
 */
async function handleWorkspaceDetail(
  env: ControlEnv, userId: string, workspace: string,
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
  return json(detail);
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
  /** The account this read was resolved through. Echoed so a browser holding the
   *  answer can bind its action buttons to the same pair the read proved, rather
   *  than to whatever is in the address bar. */
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
