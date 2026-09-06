import type { SynchronousResultGuard } from "../actors/index.js";
import type { CatalogEntryId, ContributionAttribution, FacetLifecycleContext, FacetRef, PromptSectionId, SettingsLayerId, SlotWithdrawalSet, SurfaceId, WorkspaceSlotStore } from "../facets/index.js";
import type { ValidatedFacetRuntime } from "../operations/index.js";
import type { InvocationId } from "../invocations/index.js";
import { type IngressEndpointId, type RoutingWithdrawal, type WorkspacePersistence, type WorkspaceRoutingWithdrawal } from "../workspaces/index.js";
import type { ManagedOrigin } from "../definition/index.js";
import { FacetInstallFailure } from "../definition/index.js";
import type { WorkspaceFacetMaterializer } from "./workspace-facet-materializer.js";
type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];
/** Opens one synchronous control transaction for the owning Workspace Actor. */
export interface ControlTransaction<Transaction> {
    <Result>(operation: (transaction: Transaction) => Result, ...guard: SynchronousResultGuard<Result>): Result;
}
export interface WorkspaceContributionWithdrawalSet {
    readonly catalogEntries: readonly CatalogEntryId[];
    readonly ingressEndpoints: readonly IngressEndpointId[];
    readonly promptSections: readonly PromptSectionId[];
    readonly settingsLayers: readonly SettingsLayerId[];
    readonly surfaces: readonly SurfaceId[];
}
/**
 * SPEC §4.1: what stands between a withdrawal and its completion. A `reliance` obligation
 * holds the withdrawal before it begins — an active Facet reached this exact provider
 * through a resolved `BindingRequirement`, so retiring its records now would compose
 * against state no Blueprint declares. A `drain` obligation stands after it began — an
 * Invocation item admitted against the Facet is frozen intent and still settles. Neither
 * is a rejection and neither is silent: the withdrawal reports them and completes when the
 * set is empty.
 */
export type FacetWithdrawalObligation = {
    readonly kind: "reliance";
    readonly dependent: FacetRef;
} | {
    readonly kind: "drain";
    readonly item: InvocationId;
};
export interface FacetWithdrawalPlan {
    readonly attribution: ContributionAttribution;
    readonly records: WorkspaceContributionWithdrawalSet;
    readonly slots: SlotWithdrawalSet;
    readonly subscriptions: number;
    readonly obligations: readonly FacetWithdrawalObligation[];
}
export interface FacetWithdrawalResult {
    readonly kind: "retired";
    readonly attribution: ContributionAttribution;
    readonly records: WorkspaceContributionWithdrawalSet;
    readonly slots: SlotWithdrawalSet;
    readonly routing: RoutingWithdrawal;
    /** Empty exactly when the withdrawal is complete. */
    readonly obligations: readonly FacetWithdrawalObligation[];
}
/** A withdrawal held before it began: nothing was written and nothing was rejected. */
export interface FacetWithdrawalDeferral {
    readonly kind: "deferred";
    readonly attribution: ContributionAttribution;
    readonly obligations: readonly FacetWithdrawalObligation[];
}
export type FacetWithdrawalOutcome = FacetWithdrawalResult | FacetWithdrawalDeferral;
/**
 * SPEC §4.1: where a begun withdrawal stands at a later transaction. `complete` is the one
 * state a host may act on as finished, and it is reached only when every item of the frozen
 * drain set has a terminal current Receipt.
 */
export type FacetWithdrawalCompletion = {
    readonly kind: "complete";
    readonly attribution: ContributionAttribution;
} | {
    readonly kind: "draining";
    readonly attribution: ContributionAttribution;
    readonly obligations: readonly FacetWithdrawalObligation[];
};
/**
 * SPEC §4.1: the Facets an active resolved `BindingRequirement` points at this exact
 * provider from. `FacetRuntimeHost` answers it; reliance is keyed on the exact `FacetRef`
 * a dependent reached, never on the capability name it asked for.
 */
export interface FacetRelianceQuery {
    reliedUponBy(provider: FacetRef): readonly FacetRef[];
}
/**
 * SPEC §4.1: the admitted Invocation items whose `PreparedInvocationHeader` target names
 * the withdrawing Facet, and whether each has reached a terminal current Receipt. The set
 * is closed at the transaction that begins the withdrawal, because that transaction stops
 * admitting Invocations against the Facet.
 */
export declare abstract class FacetInvocationDrainPort<Transaction> {
    abstract admitted(transaction: Transaction, facet: FacetRef): readonly InvocationId[];
    abstract terminal(transaction: Transaction, item: InvocationId): boolean;
}
/**
 * SPEC §4.1: every Workspace-owned record of one exact contribution is queried and retired
 * in one Workspace Actor transaction. The attribution includes both FacetRef and PackagePin;
 * another release of the same Facet is outside the set.
 */
export declare class FacetWithdrawal<Transaction> {
    private readonly slots;
    private readonly routing;
    private readonly persistence;
    private readonly transaction;
    private readonly reliance;
    private readonly drain;
    constructor(slots: WorkspaceSlotStore<Transaction>, routing: WorkspaceRoutingWithdrawal<Transaction>, persistence: WorkspacePersistence<Transaction>, transaction: ControlTransaction<Transaction>, reliance: FacetRelianceQuery, drain: FacetInvocationDrainPort<Transaction>);
    plan(attribution: ContributionAttribution): FacetWithdrawalPlan;
    /**
     * SPEC §4.1. A reliance obligation holds the withdrawal before it begins: nothing is
     * written, nothing is rejected, and the obligation discharges when the last relying
     * Facet goes inactive. Once no reliance stands the withdrawal begins in one transaction
     * — that transaction stops admitting Invocations against the Facet, which closes the
     * drain set — and reports the admitted items that have not yet reached a terminal
     * Receipt. It is complete exactly when it reports no obligation.
     */
    withdraw(attribution: ContributionAttribution): FacetWithdrawalOutcome;
    /**
     * SPEC §4.1: a later transaction's completion attempt. The items are the ones the
     * withdrawal transaction captured — read from the Workspace-owned record, so the answer
     * survives a restart — and each one's terminality is the Invocation plane's current
     * Receipt (§7.4) read now. A host can therefore neither report completion by discarding
     * a live item nor be held open by an item admitted after admission stopped. A completion
     * attempt for a withdrawal that never began is refused rather than answered `complete`.
     */
    completion(attribution: ContributionAttribution): FacetWithdrawalCompletion;
    /** The captured items that have not reached a terminal current Receipt, in capture order. */
    private draining;
    private planInTransaction;
    /**
     * The records one exact contribution materialized, read inside the caller's transaction
     * and refused as a whole when a plane cannot answer, so a withdrawal never reads one
     * state and writes against another. It carries no obligation: what stands between a
     * withdrawal and its completion is asked for separately, because a withdrawal that is
     * held by reliance never needs the drain set and a begun one reads its frozen capture.
     */
    private contributedSets;
    /**
     * The pending set a withdrawal that has not begun would face, computed inside the
     * caller's transaction so it never reads one state and writes against another. Reliance
     * is listed first because it holds the withdrawal before it begins, while a drain
     * obligation only stands after it began — and once it has begun, the drain half is the
     * frozen capture's rather than this query's.
     */
    private obligations;
    /** What holds a withdrawal before it begins: the exact Facets that reached this one. */
    private relianceObligations;
    private contributedRecords;
    private retireRecords;
    private controlFailure;
}
/**
 * SPEC §4.1: the durable record of a failed install, and the query a retry consults. It is
 * definition-plane state with one owning Actor, so the write is its own at-least-once,
 * idempotency-keyed transaction rather than a second writer inside the Workspace's.
 */
export interface FacetInstallEvidencePort {
    record(failure: FacetInstallFailure): void;
    refusals(attribution: ContributionAttribution, materialization: ManagedOrigin): readonly FacetInstallFailure[];
}
export type FacetActivationOutcome = {
    readonly kind: "active";
    readonly facet: FacetRef;
} | {
    readonly kind: "failed";
    readonly facet: FacetRef;
    readonly reason: string;
};
export declare class FacetActivation<Transaction, Read, Context> {
    private readonly withdrawal;
    private readonly materializer;
    private readonly transaction;
    private readonly evidence;
    constructor(withdrawal: FacetWithdrawal<Transaction>, materializer: WorkspaceFacetMaterializer<Transaction, Read, Context>, transaction: ControlTransaction<Transaction>, evidence: FacetInstallEvidencePort);
    activate(facet: CorrespondentFacet, read: Read, materializationContext: Context, lifecycleContext: FacetLifecycleContext): Promise<FacetActivationOutcome>;
    /**
     * SPEC §4.1: the partial activation is retired through the same attributed withdrawal
     * set a withdrawal computes, and the outcome is recorded as a typed failed install
     * rather than as a live Facet. Only a materialization-phase failure can have left
     * records, because contribution records publish only after `start` completes.
     */
    private failed;
}
export {};
