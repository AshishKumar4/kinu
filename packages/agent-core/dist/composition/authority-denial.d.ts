import type { ActorRef } from "../actors/index.js";
import type { TurnLease } from "../agents/index.js";
import type { Binding, PathEpochEvidence } from "../authority/index.js";
import type { BindingName, FacetData, FacetRef, InterceptorDeclaration, OperationDescriptor, ProtectionDomain } from "../facets/index.js";
import type { PrincipalRef, TenantId } from "../identity/index.js";
import { AuditRecord, PreEffectReceipt } from "../invocations/index.js";
import type { LeaseToken } from "../protocol/index.js";
import type { OperationResolutionCandidate, OperationResolutionState } from "./authority.js";
import type { ActorAuthorityHost, StaleDenialEvidence } from "./authority-state.js";
import { DerivedMediationIdentities } from "./mediation-identity.js";
/** The Actor whose durable plane a denial is written into, and the Tenant it belongs to. */
export interface ActorDenialIdentity {
    readonly actor: ActorRef;
    readonly tenant: TenantId;
}
/**
 * The §7.4 record chain one stale observation commits: the denial pair plus the
 * Invocation root it chains to.
 */
export interface StaleDenialRecords extends StaleDenialEvidence {
    readonly root: AuditRecord;
}
/**
 * The denial evidence a stale mediated read commits (SPEC §3.4 rule 7, §7.4), derived
 * from the resolution the authority plane already holds.
 *
 * Every field is a function of evidence the refusal already determines, so this is the
 * whole content and a deployment supplies none of it. That is the point: a host that
 * invents the Receipt id, the Invocation it names, or the audit edge can write a denial
 * that is durable, well-formed, and unrelated to the refusal that produced it, and no
 * later reader can tell. Deriving instead of supplying also makes the write idempotent —
 * a worker that crashes between minting these records and persisting them recomputes the
 * same three ids from the same stale resolution, so a retried observation converges on
 * one denial rather than forking a second.
 *
 * The chain is the one §7.4 admits for a pre-effect denial: the Receipt carries no
 * EffectAttempt, so its AuditRecord is caused by the Invocation root directly rather than
 * by an attempt record that does not exist.
 */
export declare class DerivedStaleDenialEvidence {
    private readonly identity;
    private readonly identities;
    private readonly now;
    constructor(identity: ActorDenialIdentity, identities: DerivedMediationIdentities, now: () => Date);
    records(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[]): StaleDenialRecords;
}
/**
 * The shipped half of an Actor's authority host: the denial content, derived.
 *
 * `ActorAuthorityHost` mixes two different kinds of member. Most are genuine deployment
 * boundaries — how a resolution candidate is assembled, where the Turn lease lives, which
 * policy admits an operation, what an Actor transaction is, and how a durable write
 * happens — and every one of them stays abstract here, because inventing an answer for
 * any of them would be inventing a plane rather than shipping a host.
 *
 * `denialEvidence` is not one of those. §7.4 determines the denial's content completely
 * from the stale resolution, so a host free to choose it is a host free to choose wrong.
 * It is implemented here and deliberately not abstract: extending this class is how a
 * deployment gets the derived content instead of its own.
 */
export declare abstract class DerivedDenialAuthorityHost implements ActorAuthorityHost {
    /**
     * The derivation this host writes from. It is reachable by subclasses because the
     * Invocation root belongs to the same chain and the same identity: a deployment that
     * opens the Invocation at refusal time writes `records(...).root`, and one that opened
     * it earlier recomputes the identical id and writes nothing new.
     */
    protected readonly denial: DerivedStaleDenialEvidence;
    constructor(identity: ActorDenialIdentity, scope: string, now: () => Date);
    abstract resolve(caller: PrincipalRef, binding: BindingName): OperationResolutionCandidate | undefined;
    abstract currentBinding(key: string): Binding | undefined;
    abstract currentPath(binding: Binding): PathEpochEvidence;
    abstract currentLease(token: LeaseToken): TurnLease | undefined;
    abstract admits(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[], at: Date): boolean;
    abstract contributorDomain(facet: FacetRef): ProtectionDomain | undefined;
    abstract admitsInterception(resolution: OperationResolutionState, contributor: FacetRef, declaration: InterceptorDeclaration, descriptor: OperationDescriptor): boolean;
    abstract appendDenial(receipt: PreEffectReceipt, audit: AuditRecord): void;
    abstract transaction<Result>(operation: () => Result): Result;
    denialEvidence(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[]): StaleDenialEvidence;
}
