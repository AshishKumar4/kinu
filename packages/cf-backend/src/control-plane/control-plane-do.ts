/**
 * ControlPlaneDO: fleet-wide admin index and audit log, singleton. Holds only the
 * capability gate and storage; logic lives in `store.ts`, actions proxy owners' `@callable`s (`actions.ts`).
 * Not an `Agent`: its surface is exactly these methods, each gated before touching storage.
 */
import { DurableObject } from 'cloudflare:workers';
import { diagnostics } from '@kinu.run/core/obs';
import type { Page, PageRequest } from '@kinu.run/core';
import type { FeedbackRecord } from '@kinu.run/core';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { openAnalyticsWindow } from '@kinu.run/core/analytics';
// `./capability`, never `./admin-caller`: the latter pulls `auth/session` and the browser-session
// store into this DO's isolate; the workerd fixture asserts their absence.
import {
  requireControl,
  type ControlCapability, type ControlGrade, type PresentedCaller,
} from '@kinu.run/core/control-plane';
import * as cpStore from '@kinu.run/core/control-plane/store';
import type {
  AuditDraft, AuditOutcome, AuditSettlement, ControlAuditRow, ControlOverview,
  ControlUserRow, ControlWorkspaceRow, ControlPlaneSql,
  RosterWorkspace, UserObservation, WorkspaceFilter, WorkspaceObservation,
} from '@kinu.run/core/control-plane';
import * as store from '@kinu.run/core/control-plane';
import type { ControlFeedbackRow } from '@kinu.run/core/control-plane';


export type {
  AuditOutcome, AuditSettlement, ControlAuditRow, ControlFeedbackRow, ControlOverview,
  ControlUserRow, ControlWorkspaceRow, RosterWorkspace, UserObservation, WorkspaceObservation,
};

export class ControlPlaneDO extends DurableObject<Env> {
  private readonly store: ControlPlaneSql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = ctx.storage.sql;
    // Not inside `blockConcurrencyWhile`: `sql.exec` does not yield, and awaited init stalls every
    // request (`tests/workerd/do-init-gate.test.ts`).
    cpStore.initControlPlaneSchema(this.store);
    // A DO is a different isolate from the Worker, so `server.ts`'s sink is not installed here. Memoised per isolate.
    installAnalyticsDiagnostics(env);
  }

  private gate(caller: PresentedCaller, capability: ControlCapability): Promise<ControlGrade> {
    // The Analytics budget is per invocation (analytics/limits.ts MAX_WRITES_PER_INVOCATION); reopen it
    // on every RPC, not once per activation.
    openAnalyticsWindow(this.env);

    return requireControl(this.env, caller, capability);
  }

  async observeUser(caller: PresentedCaller, observation: UserObservation): Promise<void> {
    await this.gate(caller, 'index.observe');
    cpStore.observeUser(this.store, observation);
  }

  async observeWorkspace(caller: PresentedCaller, observation: WorkspaceObservation): Promise<void> {
    await this.gate(caller, 'index.workspace');
    cpStore.observeWorkspace(this.store, observation);
  }
  /** The use feed only knows the slug, so it claims no title. */
  async touchWorkspace(caller: PresentedCaller, observation: WorkspaceObservation): Promise<void> {
    await this.gate(caller, 'index.workspace');
    cpStore.touchWorkspace(this.store, observation);
  }

  async forgetWorkspace(
    caller: PresentedCaller, target: { userId: string; name: string; at?: number },
  ): Promise<void> {
    await this.gate(caller, 'index.forget');
    cpStore.forgetWorkspace(this.store, target);
  }

  /** Commit point for a submission: the caller deletes the R2 object when no id returns. */
  async recordFeedback(caller: PresentedCaller, row: FeedbackRecord): Promise<{ id: string }> {
    await this.gate(caller, 'feedback.write');

    return store.recordFeedback(this.store, row);
  }

  /** One account's rows. The roster fan-out stays in the Worker route, where subrequests are counted. */
  async replaceUserWorkspaces(
    caller: PresentedCaller, userId: string, live: readonly RosterWorkspace[],
  ): Promise<{ present: number; tombstoned: number }> {
    await this.gate(caller, 'index.reconcile');

    return cpStore.replaceUserWorkspaces(this.store, userId, live);
  }

  async overview(caller: PresentedCaller): Promise<ControlOverview> {
    await this.gate(caller, 'overview.read');

    return cpStore.overview(this.store);
  }

  async listUsers(caller: PresentedCaller, request: PageRequest = {}): Promise<Page<ControlUserRow>> {
    await this.gate(caller, 'users.read');

    return cpStore.listUsers(this.store, request);
  }

  async getUser(caller: PresentedCaller, userId: string): Promise<ControlUserRow | null> {
    await this.gate(caller, 'users.read');

    return cpStore.getUser(this.store, userId);
  }

  async listWorkspaces(
    caller: PresentedCaller,
    request: PageRequest = {},
    filter: WorkspaceFilter = {},
  ): Promise<Page<ControlWorkspaceRow>> {
    await this.gate(caller, 'workspaces.read');

    return cpStore.listWorkspaces(this.store, request, filter);
  }

  async listFeedback(
    caller: PresentedCaller, request: PageRequest = {},
  ): Promise<Page<ControlFeedbackRow>> {
    await this.gate(caller, 'feedback.read');

    return store.listFeedback(this.store, request);
  }

  async listAudit(caller: PresentedCaller, request: PageRequest = {}): Promise<Page<ControlAuditRow>> {
    await this.gate(caller, 'audit.read');

    return cpStore.listAudit(this.store, request);
  }

  /** Attempts whose outcome was never recorded, newest first. */
  async listPendingAudit(caller: PresentedCaller, limit?: number): Promise<ControlAuditRow[]> {
    await this.gate(caller, 'audit.read');

    return cpStore.listPendingAudit(this.store, limit);
  }

  /**
   * Append one attempt; row and marker come from one call so they cannot disagree. The event carries
   * an actor digest, never the address. A `pending` row emits nothing; `settleAudit` emits its marker.
   */
  async recordAudit(
    caller: PresentedCaller,
    entry: AuditDraft & OperationMarker,
  ): Promise<ControlAuditRow> {
    await this.gate(caller, 'audit.write');
    const row = cpStore.appendAudit(this.store, entry);
    this.publish(row, entry);

    return row;
  }

  /** Throws when no pending row matched: returning a row would let a lost settlement read as written. */
  async settleAudit(
    caller: PresentedCaller,
    settlement: { id: string; outcome: AuditSettlement; detail: string } & OperationMarker,
  ): Promise<ControlAuditRow> {
    await this.gate(caller, 'audit.write');
    const row = cpStore.settleAudit(this.store, settlement);

    if (row === null) {
      throw new Error(`no pending audit row ${settlement.id} to settle as ${settlement.outcome}`);
    }

    this.publish(row, settlement);

    return row;
  }

  /**
   * `reason` and `code` are closed classifications, never the row's `detail`: a cause chain is
   * never written to the three-month analytics dataset.
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

/** What the ops dataset learns about one attempt: allowlisted tokens only, never free text. */
export interface OperationMarker {
  /** A stable, non-reversible stand-in for the operator's address. */
  actorDigest?: string;
  reason?: string;
  /** `undefined` on non-thrown arms, publishing an empty slot rather than an unclassified code. */
  code?: string;
}
