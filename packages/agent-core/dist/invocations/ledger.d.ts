import type { Approval } from "./approval.js";
import type { EffectAttempt } from "./attempt.js";
import { AuditRecord } from "./audit.js";
import type { ItemClaim } from "./claim.js";
import type { ItemClaimId } from "./id.js";
import type { InvocationId } from "../interaction-references/index.js";
import { type BatchOutcome } from "./outcome.js";
import type { InvocationPersistence } from "./persistence.js";
import type { AuthorityAdmissionPort, InvocationAuditPersistence, InvocationClaimOwnerPort, InvocationEvidencePersistence, InvocationPreparationPort, InvocationTimePort } from "./ports.js";
import type { PreparedInvocation } from "./prepared.js";
import type { InvocationPublicationOutbox } from "./publication.js";
import { AttemptReceipt, PreEffectReceipt, type Receipt } from "./receipt.js";
export interface ReceiptSupersessionEvidence {
    readonly finalReceiptAudit: AuditRecord;
    readonly supersessionAudit: AuditRecord;
    readonly publication: InvocationPublicationOutbox;
}
import { type StructuralCodec } from "./codec.js";
export declare class InvocationLedger<Transaction, Lease, Authority, Domain, PathEpochs, Admission, Authentication = undefined> {
    private readonly persistence;
    private readonly lease;
    private readonly preparation;
    private readonly time;
    private readonly claimOwner;
    private readonly authorityAdmission;
    constructor(persistence: InvocationPersistence<Transaction, Lease, Authority, Domain, PathEpochs, Admission>, lease: StructuralCodec<Lease>, preparation: InvocationPreparationPort<Transaction, Lease, Authority, Domain, PathEpochs>, time: InvocationTimePort<Transaction>, claimOwner: InvocationClaimOwnerPort<Transaction, Lease, Admission>, authorityAdmission: AuthorityAdmissionPort<Transaction, Lease, Authority, Domain, PathEpochs, Admission, Authentication>);
    protected prepareUnchecked(transaction: Transaction, record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>): void;
    prepareWithAudit(transaction: Transaction, record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, audit: AuditRecord, evidence: InvocationAuditPersistence<Transaction>): void;
    requirePreparedAudit(transaction: Transaction, record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, audit: AuditRecord, evidence: InvocationAuditPersistence<Transaction>): void;
    requirePersistedAuditRelation(transaction: Transaction, audit: AuditRecord, evidence: InvocationAuditPersistence<Transaction>): void;
    private validatePreparation;
    private requirePreparationAuditBinding;
    private requirePersistedAudit;
    requestApproval(transaction: Transaction, approval: Approval): void;
    appendApprovalRevision(transaction: Transaction, next: Approval): void;
    claimItem(transaction: Transaction, claim: ItemClaim<Lease>, now: Date): void;
    recoverClaim(transaction: Transaction, previousId: ItemClaimId, replacement: ItemClaim<Lease>, now: Date): void;
    admitAttempt(transaction: Transaction, attempt: EffectAttempt<Lease, Admission>, now: Date, authentication?: Authentication): Approval | undefined;
    /**
     * `false` reports an AuthorityAdmission denial, the one refusal a caller may record as
     * evidence instead of raising. Every other refusal is a caller error and throws here.
     */
    private admitAttemptInternal;
    admitAttemptWithAudit(transaction: Transaction, attempt: EffectAttempt<Lease, Admission>, now: Date, audit: AuditRecord, evidence: InvocationEvidencePersistence<Transaction>, authentication?: Authentication): Approval | undefined;
    admitAttemptOrRecordAuthorityDenialWithAudit(transaction: Transaction, attempt: EffectAttempt<Lease, Admission>, now: Date, attemptAudit: AuditRecord, denial: {
        readonly claim: ItemClaim<Lease>;
        readonly receipt: PreEffectReceipt;
        readonly audit: AuditRecord;
        readonly publication: InvocationPublicationOutbox;
    }, evidence: InvocationEvidencePersistence<Transaction>, authentication?: Authentication): boolean;
    recordClaimedAuthorityDenialWithAudit(transaction: Transaction, claim: ItemClaim<Lease>, receipt: PreEffectReceipt, audit: AuditRecord, publication: InvocationPublicationOutbox, evidence: InvocationEvidencePersistence<Transaction>): void;
    /**
     * The other pre-effect outcome a claimed item can reach. §7.4 fixes an expiry,
     * cancellation, or loss of the required Turn before the effect as `cancelledPreEffect`
     * over an item with no EffectAttempt, and §5.6 puts that boundary exactly at admission.
     *
     * It is its own entry point rather than an outcome argument because the two are different
     * facts with different batch outcomes (§7.5), and a caller that could pass either could
     * pass the wrong one. The item's owner supplies the fact; the Receipt, its audit edge, and
     * its publication stay owned here.
     */
    recordClaimedCancellationWithAudit(transaction: Transaction, claim: ItemClaim<Lease>, receipt: PreEffectReceipt, audit: AuditRecord, publication: InvocationPublicationOutbox, evidence: InvocationEvidencePersistence<Transaction>): void;
    private recordClaimedPreEffectWithAudit;
    recordAttemptReceiptWithAudit(transaction: Transaction, receipt: AttemptReceipt, attemptAudit: AuditRecord, audit: AuditRecord, publication: InvocationPublicationOutbox, evidence: InvocationEvidencePersistence<Transaction>): void;
    private requireContinuation;
    recordPreEffect(transaction: Transaction, receipt: PreEffectReceipt): void;
    recordAttemptReceipt(transaction: Transaction, receipt: AttemptReceipt): void;
    protected supersedeReceiptUnchecked(transaction: Transaction, receipt: AttemptReceipt): void;
    supersedeReceiptWithAudit(transaction: Transaction, receipt: AttemptReceipt, supersession: ReceiptSupersessionEvidence, evidence: InvocationEvidencePersistence<Transaction>): void;
    currentReceipt(transaction: Transaction, invocation: InvocationId, itemIndex: number): Receipt | undefined;
    batchOutcome(transaction: Transaction, invocation: InvocationId): BatchOutcome | undefined;
    private requirePrepared;
    private requireItem;
    private currentUnattemptedClaim;
    private currentReceiptForAttempt;
    private retryOrdinal;
    private validateClaimOwner;
    private requireTime;
    private auditEvidence;
}
