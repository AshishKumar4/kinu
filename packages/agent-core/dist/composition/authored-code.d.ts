import { type AuthorityMutationService, type TenantAuthorityReadStore } from "../authority/index.js";
import { ProtectionDomain } from "../facets/index.js";
import type { ScopeRef, SubjectRef } from "../identity/index.js";
import { AuthoredCodeCapabilitySet, AuthoredCodeDelegation, AuthoredCodeDelegationPort, type AuthoredCodeDelegationRequest, type OperationGateway } from "../operations/index.js";
import { TurnBoundOperation } from "../agents/index.js";
/**
 * The capability set an isolate is passed, assembled from the one declared set the Turn
 * already captured (SPEC §4.7, C13-FACET-CODE-AVAILABILITY).
 *
 * A submission names Bindings and never Operations, so the declared Operations each passed
 * name conveys have to be attached by the composition — and they are attached from the
 * Turn's own resolved `TurnBoundOperation`s, which §5.3 fixed against the Turn's FacetSet
 * and which the offered catalog is drawn from and checked against. That is what makes the
 * catalog the model was offered and the set the isolate can reach one declared set rather
 * than two a host keeps in agreement: there is no second source of descriptors here to
 * disagree with, and a host that read the Scope's current install records instead would be
 * building exactly that second source.
 *
 * Attaching is also what gives the §4.7 availability bound something to bite on. The set
 * refuses a `native` Operation rather than dropping it, so a submission that names a
 * Binding the model may call and the isolate may not is refused whole, before any Grant is
 * delegated and before any package code loads.
 */
export declare class TurnAuthoredCodeAvailability {
    #private;
    constructor(operations: readonly TurnBoundOperation[]);
    /**
     * The requested names carrying the Operations this Turn declares for them. A name this
     * Turn does not bind reaches nothing and is refused here rather than at the isolate's
     * first call, and a request naming another Facet for a name this Turn binds is refused
     * too: the passed capability pins a Facet, and a pin the Turn's own composition
     * contradicts is not a narrowing but a different capability.
     */
    passed(requested: AuthoredCodeCapabilitySet): AuthoredCodeCapabilitySet;
}
/**
 * How the isolate's own Invocations reach the authority plane. The factory is given the
 * fresh protection domain the delegated Bindings live in, and returns a gateway that
 * resolves in that domain only — which is what makes "the isolate presents its own
 * delegated authority, never its loader's" a property of the wiring rather than a rule
 * the loaded code is trusted to observe.
 */
export type IsolateGatewayFactory = (domain: ProtectionDomain, subject: SubjectRef) => OperationGateway;
export interface TenantAuthoredCodeDelegationInit {
    /** Exactly the two reads the delegation needs: the source Binding and its Grant. */
    readonly store: Pick<TenantAuthorityReadStore, "binding" | "grant">;
    readonly authority: AuthorityMutationService;
    /** The Workspace Scope the delegator's own Bindings live in. */
    readonly scope: ScopeRef;
    readonly subject: SubjectRef;
    /** The protection domain the delegator's own Bindings live in. */
    readonly domain: ProtectionDomain;
    readonly gateways: IsolateGatewayFactory;
}
/**
 * Passing a capability set into a §4.7 isolate, as the delegation §4.7 says it is.
 *
 * For each requested name the delegator's own Binding is read, its backing Grant is
 * delegated to an equal-or-narrower child Grant, and the child is bound under the same
 * name in a protection domain that exists only for this isolate. Nothing here restates
 * the §3.4 rules: creating the child Grant runs the ordinary delegation validation, so
 * a request for more than the delegator holds is refused by the same code that refuses
 * any other over-wide delegation, and a `deny` is not delegable at all because the
 * Grant record forbids attenuating one.
 *
 * Disposal revokes the delegated Grants. Revocation closes over descendants and leaves
 * ancestors alone, so the isolate is severed and its loader keeps exactly what it had.
 */
export declare class TenantAuthoredCodeDelegationPort extends AuthoredCodeDelegationPort {
    private readonly init;
    constructor(init: TenantAuthoredCodeDelegationInit);
    delegate(request: AuthoredCodeDelegationRequest): Promise<AuthoredCodeDelegation>;
    private delegateOne;
    private sourceBinding;
}
/**
 * One protection domain per isolate, named after the submission it exists for. Two
 * submissions therefore never share a domain, and a Binding minted for one is not
 * addressable from the other — Binding identity includes the domain (§3.4).
 *
 * `no-secrets` is not a policy choice here: raw credentials stay in Tenant custody and
 * delegation moves capability stubs, never secrets (§3.4 rule 3).
 */
export declare function isolateDomain(isolate: string): ProtectionDomain;
