import type { ActorRef } from "../actors/index.js";
import type { ContentRef } from "../core/index.js";
import type { TenantId } from "../identity/index.js";
import { AttemptReceipt, AuditRecord, ClaimWorkerId, EffectAttempt, ItemClaim, PreEffectReceipt, AttemptCompletion, type AuthorityAdmissionReference, type CanonicalBatchRecordPort, type InvocationClaimOwnerPort, type PreEffectReceiptOutcome, type Receipt } from "../invocations/index.js";
import type { DerivedMediationIdentities } from "./mediation-identity.js";
import { type MediationAuthorityReference, type MediationDomainReference, type MediationLeaseReference, type MediationPathEpochReference, type MediationPreparedInvocation } from "./mediation-preparation.js";
export interface MediationRecordIdentity {
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    /**
     * The claim owner this process is. Claim recovery requires a different worker from
     * the one whose claim expired (§7.3), so this must identify the running worker
     * incarnation, not the Actor: two incarnations of one Actor are different workers.
     */
    readonly worker: ClaimWorkerId;
}
/**
 * The ledger's claim-owner gate: an EffectAttempt may only be admitted for the exact
 * ItemClaim that names it, and only under the authority that claim was taken with. An
 * executor claim attempts under its own exact lease token; a system claim attempts under
 * no token at all, so a system worker cannot borrow an executor's fencing (§5.3, §7.3).
 */
export declare class MediationClaimOwnerAdmission<Transaction, Admission> implements InvocationClaimOwnerPort<Transaction, MediationLeaseReference, Admission> {
    admits(_transaction: Transaction, claim: ItemClaim<MediationLeaseReference>, attempt: EffectAttempt<MediationLeaseReference, Admission>): boolean;
}
/**
 * Mints the durable evidence of §7.3–§7.4 — ItemClaims, EffectAttempts, Receipts, and
 * the AuditRecords that chain them — for one Actor's mediation pipeline.
 *
 * The audit chain it produces is the one §7.4 requires and the ledger enforces:
 * the Invocation root causes each EffectAttempt record, each attempt record causes its
 * Receipt record, and a reconciled Receipt's supersession record is caused by the
 * Receipt record it supersedes. A pre-effect denial has no attempt, so its Receipt
 * record is caused by the Invocation root directly.
 */
export declare class CanonicalMediationRecords<Admission> implements CanonicalBatchRecordPort<MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference, Admission> {
    private readonly identity;
    private readonly identities;
    private readonly claimLifetimeMilliseconds;
    constructor(identity: MediationRecordIdentity, identities: DerivedMediationIdentities, claimLifetimeMilliseconds: number);
    invocationAudit(invocation: MediationPreparedInvocation): AuditRecord;
    claim(invocation: MediationPreparedInvocation, itemIndex: number, previous: ItemClaim<MediationLeaseReference> | undefined, now: Date): ItemClaim<MediationLeaseReference>;
    retryClaim(invocation: MediationPreparedInvocation, previous: EffectAttempt<MediationLeaseReference, Admission>, now: Date): ItemClaim<MediationLeaseReference>;
    attempt(invocation: MediationPreparedInvocation, claim: ItemClaim<MediationLeaseReference>, admission: AuthorityAdmissionReference<Admission>, now: Date): EffectAttempt<MediationLeaseReference, Admission>;
    attemptAudit(invocation: MediationPreparedInvocation, attempt: EffectAttempt<MediationLeaseReference, Admission>): AuditRecord;
    /**
     * §7.4 gives the pre-effect variant two outcomes and they are different facts: a denial
     * before the effect and a cancellation before the effect derive different batch outcomes
     * (§7.5) and carry different Receipt ids. Only the admission point knows which one it
     * observed, so it states the outcome instead of leaving this factory to choose one.
     */
    preEffectReceipt(invocation: MediationPreparedInvocation, claim: ItemClaim<MediationLeaseReference>, outcome: PreEffectReceiptOutcome, recordedAt: Date, reason: string): PreEffectReceipt;
    attemptReceipt(attempt: EffectAttempt<MediationLeaseReference, Admission>, completion: AttemptCompletion, recordedAt: Date, result: ContentRef | undefined): AttemptReceipt;
    reconciledReceipt(attempt: EffectAttempt<MediationLeaseReference, Admission>, previous: AttemptReceipt, completion: AttemptCompletion, result: ContentRef | undefined, recordedAt: Date): AttemptReceipt;
    receiptAudit(invocation: MediationPreparedInvocation, cause: AuditRecord | undefined, receipt: Receipt): AuditRecord;
    receiptSupersessionAudit(invocation: MediationPreparedInvocation, previousAudit: AuditRecord, previous: AttemptReceipt, next: AttemptReceipt): AuditRecord;
    private owner;
    private audit;
}
