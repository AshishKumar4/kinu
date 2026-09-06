import type { ActorRef } from "../actors/index.js";
import type { AuthenticatedAuthorityPermit, AuthorityPermitAuthenticator, AuthorityPermitTargetAdmissionStore, AuthorityPermitTargetDenialStore, AuthorityPermitTargetRequestStore, ScopeEpoch } from "../authority/index.js";
import type { TenantId, PrincipalRef } from "../identity/index.js";
import type { InvocationEvidencePersistence, InvocationReplayPersistence, InvocationTransactionPort } from "../invocations/index.js";
import type { AuthorityPermitExpectation } from "../authority/index.js";
import { type AuthenticatedAuthorityPermitDenial, type AuthorityCheckRequestFactory, type AuthorityPermitExpectationFactory, type AuthorityPermitIssuanceTransport, type TargetLeaseEvidenceTransport, type AuthorityPermitReference } from "./permit.js";
import { MediatedOperationPipeline, type MediatedOperationPipelineInit } from "./mediation.js";
import type { MediationAuthorityReference, MediationDomainReference, MediationLeaseReference, MediationPathEpochReference, MediationPersistence } from "./mediation-preparation.js";
/** One target Actor's transaction-bound mediation and distributed-permit state. */
export declare abstract class TargetPermitMediationAggregate<Transaction> implements InvocationTransactionPort<Transaction> {
    abstract readonly actor: ActorRef;
    abstract readonly tenant: TenantId;
    abstract readonly persistence: MediationPersistence<Transaction, AuthorityPermitReference>;
    abstract readonly evidence: InvocationEvidencePersistence<Transaction> & InvocationReplayPersistence<Transaction>;
    abstract readonly permitRequests: AuthorityPermitTargetRequestStore<Transaction>;
    abstract readonly permitDenials: AuthorityPermitTargetDenialStore<Transaction>;
    abstract readonly permitAdmission: AuthorityPermitTargetAdmissionStore<Transaction>;
    abstract transact<Result>(operation: (transaction: Transaction) => Result): Result;
    abstract joinDeniedEpochs(transaction: Transaction, principal: PrincipalRef, entries: readonly ScopeEpoch[]): void;
    abstract invalidateResolution(transaction: Transaction, expectation: AuthorityPermitExpectation): void;
}
type TargetPermitPipelineBaseInit<Transaction> = Omit<MediatedOperationPipelineInit<Transaction, AuthorityPermitReference, AuthenticatedAuthorityPermit, AuthenticatedAuthorityPermitDenial>, "actor" | "tenant" | "transactions" | "persistence" | "evidence" | "permits" | "authentication" | "admission">;
export interface TargetPermitMediationPipelineInit<Transaction> extends TargetPermitPipelineBaseInit<Transaction> {
    readonly aggregate: TargetPermitMediationAggregate<Transaction>;
    readonly expectations: AuthorityPermitExpectationFactory<Transaction, MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference>;
    readonly authorityRequests: AuthorityCheckRequestFactory<MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference>;
    readonly issuanceTransport: AuthorityPermitIssuanceTransport;
    readonly sourceAttestation: TargetLeaseEvidenceTransport;
    readonly authenticator: AuthorityPermitAuthenticator;
    readonly permitNonce: (invocation: Parameters<AuthorityCheckRequestFactory<MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference>["forClaim"]>[0], claim: Parameters<AuthorityCheckRequestFactory<MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference>["forClaim"]>[1]) => string;
    readonly permitLifetimeMilliseconds: number;
}
/** The production assembly that prevents independently wired target permit stores. */
export declare function activateTargetPermitMediation<Transaction>(init: TargetPermitMediationPipelineInit<Transaction>): Promise<MediatedOperationPipeline<Transaction, AuthorityPermitReference, AuthenticatedAuthorityPermit, AuthenticatedAuthorityPermitDenial>>;
export {};
