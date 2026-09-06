import { AuthorityPermit, AuthorityPermitAdmissionPort, AuthorityPermitAuthenticator, AuthorityPermitExpectation, AuthorityCheckEvidence, TargetAuthorityPermitDenial, TargetAuthorityPermitRequest, TargetLeaseEvidenceIssuer, type TargetLeaseEvidenceReference, type AuthorityCheckRequest, type AuthenticatedAuthorityPermit, type AuthorityPermitTargetDenialStore, type AuthorityPermitTargetRequestStore, type ScopeEpoch, type TargetLeaseEvidenceStore } from "../authority/index.js";
import type { ActorRef } from "../actors/index.js";
import { type ItemClaim, type PreparedInvocation, type StructuralCodec } from "../invocations/index.js";
import type { PrincipalRef, TenantId } from "../identity/index.js";
import { AuthorityAdmissionReference, type AuthorityAdmissionContext, type AuthorityAdmissionPort, type CanonicalBatchAuthorityAuthenticationPort, type CanonicalBatchAuthorityPermitPort } from "../invocations/index.js";
export type AuthorityPermitReference = ReturnType<AuthorityPermit["toData"]>;
export declare const authorityPermitReferenceCodec: StructuralCodec<AuthorityPermitReference>;
export interface AuthorityPermitExpectationFactory<Transaction, Lease, Authority, Domain, PathEpochs> {
    forClaim(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>): AuthorityPermitExpectation;
    forAdmission(transaction: Transaction, context: AuthorityAdmissionContext<Lease, Authority, Domain, PathEpochs>): AuthorityPermitExpectation | undefined;
}
export interface TargetAuthorityPermitDenialState<Transaction> {
    joinDeniedEpochs(transaction: Transaction, principal: PrincipalRef, entries: readonly ScopeEpoch[]): void;
    invalidateResolution(transaction: Transaction, expectation: AuthorityPermitExpectation): void;
}
export declare class TargetAuthorityPermitDenialPort<Transaction> {
    private readonly tenant;
    private readonly owner;
    private readonly store;
    private readonly state;
    constructor(tenant: TenantId, owner: ActorRef, store: AuthorityPermitTargetDenialStore<Transaction>, state: TargetAuthorityPermitDenialState<Transaction>);
    deny(transaction: Transaction, authentication: AuthenticatedAuthorityPermitDenial): void;
}
export interface AuthorityCheckRequestFactory<Lease, Authority, Domain, PathEpochs> {
    forClaim(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>, nonce: string): AuthorityCheckRequest;
}
/**
 * The immutable outcome a source host returns to the target: which committed
 * attestation to name in the permit request, and the deadline it already bound.
 * The record itself never crosses to the target.
 */
export interface TargetLeaseEvidenceAttestation {
    readonly reference: TargetLeaseEvidenceReference;
    readonly deadline: Date;
}
export declare abstract class TargetLeaseEvidenceTransport {
    /**
     * The source host commits one canonical immutable attestation for the provisional
     * target request, projects it to its Tenant under its own authenticated caller
     * after its transaction closes, and returns only the projected immutable reference.
     * `undefined` means its current lease cannot attest the request.
     */
    abstract attest(request: Uint8Array): Promise<TargetLeaseEvidenceAttestation | undefined>;
}
/** The source's own authenticated channel to its Tenant for lease-evidence projection. */
export declare abstract class TargetLeaseEvidenceProjectionTransport {
    abstract project(evidence: Uint8Array, idempotencyKey: string): Promise<Uint8Array>;
}
/**
 * Source-side host step. The attestation commits in the owning Actor's transaction;
 * the Tenant projection is originated by the source host itself only after that
 * transaction has closed, so no target ever forwards evidence bytes or speaks as the
 * source, and no await spans the commit.
 */
export declare class StoredProjectedTargetLeaseEvidence<Transaction> extends TargetLeaseEvidenceTransport {
    private readonly store;
    private readonly issuer;
    private readonly projection;
    private readonly now;
    constructor(store: TargetLeaseEvidenceStore<Transaction>, issuer: TargetLeaseEvidenceIssuer<Transaction>, projection: TargetLeaseEvidenceProjectionTransport, now: () => Date);
    attest(request: Uint8Array): Promise<TargetLeaseEvidenceAttestation | undefined>;
}
export declare abstract class AuthorityPermitIssuanceTransport {
    abstract issue(request: Uint8Array, idempotencyKey: string): Promise<Uint8Array>;
}
export declare class AuthenticatedAuthorityPermitDenial {
    #private;
    constructor(authority: symbol, request: TargetAuthorityPermitRequest, evidence: AuthorityCheckEvidence);
    record(): TargetAuthorityPermitDenial;
}
export declare class IssuedAuthorityPermitPort<Transaction, Lease, Authority, Domain, PathEpochs> implements CanonicalBatchAuthorityPermitPort<Transaction, Lease, Authority, Domain, PathEpochs, AuthorityPermitReference, AuthenticatedAuthorityPermitDenial> {
    private readonly store;
    private readonly expectations;
    private readonly denial;
    private readonly authority;
    private readonly transport;
    private readonly nonce;
    private readonly now;
    private readonly lifetimeMilliseconds;
    private readonly attestation;
    constructor(store: AuthorityPermitTargetRequestStore<Transaction>, expectations: AuthorityPermitExpectationFactory<Transaction, Lease, Authority, Domain, PathEpochs>, denial: TargetAuthorityPermitDenialPort<Transaction>, authority: AuthorityCheckRequestFactory<Lease, Authority, Domain, PathEpochs>, transport: AuthorityPermitIssuanceTransport, nonce: (invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>) => string, now: () => Date, lifetimeMilliseconds: number, attestation?: TargetLeaseEvidenceTransport | undefined);
    issue(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>): Promise<{
        readonly kind: "issued";
        readonly admission: AuthorityAdmissionReference<AuthorityPermitReference>;
    } | {
        readonly kind: "denied";
        readonly denial: AuthenticatedAuthorityPermitDenial;
        readonly reason: string;
    } | {
        readonly kind: "invalid";
        readonly reason: string;
    } | {
        readonly kind: "expired";
    }>;
    private readSourceAttestation;
    deny(transaction: Transaction, invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>, denial: AuthenticatedAuthorityPermitDenial): void;
}
export declare class TargetAuthorityPermitAuthenticationPort<TargetTransaction, Lease, Authority, Domain, PathEpochs> implements CanonicalBatchAuthorityAuthenticationPort<Lease, Authority, Domain, PathEpochs, AuthorityPermitReference, AuthenticatedAuthorityPermit> {
    private readonly authenticator;
    private readonly expectations;
    constructor(authenticator: AuthorityPermitAuthenticator, expectations: AuthorityPermitExpectationFactory<TargetTransaction, Lease, Authority, Domain, PathEpochs>);
    authenticate(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>, admission: AuthorityAdmissionReference<AuthorityPermitReference>): Promise<AuthenticatedAuthorityPermit>;
}
export declare class ConsumedAuthorityAdmissionPort<Transaction, Lease, Authority, Domain, PathEpochs> implements AuthorityAdmissionPort<Transaction, Lease, Authority, Domain, PathEpochs, AuthorityPermitReference, AuthenticatedAuthorityPermit> {
    private readonly admission;
    private readonly expectations;
    private readonly now;
    constructor(admission: AuthorityPermitAdmissionPort<Transaction>, expectations: AuthorityPermitExpectationFactory<Transaction, Lease, Authority, Domain, PathEpochs>, now: () => Date);
    admits(transaction: Transaction, admission: AuthorityAdmissionReference<AuthorityPermitReference>, context: AuthorityAdmissionContext<Lease, Authority, Domain, PathEpochs>, authentication?: AuthenticatedAuthorityPermit): boolean;
}
