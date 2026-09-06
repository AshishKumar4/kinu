import type { ActorRef } from "../actors/index.js";
import { Binding, InvalidationWatermark, PathEpochEvidence } from "../authority/index.js";
import { Digest } from "../core/index.js";
import type { PackagePin, PolicySet } from "../definition/index.js";
import { CapabilitySpec, type BindingName, type FacetData, type FacetRef, type InterceptorDeclaration, type OperationDescriptor, type ProtectionDomain } from "../facets/index.js";
import type { PrincipalRef } from "../identity/index.js";
import type { AuthorityResolution, OperationAuthorityPort } from "../operations/index.js";
import type { InvocationPlacementPin } from "../invocations/index.js";
import type { LeaseToken, TurnLease } from "../agents/index.js";
import type { RouteReservationId } from "../interaction-references/index.js";
import type { MediatedReplayBinding } from "../operations/index.js";
/**
 * Why a stale mediated re-check refuses, stated once. The thrown error and the durable
 * `deniedPreEffect` Receipt a stale observation writes (§3.4 rule 7) must say the same
 * thing: a caller reading the error and an auditor reading the Receipt are looking at one
 * refusal, and two independently spelled reasons would make that impossible to confirm.
 */
export declare const MEDIATED_STALE_DENIAL_REASON = "Mediated authority intent is stale";
export interface OperationResolutionEvidence {
    readonly principal: PrincipalRef;
    readonly binding: Binding;
    readonly pathEpochs: PathEpochEvidence;
    readonly watermark: InvalidationWatermark;
    readonly lease: LeaseToken | undefined;
    readonly originalLease: TurnLease | undefined;
    readonly route: RouteReservationId | undefined;
    readonly package: PackagePin;
    readonly placement: InvocationPlacementPin;
    readonly owner: ActorRef;
    /**
     * The policy sets governing this resolution's scope chain. Required so a resolver
     * that has no applicable policies states that explicitly with an empty array — an
     * omitted field would be indistinguishable from policies silently not threaded, and
     * policy tightening plus approval requirements would be lost (SPEC §7.2).
     */
    readonly policies: readonly PolicySet[];
    /**
     * True only when the resolver attests that the operation targets an Environment
     * session owned by the current Turn. Lease possession alone does not establish
     * this — a leased Turn can resolve operations against sessions it does not own,
     * and only session-scoped execute is eligible for the direct tier (SPEC §7.2).
     */
    readonly turnOwnedSession: boolean;
    /**
     * True only when the resolver attests that the operation's target is the
     * Turn-owned Session's own filesystem. Only such a mutate is eligible for
     * the direct tier under the §7.2 floor; every other mutate stays mediated.
     */
    readonly sessionFilesystemTarget: boolean;
    /**
     * True only when the bundled Facet and a versioned Binding projection are local to
     * the Actor that owns the exact Turn lease. Dedicated Run Actors without that
     * projection must mediate even an otherwise direct-eligible operation.
     */
    readonly turnActorAuthorityLocal: boolean;
    /** Effective operation authority captured from the one Grant plane at resolution. */
    readonly directAuthority: ResolvedOperationAuthority | undefined;
}
export interface OperationResolutionCandidate extends OperationResolutionEvidence {
}
export declare class ResolvedOperationAuthority {
    #private;
    readonly facet: FacetRef;
    constructor(facet: FacetRef, capabilities: readonly CapabilitySpec[]);
    admits(descriptor: OperationDescriptor, inputs: readonly FacetData[]): boolean;
}
export declare class OperationResolutionState implements OperationResolutionEvidence {
    #private;
    constructor(evidence: OperationResolutionEvidence, resolvedAt: Date, originalLeaseExpiresAt: Date | undefined, resolutionDeadline: Date | undefined, authority: symbol);
    readonly principal: PrincipalRef;
    readonly binding: Binding;
    readonly pathEpochs: PathEpochEvidence;
    readonly watermark: InvalidationWatermark;
    readonly lease: LeaseToken | undefined;
    readonly originalLease: TurnLease | undefined;
    readonly route: RouteReservationId | undefined;
    readonly package: PackagePin;
    readonly placement: InvocationPlacementPin;
    readonly owner: ActorRef;
    readonly policies: readonly PolicySet[];
    readonly turnOwnedSession: boolean;
    readonly sessionFilesystemTarget: boolean;
    readonly turnActorAuthorityLocal: boolean;
    readonly directAuthority: ResolvedOperationAuthority | undefined;
    get resolvedAt(): Date;
    get originalLeaseExpiresAt(): Date | undefined;
    get resolutionDeadline(): Date | undefined;
    admitsDirectAt(at: Date): boolean;
}
export interface OperationAuthorityStatePort<Caller> {
    resolve(caller: Caller, binding: BindingName): OperationResolutionCandidate | undefined;
    currentBinding(key: string): Binding | undefined;
    currentPath(binding: Binding): PathEpochEvidence;
    currentWatermark(principal: PrincipalRef): InvalidationWatermark;
    currentLease(token: LeaseToken): TurnLease | undefined;
    admits(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[], at: Date): boolean;
    contributorDomain(facet: FacetRef): ProtectionDomain | undefined;
    admitsInterception(resolution: OperationResolutionState, contributor: FacetRef, declaration: InterceptorDeclaration, descriptor: OperationDescriptor): boolean;
    release(resolution: OperationResolutionState): void;
    /**
     * Record a stale-authority observation atomically (SPEC §3.4 rule 7): join the
     * current path Scope epochs into the holder watermark map, invalidate the cached
     * resolution, and persist the deniedPreEffect Receipt and AuditRecord with no
     * EffectAttempt. Required — an optional hook would let an implementation silently
     * skip the durable denial evidence, which is the defect class this exists to close.
     */
    observeStale(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[]): void;
}
export declare class ResolutionStamp {
    #private;
    readonly principal: PrincipalRef;
    readonly binding: Binding;
    readonly pathEpochs: PathEpochEvidence;
    readonly lease: LeaseToken;
    readonly inputDigest: Digest;
    readonly operationDigest: Digest;
    constructor(principal: PrincipalRef, binding: Binding, pathEpochs: PathEpochEvidence, lease: LeaseToken, originalLeaseExpiresAt: Date, resolvedAt: Date, resolutionDeadline: Date, descriptor: OperationDescriptor, inputs: readonly FacetData[]);
    get originalLeaseExpiresAt(): Date;
    get resolvedAt(): Date;
    get resolutionDeadline(): Date;
    matches(descriptor: OperationDescriptor, inputs: readonly FacetData[]): boolean;
}
export declare class MediatedAuthorityIntent {
    readonly principal: PrincipalRef;
    readonly binding: Binding;
    readonly pathEpochs: PathEpochEvidence;
    readonly domain: ProtectionDomain;
    readonly packagePin: PackagePin;
    readonly placement: InvocationPlacementPin;
    readonly owner: ActorRef;
    readonly lease: LeaseToken | undefined;
    readonly route: RouteReservationId | undefined;
    readonly policies: readonly PolicySet[];
    constructor(principal: PrincipalRef, binding: Binding, pathEpochs: PathEpochEvidence, domain: ProtectionDomain, packagePin: PackagePin, placement: InvocationPlacementPin, owner: ActorRef, lease: LeaseToken | undefined, route: RouteReservationId | undefined, 
    /**
     * Carried through because preparation freezes the §7.2 approval requirement into
     * the OperationPin, and resolution is the only place the governing policy sets
     * are known. Required for the same reason the evidence field is: a default would
     * make "no applicable policies" indistinguishable from policies never threaded,
     * and the second silently drops every tightening and approval the chain declared.
     */
    policies: readonly PolicySet[]);
}
export declare class TenantOperationAuthority<Caller> implements OperationAuthorityPort<Caller, OperationResolutionState, ResolutionStamp, MediatedAuthorityIntent> {
    private readonly state;
    private readonly now;
    constructor(state: OperationAuthorityStatePort<Caller>, now: () => Date);
    resolve(caller: Caller, binding: BindingName): Promise<AuthorityResolution<OperationResolutionState>>;
    tier(resolution: OperationResolutionEvidence, descriptor: OperationDescriptor, hasInterceptors: boolean): "direct" | "mediated";
    authorizeDirect(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[]): ResolutionStamp | undefined;
    authorizeMediated(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[]): Promise<MediatedAuthorityIntent>;
    replayBinding(authorization: MediatedAuthorityIntent, descriptor: OperationDescriptor): MediatedReplayBinding;
    cutPointDomain(resolution: OperationResolutionState): ProtectionDomain;
    contributorDomain(contributor: FacetRef): ProtectionDomain | undefined;
    /**
     * The rights half of §4.4 rule 2 only: the contributor holds a Grant over an Operation
     * whose target declared the interception capability — tested as that declaration's
     * presence (§4.1, C13-FACET-CAPABILITY-ABSENCE), never as a stored flag's truth,
     * because the manifest has no negative form for the flag to hold. Protection-domain
     * confinement is rule 1, and the interceptor runner refuses a cross-domain contributor
     * before any authority question is asked — sharing a domain confers no rights, and
     * holding a Grant confers no domain.
     */
    allowsInterception(resolution: OperationResolutionState, contributor: FacetRef, declaration: InterceptorDeclaration, target: FacetRef, descriptor: OperationDescriptor): boolean;
    release(resolution: OperationResolutionState): void;
}
