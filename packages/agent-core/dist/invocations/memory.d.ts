import type { Approval } from "./approval.js";
import type { EffectAttempt } from "./attempt.js";
import type { ItemClaim } from "./claim.js";
import type { InvocationContinuation } from "./continuation.js";
import { ApprovalId, EffectAttemptId, ItemClaimId, ReceiptId } from "./id.js";
import { InvocationId } from "../interaction-references/index.js";
import type { InvocationPersistence } from "./persistence.js";
import type { PreparedInvocation } from "./prepared.js";
import { type Receipt } from "./receipt.js";
import { type RecordCodec } from "../core/index.js";
import type { ContentCustodyPort } from "../content/index.js";
export interface InvocationMemoryState {
    readonly prepared: Map<string, Uint8Array>;
    readonly approvals: Map<string, Uint8Array>;
    readonly approvalByInvocation: Map<string, string>;
    readonly continuations: Map<string, Uint8Array>;
    readonly claims: Map<string, Uint8Array>;
    readonly claimOrder: string[];
    readonly attempts: Map<string, Uint8Array>;
    readonly attemptByClaim: Map<string, string>;
    readonly receipts: Map<string, Uint8Array>;
    readonly receiptOrder: string[];
}
export interface InvocationMemoryCodecs<Lease, Authority, Domain, PathEpochs, Admission> {
    readonly prepared: RecordCodec<PreparedInvocation<Lease, Authority, Domain, PathEpochs>>;
    readonly approval: RecordCodec<Approval>;
    readonly continuation: RecordCodec<InvocationContinuation<Lease>>;
    readonly claim: RecordCodec<ItemClaim<Lease>>;
    readonly attempt: RecordCodec<EffectAttempt<Lease, Admission>>;
    readonly receipt: RecordCodec<Receipt>;
}
export declare function createInvocationMemoryState(): InvocationMemoryState;
export declare function cloneInvocationMemoryState(state: InvocationMemoryState): InvocationMemoryState;
export declare class MemoryInvocationPersistence<Lease, Authority, Domain, PathEpochs, Admission> implements InvocationPersistence<InvocationMemoryState, Lease, Authority, Domain, PathEpochs, Admission> {
    private readonly codecs;
    private readonly custody;
    constructor(codecs: InvocationMemoryCodecs<Lease, Authority, Domain, PathEpochs, Admission>, custody: ContentCustodyPort<InvocationMemoryState>);
    prepared(transaction: InvocationMemoryState, id: InvocationId): PreparedInvocation<Lease, Authority, Domain, PathEpochs> | undefined;
    insertPrepared(transaction: InvocationMemoryState, record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>): void;
    /**
     * The reference target index: the memory store holds one map of prepared records, so the
     * index is derived by reading their headers rather than kept beside them (§8.4 rule 2).
     */
    preparedForTarget(transaction: InvocationMemoryState, target: string): readonly InvocationId[];
    approval(transaction: InvocationMemoryState, id: ApprovalId): Approval | undefined;
    approvalForInvocation(transaction: InvocationMemoryState, invocation: InvocationId): Approval | undefined;
    approvalRevision(transaction: InvocationMemoryState, id: ApprovalId, revision: number): Approval | undefined;
    appendApproval(transaction: InvocationMemoryState, record: Approval): void;
    continuation(transaction: InvocationMemoryState, invocation: InvocationId): InvocationContinuation<Lease> | undefined;
    insertContinuation(transaction: InvocationMemoryState, record: InvocationContinuation<Lease>): void;
    claim(transaction: InvocationMemoryState, id: ItemClaimId): ItemClaim<Lease> | undefined;
    claimsForItem(transaction: InvocationMemoryState, invocation: InvocationId, itemIndex: number): readonly ItemClaim<Lease>[];
    appendClaim(transaction: InvocationMemoryState, record: ItemClaim<Lease>): void;
    attempt(transaction: InvocationMemoryState, id: EffectAttemptId): EffectAttempt<Lease, Admission> | undefined;
    attemptForClaim(transaction: InvocationMemoryState, claim: ItemClaimId): EffectAttempt<Lease, Admission> | undefined;
    attemptsForItem(transaction: InvocationMemoryState, invocation: InvocationId, itemIndex: number): readonly EffectAttempt<Lease, Admission>[];
    appendAttempt(transaction: InvocationMemoryState, record: EffectAttempt<Lease, Admission>): void;
    receipt(transaction: InvocationMemoryState, id: ReceiptId): Receipt | undefined;
    receiptsForItem(transaction: InvocationMemoryState, invocation: InvocationId, itemIndex: number): readonly Receipt[];
    receiptsForAttempt(transaction: InvocationMemoryState, attempt: EffectAttemptId): readonly Receipt[];
    /**
     * §8.4: the Receipt's own result bytes are retained in the transaction that appends it.
     * An audited Receipt is append-only, so this store never releases what it retained here.
     */
    appendReceipt(transaction: InvocationMemoryState, record: Receipt): void;
}
