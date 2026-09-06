import { PathEpochEvidence } from "../authority/index.js";
import { Digest, type JsonValue } from "../core/index.js";
import { type FacetRef, type ProtectionDomain } from "../facets/index.js";
import { type LeaseToken } from "../agents/index.js";
import { PreparedInvocation, type CanonicalBatchInvocationRequest, type CanonicalBatchPreparationPort, type InvocationMemoryCodecs, type InvocationPersistence, type InvocationPreparationPort, type InvocationTransactionPort, type PreparedInvocationCodecs, type StructuralCodec } from "../invocations/index.js";
import type { MediatedAuthorityIntent } from "./authority.js";
import type { DerivedMediationIdentities } from "./mediation-identity.js";
/**
 * A PreparedInvocation's Lease, Authority, Domain, and PathEpochs are *structural
 * references*: the invocations context never interprets them, persists them through a
 * codec, and requires them to be immutable data carrying no behavior (§8.3). Each is
 * therefore declared here as the canonical data shape of the domain value it stands for,
 * with the conversion at this boundary rather than a domain class smuggled into the
 * record.
 */
export interface MediationLeaseReference {
    readonly turn: string;
    readonly tenant: string;
    readonly principal: string;
    readonly epoch: number;
}
/** SPEC §7.3's `InvocationAuthority`, as a structural reference. */
export interface MediationAuthorityReference {
    readonly kind: "initiator" | "delegated";
    readonly tenant: string;
    readonly principal: string;
    readonly binding: string;
}
export interface MediationDomainReference {
    readonly kind: "frontend" | "backend";
    readonly label: string;
    readonly secretPolicy: "no-secrets" | "may-hold-secrets";
}
export interface MediationPathEpochReference {
    readonly path: readonly JsonValue[];
}
export declare function leaseReference(token: LeaseToken): MediationLeaseReference;
export declare function leaseToken(reference: MediationLeaseReference): LeaseToken;
export declare function sameLeaseReference(left: MediationLeaseReference, right: MediationLeaseReference): boolean;
export declare function domainReference(domain: ProtectionDomain): MediationDomainReference;
export declare function pathEpochReference(evidence: PathEpochEvidence): MediationPathEpochReference;
export declare const leaseReferenceCodec: StructuralCodec<MediationLeaseReference>;
export declare const authorityReferenceCodec: StructuralCodec<MediationAuthorityReference>;
export declare const domainReferenceCodec: StructuralCodec<MediationDomainReference>;
export declare const pathEpochReferenceCodec: StructuralCodec<MediationPathEpochReference>;
export declare const mediationPreparedCodecs: PreparedInvocationCodecs<MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference>;
export declare function mediationInvocationCodecs<Admission>(admission: StructuralCodec<Admission>): InvocationMemoryCodecs<MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference, Admission>;
/**
 * The activation facts an OperationPin commits that authority resolution does not carry:
 * which configured runtime the host actually activated for this Facet, and under which
 * activation generation and registration it declared the Operation. Only the component
 * that activated the Facet knows these, so the pipeline is told rather than guessing.
 */
export interface FacetActivationPin {
    readonly configurationDigest: Digest;
    readonly runtimeDigest: Digest;
    readonly activationGeneration: string;
    readonly registration: string;
}
export interface FacetActivationPinPort {
    pin(facet: FacetRef): FacetActivationPin | undefined;
}
export type MediationPreparedInvocation = PreparedInvocation<MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference>;
export type MediationPersistence<Transaction, Admission> = InvocationPersistence<Transaction, MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference, Admission>;
/**
 * Freezes the whole effect intent before policy or approval (§7.3), from the authority
 * resolution the gateway already produced and the activation pin of the Facet the host
 * actually activated.
 *
 * A routed Invocation is not prepared here. Its InvocationId, authority, projection
 * digest, and audit bridge belong to the authenticated RouteReservation, and
 * `RoutedInvocationAdmissionPort` has already made that preparation durable; this port
 * returns that exact record rather than deriving a second one that could disagree.
 */
export declare class CanonicalMediationPreparation<Transaction, Admission> implements CanonicalBatchPreparationPort<MediatedAuthorityIntent, MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference> {
    private readonly identities;
    private readonly activations;
    private readonly transactions;
    private readonly persistence;
    constructor(identities: DerivedMediationIdentities, activations: FacetActivationPinPort, transactions: InvocationTransactionPort<Transaction>, persistence: MediationPersistence<Transaction, Admission>);
    prepare(request: CanonicalBatchInvocationRequest<MediatedAuthorityIntent>): MediationPreparedInvocation;
    private routed;
    private operationPin;
}
/**
 * The ledger's preparation gate for locally prepared Invocations: the audit cause and
 * idempotency seed must be the ones this Invocation's own identity derives, and a header
 * carrying neither a lease nor a route cannot be prepared at all (§7.3).
 */
export declare class DerivedPreparationAdmission<Transaction> implements InvocationPreparationPort<Transaction, MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference> {
    private readonly identities;
    constructor(identities: DerivedMediationIdentities);
    admits(_transaction: Transaction, invocation: MediationPreparedInvocation): boolean;
}
