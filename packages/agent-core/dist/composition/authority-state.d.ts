import type { ActorRef } from "../actors/index.js";
import type { Binding, InvalidationWatermarkStore } from "../authority/index.js";
import { InvalidationWatermark, PathEpochEvidence, type ScopeEpoch } from "../authority/index.js";
import type { BindingName, FacetData, FacetRef, InterceptorDeclaration, OperationDescriptor, ProtectionDomain } from "../facets/index.js";
import type { PrincipalRef, TenantId } from "../identity/index.js";
import type { AuditRecord, PreEffectReceipt } from "../invocations/index.js";
import type { TurnLease } from "../agents/index.js";
import type { LeaseToken } from "../protocol/index.js";
import type { OperationAuthorityStatePort, OperationResolutionCandidate, OperationResolutionState } from "./authority.js";
/**
 * The durable pair one stale observation commits: a deniedPreEffect Receipt and the
 * AuditRecord that chains it. They are one contract because §7.4 admits neither alone —
 * a Receipt with no audit edge is unattributable and an audit edge with no Receipt is
 * unsubstantiated — so no seam here may carry one without the other.
 */
export interface StaleDenialEvidence {
    readonly receipt: PreEffectReceipt;
    readonly audit: AuditRecord;
}
/**
 * The host-specific inputs an Actor's authority state composes: how resolution
 * candidates are built from materialized Bindings, where the current Turn lease
 * lives, which policy admits an operation, and how a denial persists. Each is a
 * real boundary — everything the §3.4 rules constrain stays in the state
 * service itself.
 */
export interface ActorAuthorityHost {
    resolve(caller: PrincipalRef, binding: BindingName): OperationResolutionCandidate | undefined;
    currentBinding(key: string): Binding | undefined;
    currentPath(binding: Binding): PathEpochEvidence;
    currentLease(token: LeaseToken): TurnLease | undefined;
    admits(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[], at: Date): boolean;
    contributorDomain(facet: FacetRef): ProtectionDomain | undefined;
    admitsInterception(resolution: OperationResolutionState, contributor: FacetRef, declaration: InterceptorDeclaration, descriptor: OperationDescriptor): boolean;
    /**
     * Persist the deniedPreEffect Receipt and its AuditRecord in the SAME Actor
     * transaction that advanced the watermark. Called at most once per stale
     * observation; must not create an EffectAttempt.
     */
    appendDenial(receipt: PreEffectReceipt, audit: AuditRecord): void;
    denialEvidence(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[]): StaleDenialEvidence;
    transaction<Result>(operation: () => Result): Result;
}
/**
 * Production Actor-local authority state (§3.4 rules 6–8). One durable
 * per-holder watermark store backs BOTH invalidation delivery and mediated
 * stale observation; a stale observation atomically joins the current path
 * epochs into the holder watermark, invalidates the cached resolution, and
 * persists the deniedPreEffect evidence with no EffectAttempt — all in one
 * Actor transaction, so a rollback leaves no partial denial. The resolution
 * cache itself is scoped to the exact current Turn lease (rule 8): a cache
 * hit revalidates its candidate's LeaseToken against the host's live lease
 * state, so a `bundled` resolution cannot outlive its Turn merely because
 * nothing happened to look it up again in the meantime.
 */
export declare class ActorAuthorityState implements OperationAuthorityStatePort<PrincipalRef> {
    #private;
    private readonly tenant;
    private readonly owner;
    private readonly watermarks;
    private readonly host;
    private readonly now;
    constructor(tenant: TenantId, owner: ActorRef, watermarks: InvalidationWatermarkStore, host: ActorAuthorityHost, now: () => Date);
    resolve(caller: PrincipalRef, binding: BindingName): OperationResolutionCandidate | undefined;
    currentBinding(key: string): Binding | undefined;
    currentPath(binding: Binding): PathEpochEvidence;
    currentWatermark(principal: PrincipalRef): InvalidationWatermark;
    currentLease(token: LeaseToken): TurnLease | undefined;
    admits(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[], at: Date): boolean;
    contributorDomain(facet: FacetRef): ProtectionDomain | undefined;
    admitsInterception(resolution: OperationResolutionState, contributor: FacetRef, declaration: InterceptorDeclaration, descriptor: OperationDescriptor): boolean;
    release(resolution: OperationResolutionState): void;
    /**
     * Invalidation delivery (§3.4 rule 6): join delivered Scope epochs into the
     * holder's watermark. Delivery and stale observation share the one store, so
     * a delivered higher epoch immediately ends direct authorization for every
     * cached resolution whose path it dominates.
     */
    deliverInvalidation(principal: PrincipalRef, entries: readonly ScopeEpoch[]): InvalidationWatermark;
    observeStale(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[]): void;
    private join;
    private invalidate;
    private matches;
    /**
     * SPEC §3.4 rule 8: a `bundled` resolution lasts no longer than its exact Turn and
     * deadline. A cached candidate stores the LeaseToken observed when it was built, so
     * without this check a cache hit could keep serving that Turn's authority after the
     * Turn fenced, was reclaimed by another holder, or expired — every later lookup would
     * have to be caught by unrelated downstream checks instead of by the cache's own
     * lifetime. This asks the host for the *current* lease behind the exact token the
     * candidate carries, so fencing, reclaiming, or completing that Turn invalidates the
     * cache entry immediately rather than only at the next `authorizeDirect` call. A
     * candidate with no lease (route-based, no-Turn mediation) has nothing to expire here.
     */
    private leaseCurrent;
}
