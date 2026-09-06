import type { ActorRef } from "../actors/index.js";
import { Digest, type ContentRef } from "../core/index.js";
import type { AuditAppendContext, AuditKind, AuditRecord } from "./audit.js";
import type { AuditRecordId, InvocationId } from "../interaction-references/index.js";
import type { ReceiptId } from "./id.js";
import type { EffectAttempt } from "./attempt.js";
import type { ItemClaim } from "./claim.js";
import type { StructuralCodec } from "./codec.js";
import type { PreparedInvocation } from "./prepared.js";
import type { InvocationPublicationOutbox } from "./publication.js";
import type { MediatedReplayRecord } from "./replay.js";
import type { AttemptFailureKind } from "./receipt.js";
export interface InvocationReferencePorts<Lease, Authority, Domain, PathEpochs, Admission> {
    readonly lease: StructuralCodec<Lease>;
    readonly authority: StructuralCodec<Authority>;
    readonly domain: StructuralCodec<Domain>;
    readonly pathEpochs: StructuralCodec<PathEpochs>;
    readonly admission: StructuralCodec<Admission>;
}
export declare class AuthorityAdmissionReference<Reference> {
    readonly digest: Digest;
    readonly reference: Reference;
    constructor(reference: Reference, digest: Digest);
}
export interface AuthorityAdmissionContext<Lease, Authority, Domain, PathEpochs> {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly ordinal: number;
    readonly lease: Lease | undefined;
    readonly authority: Authority;
    readonly domain: Domain;
    readonly pathEpochs: PathEpochs;
    readonly intentDigest: Digest;
    readonly itemKey: string;
}
export interface AuthorityAdmissionPort<Transaction, Lease, Authority, Domain, PathEpochs, Admission, Authentication = undefined> {
    admits(transaction: Transaction, admission: AuthorityAdmissionReference<Admission>, context: AuthorityAdmissionContext<Lease, Authority, Domain, PathEpochs>, authentication?: Authentication): boolean;
}
export interface InvocationPreparationPort<Transaction, Lease, Authority, Domain, PathEpochs> {
    admits(transaction: Transaction, invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>): boolean;
}
export interface InvocationTimePort<Transaction> {
    admits(transaction: Transaction, time: Date): boolean;
}
export interface InvocationClaimOwnerPort<Transaction, Lease, Admission> {
    admits(transaction: Transaction, claim: ItemClaim<Lease>, attempt: EffectAttempt<Lease, Admission>): boolean;
}
/**
 * What reconciliation learned about one attempt. A `failed` verdict names its §7.4 kind
 * because the superseding final Receipt must carry one, and the reconciler is the host seam
 * that observed the external system — the previous `indeterminate` Receipt could not name a
 * kind and nothing else in the chain is entitled to invent one.
 */
export type ReconciliationResult = {
    readonly kind: "unknown";
} | {
    readonly kind: "succeeded";
    readonly result?: ContentRef;
} | {
    readonly kind: "failed";
    readonly failure: AttemptFailureKind;
    readonly result?: ContentRef;
};
export interface EffectReconciliationPort<Lease, Admission> {
    query(attempt: EffectAttempt<Lease, Admission>, intentDigest: Digest): Promise<ReconciliationResult>;
}
export interface ReceiptObservation {
    readonly invocation: InvocationId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
}
export interface InvocationEventPort {
    publish(outboxId: Digest, observation: ReceiptObservation): Promise<void>;
}
export interface InvocationCommitPort {
    append(outboxId: Digest, observation: ReceiptObservation): Promise<void>;
}
export interface InvocationTransactionPort<Transaction> {
    transact<Result>(operation: (transaction: Transaction) => Result): Result;
}
export interface InvocationReplayPersistence<Transaction> {
    replay(transaction: Transaction, scope: string, requestKey: string): MediatedReplayRecord | undefined;
    replayById(transaction: Transaction, id: Digest): MediatedReplayRecord | undefined;
    appendReplay(transaction: Transaction, record: MediatedReplayRecord): void;
}
export interface InvocationAuditPersistence<Transaction> {
    audit(transaction: Transaction, id: AuditRecordId): AuditRecord | undefined;
    findAuditByEvidence(transaction: Transaction, actor: ActorRef, kind: AuditKind): AuditRecord | undefined;
    appendAudit(transaction: Transaction, record: AuditRecord, context?: AuditAppendContext): void;
}
export interface InvocationEvidencePersistence<Transaction> extends InvocationAuditPersistence<Transaction> {
    publication(transaction: Transaction, id: Digest): InvocationPublicationOutbox | undefined;
    pendingPublications(transaction: Transaction): readonly InvocationPublicationOutbox[];
    appendPublication(transaction: Transaction, record: InvocationPublicationOutbox): void;
}
