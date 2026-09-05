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
import { openAnalyticsWindow } from '../analytics/writer';
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
  AuditOutcome, AuditSettlement, ControlAuditRow, ControlFeedbackRow, ControlOverview,
  ControlUserRow, ControlWorkspaceRow, RosterWorkspace, UserObservation, WorkspaceObservation,
} from './store';


export type {
  AuditOutcome, AuditSettlement, ControlAuditRow, ControlFeedbackRow, ControlOverview,
  ControlUserRow, ControlWorkspaceRow, RosterWorkspace, UserObservation, WorkspaceObservation,
};
export { AUDIT_OUTCOMES, CONTROL_PAGE_DEFAULT, CONTROL_PAGE_MAX } from './store';

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
    // The 250-point Analytics budget is PER INVOCATION (analytics/limits.ts
    // MAX_WRITES_PER_INVOCATION) and every RPC into this object is one. The
    // constructor's install opens the window once per ACTIVATION, so a hot
    // fleet singleton spent 250 points and then stopped producing audit
    // evidence until eviction. Reopened here, which is the one line every RPC
    // on this class passes through.
    openAnalyticsWindow(this.env);
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
  /** Records activity. The use feed only knows the slug, so it claims no title. */
  async touchWorkspace(caller: PresentedCaller, observation: WorkspaceObservation): Promise<void> {
    await this.gate(caller, 'index.workspace');
    store.touchWorkspace(this.store, observation);
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

  /** Attempts whose outcome was never recorded, newest first. The one class of
   *  row the two-phase write deliberately leaves behind, so an operator can find
   *  the actions that ran while the log could not be finished. */
  async listPendingAudit(caller: PresentedCaller, limit?: number): Promise<ControlAuditRow[]> {
    await this.gate(caller, 'audit.read');
    return store.listPendingAudit(this.store, limit);
  }

  /* ── The audit log's only writers (grade: admin) ────────────────────────── */

  /**
   * Append one attempt, and emit its fleet-level marker once the outcome is
   * known.
   *
   * Row and marker from one call, so they cannot disagree about whether an
   * action happened. The event carries a DIGEST of the actor while the row
   * carries the address: an audit trail that cannot name who acted is not one,
   * and a three-month-retention dataset an admin UI renders is not a place for an
   * address.
   *
   * A `pending` row emits NOTHING. It is an intent, not an outcome, and its
   * marker is emitted by `settleAudit` — so one attempt is still exactly one ops
   * row whichever way it goes.
   */
  async recordAudit(
    caller: PresentedCaller,
    entry: store.AuditDraft & OperationMarker,
  ): Promise<ControlAuditRow> {
    await this.gate(caller, 'audit.write');
    const row = store.appendAudit(this.store, entry);
    this.publish(row, entry);
    return row;
  }

  /**
   * Record how a pending attempt ended.
   *
   * THROWS when no pending row matched. The caller asked to finish a specific
   * attempt; if that attempt is not here, its outcome is unrecorded and saying so
   * is the only honest answer — returning a row would let a lost settlement read
   * as a written one.
   */
  async settleAudit(
    caller: PresentedCaller,
    settlement: { id: string; outcome: AuditSettlement; detail: string } & OperationMarker,
  ): Promise<ControlAuditRow> {
    await this.gate(caller, 'audit.write');
    const row = store.settleAudit(this.store, settlement);
    if (row === null) {
      throw new Error(`no pending audit row ${settlement.id} to settle as ${settlement.outcome}`);
    }
    this.publish(row, settlement);
    return row;
  }

  /**
   * The fleet-level marker for one settled attempt.
   *
   * `reason` and `code` are CLOSED classifications supplied by the caller, never
   * the row's `detail`. The detail is free text — for a thrown failure it is a
   * rendered cause chain, whose head is an upstream exception message — and the
   * analytics sink's own rule is that a cause chain is never written to a
   * three-month dataset. The chain stays in the durable row, which is where an
   * operator reads it under the same authorization that produced it.
   */
  private publish(row: ControlAuditRow, marker: OperationMarker): void {
    if (row.outcome === 'pending') return;
    diagnostics.event('control_plane.operation_recorded', {
      operation: row.operation,
      outcome: row.outcome,
      targetKind: row.targetKind,
      actor: marker.actorDigest ?? '',
      reason: marker.reason ?? '',
      code: marker.code ?? '',
    });
  }
}

/**
 * What the ops dataset learns about one attempt, beyond the row itself.
 *
 * Every field is a token the sink's allowlist can hold: a digest, a snake_case
 * classification, and one of core's `ErrorCode`s. Nothing here is free text, and
 * that is the point — this is the only path from an admin action to a dataset
 * whose retention this deployment does not control.
 */
export interface OperationMarker {
  /** A stable, non-reversible stand-in for the operator's address. */
  actorDigest?: string;
  /** Why the attempt ended the way it did, as one snake_case word. */
  reason?: string;
  /** The classified code of a thrown failure, supplied by the action's own
   *  `toKinuError` classification. `undefined` on every other arm, which
   *  publishes as an empty slot rather than as a code nothing classified. */
  code?: string;
}
