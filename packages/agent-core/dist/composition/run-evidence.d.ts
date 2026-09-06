import { RunEvidencePort, RunMergePort, RunSourceRevisionPort, RunSpawnPort, SettlementEvidencePort, type AcceptanceId, type AcceptanceReceiptEvidence, type AbandonedRewriteEvidence, type ControlCommitEvidence, type AdministerControlEvidence, type DeliveryCommitEvidence, type ForcedCancellationEvidence, type ReceiptCommitEvidence, type RunCommit, type RunConfigurationSnapshot, type SettlementAuditObligation, type SpawnAttenuation, type SpawnReservation, type SynthesisCommitEvidence, type TurnAdmissionHandle } from "../agents/index.js";
import type { Receipt } from "../invocations/index.js";
import type { AuditRecordId, EventId, InvocationId, RouteReservationId } from "../interaction-references/index.js";
import type { ApprovalId, EffectAttemptId, ReceiptId } from "../invocation-references/index.js";
import type { TreeMergePolicy } from "../definition/index.js";
import type { RunCommitId } from "../execution-references/index.js";
export interface CanonicalRunEvidenceSource<Transaction> {
    receipt(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): ReceiptCommitEvidence | undefined;
    delivery(transaction: Transaction, reservation: RouteReservationId, audit: AuditRecordId): DeliveryCommitEvidence | undefined;
    control(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): ControlCommitEvidence | undefined;
    abandonedRewrite?(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): AbandonedRewriteEvidence | undefined;
    storedReceipt?(transaction: Transaction, receipt: ReceiptId): Receipt | undefined;
    publishedHandle?(transaction: Transaction, invocation: InvocationId, itemIndex: number, itemKey: string): TurnAdmissionHandle | undefined;
    synthesis(transaction: Transaction, receipt: ReceiptId): SynthesisCommitEvidence | undefined;
    administer?(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): AdministerControlEvidence | undefined;
    forcedCancellation?(transaction: Transaction, event: EventId, audit: AuditRecordId): ForcedCancellationEvidence | undefined;
    acceptance?(transaction: Transaction, receipt: ReceiptId): AcceptanceReceiptEvidence | undefined;
}
export declare class CanonicalRunEvidencePort<Transaction> extends RunEvidencePort<Transaction> {
    private readonly source;
    constructor(source: CanonicalRunEvidenceSource<Transaction>);
    receipt(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): ReceiptCommitEvidence | undefined;
    delivery(transaction: Transaction, reservation: RouteReservationId, audit: AuditRecordId): DeliveryCommitEvidence | undefined;
    control(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): ControlCommitEvidence | undefined;
    abandonedRewrite(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): AbandonedRewriteEvidence | undefined;
    storedReceipt(transaction: Transaction, receipt: ReceiptId): Receipt | undefined;
    publishedHandle(transaction: Transaction, invocation: InvocationId, itemIndex: number, itemKey: string): TurnAdmissionHandle | undefined;
    synthesis(transaction: Transaction, receipt: ReceiptId): SynthesisCommitEvidence | undefined;
    administer(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): AdministerControlEvidence | undefined;
    forcedCancellation(transaction: Transaction, event: EventId, audit: AuditRecordId): ForcedCancellationEvidence | undefined;
    acceptance(transaction: Transaction, receipt: ReceiptId): AcceptanceReceiptEvidence | undefined;
}
export interface CanonicalSettlementSource<Transaction> {
    approvalResolved(transaction: Transaction, approval: ApprovalId): boolean;
    invocationItemTerminal(transaction: Transaction, invocation: InvocationId, itemIndex: number, itemKey: string): boolean;
    routeTerminal(transaction: Transaction, route: RouteReservationId): boolean;
    reconciliationSuperseded(transaction: Transaction, attempt: EffectAttemptId): boolean;
    commitExists(transaction: Transaction, commit: RunCommitId): boolean;
    acceptanceSatisfied?(transaction: Transaction, acceptance: AcceptanceId): boolean;
    auditSatisfied(transaction: Transaction, obligation: SettlementAuditObligation): boolean;
}
export declare class CanonicalSettlementEvidencePort<Transaction> extends SettlementEvidencePort<Transaction> {
    private readonly source;
    constructor(source: CanonicalSettlementSource<Transaction>);
    approvalResolved(transaction: Transaction, approval: ApprovalId): boolean;
    invocationItemTerminal(transaction: Transaction, invocation: InvocationId, itemIndex: number, itemKey: string): boolean;
    routeTerminal(transaction: Transaction, route: RouteReservationId): boolean;
    reconciliationSuperseded(transaction: Transaction, attempt: EffectAttemptId): boolean;
    commitExists(transaction: Transaction, commit: RunCommitId): boolean;
    acceptanceSatisfied(transaction: Transaction, acceptance: AcceptanceId): boolean;
    auditSatisfied(transaction: Transaction, obligation: SettlementAuditObligation): boolean;
}
export interface CanonicalSpawnEvidenceSource<Transaction> {
    successfulDelegateReceipt(transaction: Transaction, reservation: SpawnReservation): boolean;
    durableAttenuation(transaction: Transaction, reservation: SpawnReservation): boolean;
    attenuation(transaction: Transaction, reservation: SpawnReservation): SpawnAttenuation;
}
export declare class CanonicalRunSpawnPort<Transaction> extends RunSpawnPort<Transaction> {
    private readonly source;
    constructor(source: CanonicalSpawnEvidenceSource<Transaction>);
    verify(transaction: Transaction, reservation: SpawnReservation): boolean;
    attenuation(transaction: Transaction, reservation: SpawnReservation): SpawnAttenuation;
}
export interface CanonicalMergeSource<Transaction> {
    concat(transaction: Transaction, commit: RunCommit, target: RunCommit, source: RunCommit): boolean;
    tree(transaction: Transaction, commit: RunCommit, target: RunCommit, source: RunCommit): boolean;
    /**
     * The `policies.treeMerge` the merge's own pinned PolicySet declares (SPEC §5.2.1). A
     * composition whose Blueprint declared none answers nothing, and the Run plane refuses
     * the merges that would have needed a side.
     */
    declaredTreeMerge(transaction: Transaction, commit: RunCommit): TreeMergePolicy | undefined;
}
export declare class CanonicalRunMergePort<Transaction> extends RunMergePort<Transaction> {
    private readonly source;
    constructor(source: CanonicalMergeSource<Transaction>);
    verifyConcat(transaction: Transaction, commit: RunCommit, target: RunCommit, source: RunCommit): boolean;
    verifyTree(transaction: Transaction, commit: RunCommit, target: RunCommit, source: RunCommit): boolean;
    declaredTreeMerge(transaction: Transaction, commit: RunCommit): TreeMergePolicy | undefined;
}
export interface CanonicalRunSource<Transaction> {
    verify(transaction: Transaction, snapshot: RunConfigurationSnapshot): boolean;
    verifyPackageClosure(transaction: Transaction, snapshot: RunConfigurationSnapshot): boolean;
}
export declare class CanonicalRunSourceRevisionPort<Transaction> extends RunSourceRevisionPort<Transaction, RunConfigurationSnapshot> {
    private readonly source;
    constructor(source: CanonicalRunSource<Transaction>);
    verify(transaction: Transaction, snapshot: RunConfigurationSnapshot): boolean;
    verifyPackageClosure(transaction: Transaction, snapshot: RunConfigurationSnapshot): boolean;
}
