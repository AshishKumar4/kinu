import { AuditRecordId, ClaimWorkerId, CorrelationId, EffectAttemptId, InvocationId, ItemClaimId, ReceiptId, type AttemptReceiptOutcome, type PreEffectReceiptOutcome } from "../invocations/index.js";
import type { MediatedInvocationIdentityPort } from "../invocations/index.js";
import type { MediatedInvocationPreflight } from "../operations/index.js";
import { type FacetData, type OperationDescriptor } from "../facets/index.js";
import type { OperationResolutionState } from "./authority.js";
export declare class DerivedMediationIdentities implements MediatedInvocationIdentityPort {
    private readonly scope;
    constructor(scope: string);
    /**
     * The mediated InvocationId commits exactly the replay reservation identity (§7.3):
     * the same authenticated caller and OperationRequestKey over the same bound intent
     * mint the same Invocation, and any changed bound field mints a different one.
     */
    invocation(request: MediatedInvocationPreflight<unknown>): InvocationId;
    /**
     * A direct Invocation creates no durable record (§7.3), but its Operation still runs
     * under an OperationContext that names one. Deriving it from the request key keeps
     * that identity stable across a retried direct dispatch and distinct from every
     * mediated Invocation, which is minted under a different domain.
     */
    directInvocation(requestKey: string): InvocationId;
    /**
     * The Invocation a stale mediated observation denies (§3.4 rule 7, §7.4). It is minted
     * under its own domain because the mediated `invocation` derivation is unreachable
     * here: a stale re-check throws before `replayBinding` exists, so the replay reservation
     * that identity commits to has not been formed yet. What HAS been formed is the exact
     * resolution the caller presented, and every field below is part of what made this
     * intent distinct — so two different stale operations never collide, and the same stale
     * observation retried after a crash recomputes the same Receipt and AuditRecord ids
     * instead of forking a second denial for one refusal.
     *
     * The Binding generation and the resolution's own path epochs are in the evidence
     * deliberately: they are the STALE values the caller presented, not the current ones,
     * which is what makes the identity name this refusal rather than the state that
     * replaced it.
     */
    staleDenialInvocation(resolution: OperationResolutionState, descriptor: OperationDescriptor, inputs: readonly FacetData[]): InvocationId;
    directItemKey(invocation: InvocationId, itemIndex: number): string;
    idempotencySeed(invocation: InvocationId): string;
    correlation(invocation: InvocationId): CorrelationId;
    claim(invocation: InvocationId, itemIndex: number, attemptOrdinal: number, worker: ClaimWorkerId): ItemClaimId;
    attempt(invocation: InvocationId, itemIndex: number, attemptOrdinal: number): EffectAttemptId;
    preEffectReceipt(invocation: InvocationId, itemIndex: number, outcome: PreEffectReceiptOutcome): ReceiptId;
    attemptReceipt(attempt: EffectAttemptId, outcome: AttemptReceiptOutcome): ReceiptId;
    invocationAudit(invocation: InvocationId): AuditRecordId;
    attemptAudit(attempt: EffectAttemptId): AuditRecordId;
    receiptAudit(receipt: ReceiptId): AuditRecordId;
    supersessionAudit(previous: ReceiptId, next: ReceiptId): AuditRecordId;
}
