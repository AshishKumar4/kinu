import type { ContentStore } from "../content/index.js";
import { AuthoredCodeSource, BindingName, CapabilitySpec, FacetPackageId, FacetRef, Operation, OperationDescriptor, type AuthoredCodeBackingId, type AuthoredCodeConsumer, type FacetData, type OperationContext, type OperationName } from "../facets/index.js";
import type { OperationGateway } from "./gateway.js";
/**
 * One capability explicitly passed into an isolate: the name the loaded code addresses
 * it by, the exact Facet that name must resolve to, and the Operations that Facet
 * declares reachable through it. The Package is derived from the Facet reference rather
 * than stated separately, so a passed capability cannot claim one Package and resolve to
 * another.
 */
export declare class AuthoredCodeCapability {
    readonly name: BindingName;
    readonly facet: FacetRef;
    /**
     * What the isolate may do with it. Omitted means "equal to what the delegator
     * holds" — the widest §3.4 admits — and any stated narrowing is enforced by the
     * ordinary attenuation rules, never by this record.
     */
    readonly capability?: CapabilitySpec | undefined;
    readonly package: FacetPackageId;
    /**
     * The declared Operations this name conveys (SPEC §4.7). They come from the
     * composition's `operations` contributions, never from the submission, because
     * availability is a property of the composition — so nothing the model writes can
     * widen what the isolate reaches.
     */
    readonly operations: readonly OperationDescriptor[];
    constructor(name: BindingName, facet: FacetRef, 
    /**
     * What the isolate may do with it. Omitted means "equal to what the delegator
     * holds" — the widest §3.4 admits — and any stated narrowing is enforced by the
     * ordinary attenuation rules, never by this record.
     */
    capability?: CapabilitySpec | undefined, operations?: readonly OperationDescriptor[]);
}
/**
 * The complete capability set one isolate was passed (SPEC §4.7). It is the whole of
 * what the isolate can reach: a name absent from this set has no channel, because the
 * isolate holds no ambient authority and the only outward call path checks membership
 * here before it resolves anything.
 *
 * The set is also where §4.7's availability bound is discharged. An Operation declared
 * `native` is not passable, and the refusal is the whole outcome: dropping it instead
 * would leave the model an offered catalog the isolate cannot reach, which is the one
 * disagreement between the two the declaration exists to prevent.
 */
export declare class AuthoredCodeCapabilitySet {
    #private;
    constructor(capabilities: readonly AuthoredCodeCapability[]);
    static get none(): AuthoredCodeCapabilitySet;
    capability(name: BindingName): AuthoredCodeCapability | undefined;
    get names(): readonly BindingName[];
}
export interface AuthoredCodeInvocationRequest {
    readonly binding: BindingName;
    readonly operation: OperationName;
    readonly input: FacetData;
}
/**
 * The one channel out of an isolate. A backing hands the loaded code this port and
 * nothing else, so every call the code makes arrives here and leaves as an ordinary
 * Invocation.
 */
export declare abstract class AuthoredCodeInvocationPort {
    abstract invoke(request: AuthoredCodeInvocationRequest): Promise<FacetData>;
}
/**
 * The isolate's calls, re-entering the ordinary Invocation pipeline under the isolate's
 * own delegated authority. Three checks make the wrong call unexpressible rather than
 * merely discouraged: the requested name must belong to the passed set; the gateway is
 * the isolate's own, so resolution happens against the isolate's protection domain and
 * never the loader's; and the resolved Facet and Package must be the exact ones the
 * passed capability pinned.
 *
 * Unlike a Turn's bound Operations, an isolate's calls are not forced onto the mediated
 * path here — §4.7 makes them ordinary Invocations tiered by §7.2, and §7.2 alone
 * decides. A `dynamic` facet is never `direct`, but a `dynamic` isolate calling a
 * `bundled` facet is a case the tiering rules already answer.
 */
export declare class GatewayAuthoredCodeInvocationPort extends AuthoredCodeInvocationPort {
    #private;
    private readonly gateway;
    private readonly capabilities;
    private readonly isolate;
    private readonly signal;
    constructor(gateway: OperationGateway, capabilities: AuthoredCodeCapabilitySet, isolate: string, signal: AbortSignal);
    invoke(request: AuthoredCodeInvocationRequest): Promise<FacetData>;
    private requireNotCancelled;
}
/**
 * The passed capability set as the authority plane holds it: Grants delegated under
 * §3.4 and Bindings in the isolate's own protection domain, plus the gateway that
 * resolves them. Disposing it revokes the delegation — which severs the isolate and
 * leaves the authority it was delegated from untouched, because those are different
 * Grants in one lineage.
 */
export declare abstract class AuthoredCodeDelegation implements AsyncDisposable {
    abstract readonly capabilities: AuthoredCodeCapabilitySet;
    abstract readonly gateway: OperationGateway;
    abstract [Symbol.asyncDispose](): Promise<void>;
}
export interface AuthoredCodeDelegationRequest {
    readonly consumer: AuthoredCodeConsumer;
    /** The capabilities the submission asks for, each pinned to an exact Facet. */
    readonly requested: AuthoredCodeCapabilitySet;
    /** Identifies the one isolate this delegation is for, and nothing else. */
    readonly isolate: string;
    readonly signal: AbortSignal;
}
/**
 * Delegating a capability set into a fresh isolate domain. Implementations mint the
 * passed Grants as attenuations of the delegator's own, which is what bounds the set at
 * "equal at most, never wider" without this seam restating the §3.4 rules.
 */
export declare abstract class AuthoredCodeDelegationPort {
    abstract delegate(request: AuthoredCodeDelegationRequest): Promise<AuthoredCodeDelegation>;
}
export interface AuthoredCodeRunRequest {
    readonly consumer: AuthoredCodeConsumer;
    /** The one isolate this run is for: §4.7 gives each submission exactly one. */
    readonly isolate: string;
    readonly entry: string;
    /** Module name to its UTF-8 source, resolved from the submission's content refs. */
    readonly code: ReadonlyMap<string, string>;
    readonly capabilities: AuthoredCodeCapabilitySet;
    readonly invocations: AuthoredCodeInvocationPort;
    readonly input: FacetData;
    readonly signal: AbortSignal;
}
/**
 * A hosting mechanism for a `dynamic` domain (§4.7, §10.2). Every backing loads the
 * code into a fresh isolate with zero ambient authority and zero ambient egress, gives
 * it `invocations` and nothing else, runs it once against `input`, and disposes it. The
 * choice between backings is operational: each satisfies those guarantees on its own,
 * never by comparison with another.
 */
export declare abstract class AuthoredCodeBacking {
    abstract readonly id: AuthoredCodeBackingId;
    abstract run(request: AuthoredCodeRunRequest): Promise<FacetData>;
}
/**
 * The backings a substrate profile offers and the one it declares as its default. The
 * default is the profile's, not the Blueprint's: §4.7 sends a consumer the Blueprint
 * does not map here rather than to an arbitrary member of the offered set.
 */
export declare class AuthoredCodeBackingSet {
    #private;
    readonly declaredDefault: AuthoredCodeBackingId;
    constructor(backings: readonly AuthoredCodeBacking[], declaredDefault: AuthoredCodeBackingId);
    backing(id: AuthoredCodeBackingId): AuthoredCodeBacking;
}
export interface AuthoredCodeSubmission {
    readonly source: AuthoredCodeSource;
    readonly capabilities: AuthoredCodeCapabilitySet;
    readonly input: FacetData;
}
export interface AuthoredCodeRunScope {
    /**
     * The isolate's identity, which is the submitting Invocation's: one isolate per
     * submission, so the Invocation that carries the submission names it exactly.
     */
    readonly isolate: string;
    readonly content: ContentStore;
    readonly signal: AbortSignal;
}
export interface AuthoredCodeHostInit {
    readonly delegations: AuthoredCodeDelegationPort;
    readonly backings: AuthoredCodeBackingSet;
    /** The Blueprint's consumer → backing declaration (§9.2 `policies.placement`). */
    readonly backingFor: (consumer: AuthoredCodeConsumer, profileDefault: AuthoredCodeBackingId) => AuthoredCodeBackingId;
}
/**
 * One submission of agent-authored code, run once. The host owns the whole shape §4.7
 * states: delegate the passed capability set into a fresh isolate domain, resolve the
 * submitted source, select the declared backing, run the code with the one outward
 * channel and nothing else, and revoke the delegation when the submission ends.
 *
 * The three §4.7 consumers differ only in when that last step happens, which is why the
 * consumer is a parameter here rather than three code paths.
 */
export declare class AuthoredCodeHost {
    private readonly init;
    constructor(init: AuthoredCodeHostInit);
    run(consumer: AuthoredCodeConsumer, submission: AuthoredCodeSubmission, scope: AuthoredCodeRunScope): Promise<FacetData>;
}
/**
 * Programmatic tool calling as the model sees it: one Operation invocation, code in,
 * value out, with every Operation the code called in between carrying its own admission
 * and evidence. Its impact is `delegate` because handing the capability set to the
 * isolate is delegation, which §7.2 floors at mediated — so a submission is admitted,
 * receipted, and audited exactly once whatever the code inside goes on to do.
 *
 * §4.7 fixes the shape and §11 declares no profile that owns it, so the Operation's
 * name is the contributing Facet's to choose (P11-BASE-NAMES); the impact and the
 * semantics are not.
 */
export declare class AuthoredCodeOperation extends Operation {
    private readonly host;
    readonly descriptor: OperationDescriptor;
    constructor(name: OperationName, host: AuthoredCodeHost);
    execute(context: OperationContext, input: FacetData): Promise<FacetData>;
}
/**
 * A submission names Bindings and never Operations: `AUTHORED_CODE_INPUT_SCHEMA` admits no
 * key that could carry one, so the declared Operations each passed name conveys are the
 * composition's to attach (SPEC §4.7) and a submission cannot state its own availability.
 */
export declare function decodeSubmission(input: FacetData): AuthoredCodeSubmission;
