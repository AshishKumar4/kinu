/**
 * ControlPlaneDO — the admin surface's index and audit log, hosted.
 *
 * WHY A SINGLETON. Its questions are fleet-wide. "Who are the users", "which
 * workspaces exist", "what did an operator do last night" have no per-user shard
 * that could answer them, and answering them by fanning out over every UserDO
 * costs a subrequest per account on every page load.
 *
 * WHAT THIS CLASS HOLDS, and it is deliberately only two things it cannot
 * delegate: the CAPABILITY GATE, and the storage handle. Every row, every query
 * and every cursor lives in `store.ts` — the same split `monitor/incidents.ts`
 * has from `MonitorDO`, and for the same reason: none of that logic needs an
 * actor, so none of it should need one to be tested.
 *
 * WHAT IT IS NOT. It holds no business logic and owns no state anyone else owns.
 * Every admin ACTION proxies an existing `@callable` on the object that owns the
 * state it changes (`actions.ts`); none is reimplemented here.
 *
 * Not an `Agent` subclass, for the same reason MonitorDO is not: no chat, no
 * tools, no websockets, so it inherits none of the SDK surface `rpc-surface.ts`
 * exists to seal. Its reachable surface is exactly the methods declared here, and
 * every one of them passes the gate before it touches storage.
 */
import { DurableObject } from 'cloudflare:workers';
import { diagnostics } from '@kinu.run/core/obs';
import type { Page, PageRequest } from '@kinu.run/core';
import type { FeedbackRecord } from '../feedback/contract';
import { installAnalyticsDiagnostics } from '../analytics/install';
// `./capability`, never `./admin-caller`. The two modules answer different
// questions, and the split exists so this one does not need the other's answer:
// `admin-caller` re-exports this gate, but reaching it through that file puts
// `auth/session` — and with it the browser-session store, `lib/kv` and the user
// plane's own capability module — into a Durable Object's isolate, which is the
// drift both files' headers forbid. Measured: taking the gate from `capability`
// drops five modules from this object's graph, and the workerd fixture asserts
// their absence so the header stops being the only thing holding the line.
import { requireControl, type ControlCapability, type ControlGrade, type PresentedCaller } from './capability';
import type { ControlPlaneSql } from './sql';
import * as store from './store';
import type {
  AuditOutcome, ControlAuditRow, ControlFeedbackRow, ControlOverview, ControlUserRow,
  ControlWorkspaceRow, RosterWorkspace, UserObservation, WorkspaceObservation,
} from './store';


export type {
  AuditOutcome, ControlAuditRow, ControlFeedbackRow, ControlOverview, ControlUserRow,
  ControlWorkspaceRow, RosterWorkspace, UserObservation, WorkspaceObservation,
};
export { CONTROL_PAGE_DEFAULT, CONTROL_PAGE_MAX } from './store';
export { CONTROL_PLANE_SINGLETON } from './stub';

export class ControlPlaneDO extends DurableObject<Env> {
  private readonly store: ControlPlaneSql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = ctx.storage.sql;
    // Synchronous, and deliberately not inside `blockConcurrencyWhile`:
    // `sql.exec` does not yield, so there is nothing to gate, and anything this
    // object's init awaited would stall every later request on it —
    // `tests/workerd/do-init-gate.test.ts` measures exactly that.
    store.initControlPlaneSchema(this.store);
    // A Durable Object is a DIFFERENT ISOLATE from the Worker's fetch handler,
    // with its own module scope, so the sink installed in `server.ts` is not
    // installed here. Without this line every audit row's `control_plane.*`
    // event would reach Workers Logs and nothing would reach the operations
    // dataset — green tests, empty dataset. Memoised per isolate.
    installAnalyticsDiagnostics(env);
  }

  private gate(caller: PresentedCaller, capability: ControlCapability): Promise<ControlGrade> {
    return requireControl(this.env, caller, capability);
  }

  /* ── Feeds (grade: ingest) ─────────────────────────────────────────────── */

  async observeUser(caller: PresentedCaller, observation: UserObservation): Promise<void> {
    await this.gate(caller, 'index.observe');
    store.observeUser(this.store, observation);
  }

  async observeWorkspace(caller: PresentedCaller, observation: WorkspaceObservation): Promise<void> {
    await this.gate(caller, 'index.workspace');
    store.observeWorkspace(this.store, observation);
  }

  async forgetWorkspace(
    caller: PresentedCaller, target: { userId: string; name: string; at?: number },
  ): Promise<void> {
    await this.gate(caller, 'index.forget');
    store.forgetWorkspace(this.store, target);
  }

  /**
   * Store one feedback submission's metadata.
   *
   * The commit point for a submission: the screenshot is already in R2 when this
   * runs, and the caller deletes that object when this does not return an id.
   */
  async recordFeedback(caller: PresentedCaller, row: FeedbackRecord): Promise<{ id: string }> {
    await this.gate(caller, 'feedback.write');
    return store.recordFeedback(this.store, row);
  }

  /* ── Reconciliation (grade: admin) ─────────────────────────────────────── */

  /** Replace one account's workspace rows from the registry that owns them. The
   *  fan-out over the roster happens in the Worker route, not here: subrequest
   *  budget belongs where subrequests are counted. */
  async replaceUserWorkspaces(
    caller: PresentedCaller, userId: string, live: readonly RosterWorkspace[],
  ): Promise<{ present: number; tombstoned: number }> {
    await this.gate(caller, 'index.reconcile');
    return store.replaceUserWorkspaces(this.store, userId, live);
  }

  /* ── Reads (grade: admin) ──────────────────────────────────────────────── */

  async overview(caller: PresentedCaller): Promise<ControlOverview> {
    await this.gate(caller, 'overview.read');
    return store.overview(this.store);
  }

  async listUsers(caller: PresentedCaller, request: PageRequest = {}): Promise<Page<ControlUserRow>> {
    await this.gate(caller, 'users.read');
    return store.listUsers(this.store, request);
  }

  async getUser(caller: PresentedCaller, userId: string): Promise<ControlUserRow | null> {
    await this.gate(caller, 'users.read');
    return store.getUser(this.store, userId);
  }

  async listWorkspaces(
    caller: PresentedCaller,
    request: PageRequest = {},
    filter: store.WorkspaceFilter = {},
  ): Promise<Page<ControlWorkspaceRow>> {
    await this.gate(caller, 'workspaces.read');
    return store.listWorkspaces(this.store, request, filter);
  }

  async listFeedback(
    caller: PresentedCaller, request: PageRequest = {},
  ): Promise<Page<ControlFeedbackRow>> {
    await this.gate(caller, 'feedback.read');
    return store.listFeedback(this.store, request);
  }

  async listAudit(caller: PresentedCaller, request: PageRequest = {}): Promise<Page<ControlAuditRow>> {
    await this.gate(caller, 'audit.read');
    return store.listAudit(this.store, request);
  }

  /* ── The audit log's only writer (grade: admin) ─────────────────────────── */

  /**
   * Append one operator action, and emit the fleet-level marker for it.
   *
   * Both from one call, so the row and the metric cannot disagree about whether
   * an action happened. The event carries a DIGEST of the actor while the row
   * carries the address: an audit trail that cannot name who acted is not one,
   * and a three-month-retention dataset an admin UI renders is not a place for an
   * address.
   */
  async recordAudit(
    caller: PresentedCaller,
    entry: store.AuditDraft & { actorDigest?: string },
  ): Promise<ControlAuditRow> {
    await this.gate(caller, 'audit.write');
    const row = store.appendAudit(this.store, entry);
    diagnostics.event('control_plane.operation_recorded', {
      operation: row.operation,
      outcome: row.outcome,
      targetKind: row.targetKind,
      actor: entry.actorDigest ?? '',
      reason: row.outcome === 'ok' ? '' : row.detail,
    });
    return row;
  }
}
