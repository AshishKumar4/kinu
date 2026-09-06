import type { ContentRef } from "../core/index.js";
import type { EffectAttempt } from "./attempt.js";
import { AuditRecord } from "./audit.js";
import type { EffectAttemptId } from "./id.js";
import type { InvocationLedger } from "./ledger.js";
import type { InvocationPersistence } from "./persistence.js";
import type { EffectReconciliationPort, InvocationEvidencePersistence, InvocationTransactionPort } from "./ports.js";
import type { PreparedInvocation } from "./prepared.js";
import { AttemptCompletion, AttemptReceipt } from "./receipt.js";
export interface InvocationReconciliationRecordPort<Lease, Authority, Domain, PathEpochs, Admission> {
    receiptAudit(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, cause: AuditRecord, receipt: AttemptReceipt): AuditRecord;
    reconciledReceipt(attempt: EffectAttempt<Lease, Admission>, previous: AttemptReceipt, completion: AttemptCompletion, result: ContentRef | undefined, recordedAt: Date): AttemptReceipt;
    receiptSupersessionAudit(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, previousAudit: AuditRecord, previous: AttemptReceipt, next: AttemptReceipt): AuditRecord;
}
export declare class InvocationReconciler<Transaction, Lease, Authority, Domain, PathEpochs, Admission> {
    private readonly transactions;
    private readonly persistence;
    private readonly ledger;
    private readonly provider;
    private readonly records;
    private readonly evidence;
    private readonly now;
    constructor(transactions: InvocationTransactionPort<Transaction>, persistence: InvocationPersistence<Transaction, Lease, Authority, Domain, PathEpochs, Admission>, ledger: InvocationLedger<Transaction, Lease, Authority, Domain, PathEpochs, Admission>, provider: EffectReconciliationPort<Lease, Admission>, records: InvocationReconciliationRecordPort<Lease, Authority, Domain, PathEpochs, Admission>, evidence: InvocationEvidencePersistence<Transaction>, now: () => Date);
    reconcile(attemptId: EffectAttemptId): Promise<AttemptReceipt | undefined>;
    private current;
    private supersession;
    private requireCompleteEvidence;
}
