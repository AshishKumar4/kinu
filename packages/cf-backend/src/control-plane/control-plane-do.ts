/**
 * ControlPlaneDO: fleet-wide admin index and audit log, singleton. Holds only the
 * capability gate and storage; logic lives in core's `control-plane/store.ts`, actions proxy owners' `@callable`s (`actions.ts`).
 * Not an `Agent`: its surface is exactly these methods, each gated before touching storage.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { DurableObject } from 'cloudflare:workers';
import { diagnostics, KinuError, settle } from '@kinu.run/core/obs';
import {
  censusOf, durableStamps, readStamp, repairSchema, requireOps, SCHEMA_TABLES, StoragePredatesReleaseError, writeStamp,
  kinuListings,
  type ExploreKind, type ExplorePage, type GalleryCategory, type GalleryListing, type GallerySlate, type GallerySort,
  type OpsCaller, type WorkspaceCard, type Page, type PageRequest, type Repair, type TablesAnswer,
} from '@kinu.run/core';
import type { FeedbackRecord } from '@kinu.run/core';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { openAnalyticsWindow } from '@kinu.run/core/analytics';
// Core's capability gate, never `./admin-caller`: the latter pulls `auth/session` and the browser-session
// store into this DO's isolate; the workerd fixture asserts their absence.
import {
  GalleryIndex, GalleryListingSyncSchema, requireControl,
  type ControlCapability, type ControlGrade, type GalleryListingSync, type PresentedCaller,
} from '@kinu.run/core/control-plane';
import * as cpStore from '@kinu.run/core/control-plane/store';
import { CONTROL_PLANE_SINGLETON } from './stub';
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

/** What a signed-in person does to a listing. */
export type GalleryMark =
  | { readonly kind: 'star'; readonly workspace: string; readonly slate: string; readonly on: boolean; readonly listing?: ExploreKind }
  | { readonly kind: 'report'; readonly workspace: string; readonly slate: string; readonly reason: string };

/** One page of Explore, as its route asks it: of one kind when given. */
export interface ExploreQuery {
  readonly q: string;
  readonly kind: ExploreKind | null;
  readonly sort: GallerySort;
  readonly category: GalleryCategory | null;
  readonly page: number;
}

export class ControlPlaneDO extends DurableObject<Env> {
  private readonly store: ControlPlaneSql;

  private readonly gallery: GalleryIndex;

  /** What this activation's repair did, for the deploy's walk; null where the storage was at this build. */
  private readonly schemaRepair: Repair | null;

  /** Why the index may not be read: its repair could not bring it to this build. */
  private readonly storageRefusal: StoragePredatesReleaseError | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = ctx.storage.sql;
    // Not inside `blockConcurrencyWhile`: `sql.exec` does not yield, and awaited init stalls every
    // request (`tests/workerd/do-init-gate.test.ts`). Storage a release left behind is repaired first, before any
    // method reads it (core state/schema-repair.ts), as every class's is.
    const stamps = durableStamps(ctx.storage.kv);
    const unmade = readStamp(stamps, ctx.storage.sql, 'control') === 'unmade';
    const init = (): void => { cpStore.initControlPlaneSchema(this.store); };

    this.schemaRepair = repairSchema(ctx.storage.sql, {
      schema: 'control', tables: SCHEMA_TABLES.control, stamps, transactionSync: (write) => ctx.storage.transactionSync(write), init,
    }, 'control plane');

    if (this.schemaRepair?.refused != null) this.storageRefusal = new StoragePredatesReleaseError('control', this.schemaRepair.refused);
    else if (this.schemaRepair === null) init();

    if (unmade && this.storageRefusal === undefined) writeStamp(stamps, 'control');
    this.gallery = new GalleryIndex(ctx.storage.sql);

    // Kinu's own workspace blueprints are code: each activation lists this build's.
    if (this.storageRefusal === undefined) this.gallery.syncKinu(kinuListings(), Date.now());
    // A DO is a different isolate from the Worker, so `server.ts`'s sink is not installed here. Memoised per isolate.
    installAnalyticsDiagnostics(env);
  }

  /** The caller's grade, once it holds `capability` and the index is this build's. */
  private gate(caller: PresentedCaller, capability: ControlCapability): Promise<ControlGrade> {
    // The Analytics budget is per invocation (analytics/limits.ts MAX_WRITES_PER_INVOCATION); reopen it
    // on every RPC, not once per activation.
    openAnalyticsWindow(this.env);

    return requireControl(this.env, caller, capability, this.storageRefusal);
  }

  /** The deploy's walk: the index's tables and their rows, and what its repair did. */
  async opsTables(caller: OpsCaller): Promise<TablesAnswer> {
    await requireOps(this.env, caller);

    return {
      name: CONTROL_PLANE_SINGLETON, census: censusOf(this.store), repair: this.schemaRepair, refused: this.storageRefusal?.reason ?? null,
      workspaces: [], accounts: [], agents: [],
    };
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
    this.gallery.forgetWorkspaces(cpStore.removedWorkspaceNames(this.store, target.userId));
  }

  /** Commit point for a submission: the caller deletes the R2 object when no id returns. */
  async recordFeedback(caller: PresentedCaller, row: FeedbackRecord): Promise<{ id: string }> {
    await this.gate(caller, 'feedback.write');

    return store.recordFeedback(this.store, row);
  }

  // ── The Gallery (core slates/gallery.ts): its index lives here, beside the fleet's, so it is an object that
  // already exists on every deployment, never a new one.

  /** What a workspace says of one share: its listing written, or taken down. */
  async gallerySync(caller: PresentedCaller, sync: GalleryListingSync): Promise<void> {
    await this.gate(caller, 'gallery.list');
    this.gallery.sync(v.parse(GalleryListingSyncSchema, sync), Date.now());
  }

  async gallerySlate(caller: PresentedCaller, workspace: string, slate: string, viewer: string | null): Promise<GallerySlate | null> {
    await this.gate(caller, 'gallery.read');

    return this.gallery.slate(workspace, slate, viewer, Date.now());
  }

  /** Whether `workspace`'s slate is listed, and if so by which share, and its picture's digest. */
  async galleryListed(caller: PresentedCaller, workspace: string, slate: string): Promise<{ readonly share: string; readonly picture: string | null } | null> {
    await this.gate(caller, 'gallery.read');

    return this.gallery.listed(workspace, slate);
  }

  async explorePage(caller: PresentedCaller, query: ExploreQuery, viewer: string | null): Promise<ExplorePage> {
    await this.gate(caller, 'gallery.read');

    return this.gallery.explore(query, viewer, Date.now());
  }

  /** A listed workspace blueprint's card, or null when it is not listed. */
  async exploreWorkspace(caller: PresentedCaller, workspace: string, item: string, viewer: string | null): Promise<WorkspaceCard | null> {
    await this.gate(caller, 'gallery.read');

    return this.gallery.workspaceCard(workspace, item, viewer, Date.now());
  }

  /** A person's install of a listed item, counted once; false when it is not listed. */
  async exploreInstalled(caller: PresentedCaller, install: { readonly kind: ExploreKind; readonly workspace: string; readonly item: string; readonly userId: string }): Promise<boolean> {
    await this.gate(caller, 'gallery.mark');

    return this.gallery.installed(install, Date.now());
  }

  /** The listings `email` starred. */
  async galleryStarred(caller: PresentedCaller, email: string): Promise<GalleryListing[]> {
    await this.gate(caller, 'gallery.read');

    return this.gallery.starred(email, Date.now());
  }

  /** A signed-in person's star, its withdrawal, or their report; false when the slate is not listed. */
  async galleryMark(caller: PresentedCaller, email: string, mark: GalleryMark): Promise<boolean> {
    await this.gate(caller, 'gallery.mark');
    const at = { email, workspace: mark.workspace, slate: mark.slate };

    return mark.kind === 'star' ? this.gallery.star({ ...at, on: mark.on, kind: mark.listing ?? 'app' }, Date.now()) : this.gallery.report({ ...at, reason: mark.reason }, Date.now());
  }

  /** A deleted account's stars, reports and installs. */
  async galleryForget(caller: PresentedCaller, person: { readonly email: string; readonly userId: string }): Promise<void> {
    await this.gate(caller, 'gallery.forget');
    this.gallery.forget(person);
  }

  /**
   * A deleted account, as the fleet knew it: its Gallery stars, reports and installs and its removed workspaces'
   * listings, its feedback and the screenshots under its R2 prefix, its index rows; the operators' audit keeps its rows
   * under one deletion pseudonym, drawn here so nothing derives it from the account (`cpStore.forgetUser`).
   */
  async forgetUser(caller: PresentedCaller, person: { readonly email: string; readonly userId: string }): Promise<{ readonly feedback: number }> {
    await this.gate(caller, 'account.forget');
    this.gallery.forget(person);
    this.gallery.forgetWorkspaces(cpStore.removedWorkspaceNames(this.store, person.userId));
    const bucket = this.env.FEEDBACK_BUCKET;
    const prefix = `feedback/${person.userId}/`;

    for (let page = await bucket?.list({ prefix }); page !== undefined && page.objects.length > 0; page = await bucket?.list({ prefix })) {
      await bucket?.delete(page.objects.map((object) => object.key));
    }

    return cpStore.forgetUser(this.store, person, `deleted-${crypto.randomUUID()}`);
  }

  /** One account's rows. The roster fan-out stays in the Worker route, where subrequests are counted. */
  async replaceUserWorkspaces(
    caller: PresentedCaller, userId: string, live: readonly RosterWorkspace[],
  ): Promise<{ present: number; tombstoned: number }> {
    await this.gate(caller, 'index.reconcile');
    const reconciled = cpStore.replaceUserWorkspaces(this.store, userId, live);

    // A workspace the registry no longer holds sends the Gallery nothing more: its listings go with it.
    this.gallery.forgetWorkspaces(cpStore.removedWorkspaceNames(this.store, userId));

    return reconciled;
  }

  async overview(caller: PresentedCaller): Promise<ControlOverview> {
    await this.gate(caller, 'overview.read');

    return cpStore.overview(this.store);
  }

  /** Every user the index has seen, by id: the deploy's walk opens each one's account (`/ops/tables`). */
  async opsUsers(caller: OpsCaller): Promise<string[]> {
    const refused = this.storageRefusal;

    return settle(Effect.gen({ self: this }, function* () {
      yield* Effect.promise(() => requireOps(this.env, caller));

      if (refused !== undefined) return yield* refused;

      return cpStore.userIds(this.store);
    }));
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
  settleAudit(
    caller: PresentedCaller,
    settlement: { id: string; outcome: AuditSettlement; detail: string } & OperationMarker,
  ): Promise<ControlAuditRow> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* Effect.promise(async () => this.gate(caller, 'audit.write'));
      const row = cpStore.settleAudit(this.store, settlement);

      if (row === null) {
        return yield* new KinuError('missing', `no pending audit row ${settlement.id} to settle as ${settlement.outcome}`);
      }

      this.publish(row, settlement);

      return row;
    }));
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
