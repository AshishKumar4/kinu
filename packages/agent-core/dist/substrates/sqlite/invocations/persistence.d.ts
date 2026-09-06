import { type ContentRetentionField, type RecordCodec } from "../../../core/index.js";
import type { ContentCustodyPort } from "../../../content/index.js";
import { TransactionalSqlite } from "../sqlite.js";
interface TextReference {
    readonly value: string;
}
export interface PreparedProjection {
    readonly id: string;
}
export interface ApprovalProjection {
    readonly id: string;
    readonly invocation: string;
    readonly revision: number;
    readonly phase: string;
}
export interface ClaimProjection {
    readonly id: string;
    readonly invocation: string;
    readonly itemIndex: number;
    readonly ordinal: number;
}
export interface AttemptProjection {
    readonly id: string;
    readonly invocation: string;
    readonly itemIndex: number;
    readonly ordinal: number;
    readonly claim: string;
}
export interface ContinuationProjection {
    readonly invocation: string;
}
export type ReceiptProjection = {
    readonly id: string;
    readonly variant: "preEffect";
    readonly invocation: string;
    readonly itemIndex: number;
    readonly outcome: string;
} | {
    readonly id: string;
    readonly variant: "attempt";
    readonly attempt: string;
    readonly previous?: string;
    readonly outcome: string;
};
export interface SqliteInvocationCodecs<Prepared, Approval, Claim, Attempt, Receipt, Continuation> {
    readonly prepared: RecordCodec<Prepared>;
    readonly approval: RecordCodec<Approval>;
    readonly claim: RecordCodec<Claim>;
    readonly attempt: RecordCodec<Attempt>;
    readonly receipt: RecordCodec<Receipt>;
    readonly continuation: RecordCodec<Continuation>;
    projectPrepared(record: Prepared): PreparedProjection;
    projectApproval(record: Approval): ApprovalProjection;
    projectClaim(record: Claim): ClaimProjection;
    projectAttempt(record: Attempt): AttemptProjection;
    projectReceipt(record: Receipt): ReceiptProjection;
    projectContinuation(record: Continuation): ContinuationProjection;
    /** The ContentRefs a Receipt names, projected for §8.4 retention on append. */
    projectReceiptContent(record: Receipt): readonly ContentRetentionField[];
}
export declare class SqliteInvocationPersistence<Prepared, Approval, Claim, Attempt, Receipt, Continuation> {
    private readonly codecs;
    private readonly custody;
    constructor(database: TransactionalSqlite, codecs: SqliteInvocationCodecs<Prepared, Approval, Claim, Attempt, Receipt, Continuation>, custody: ContentCustodyPort<TransactionalSqlite>);
    prepared(transaction: TransactionalSqlite, id: TextReference): Prepared | undefined;
    insertPrepared(transaction: TransactionalSqlite, record: Prepared): void;
    approval(transaction: TransactionalSqlite, id: TextReference): Approval | undefined;
    approvalForInvocation(transaction: TransactionalSqlite, invocation: TextReference): Approval | undefined;
    approvalRevision(transaction: TransactionalSqlite, id: TextReference, revision: number): Approval | undefined;
    appendApproval(transaction: TransactionalSqlite, record: Approval): void;
    continuation(transaction: TransactionalSqlite, invocation: TextReference): Continuation | undefined;
    insertContinuation(transaction: TransactionalSqlite, record: Continuation): void;
    claim(transaction: TransactionalSqlite, id: TextReference): Claim | undefined;
    claimsForItem(transaction: TransactionalSqlite, invocation: TextReference, itemIndex: number): readonly Claim[];
    appendClaim(transaction: TransactionalSqlite, record: Claim): void;
    attempt(transaction: TransactionalSqlite, id: TextReference): Attempt | undefined;
    attemptForClaim(transaction: TransactionalSqlite, claim: TextReference): Attempt | undefined;
    attemptsForItem(transaction: TransactionalSqlite, invocation: TextReference, itemIndex: number): readonly Attempt[];
    appendAttempt(transaction: TransactionalSqlite, record: Attempt): void;
    receipt(transaction: TransactionalSqlite, id: TextReference): Receipt | undefined;
    receiptsForItem(transaction: TransactionalSqlite, invocation: TextReference, itemIndex: number): readonly Receipt[];
    receiptsForAttempt(transaction: TransactionalSqlite, attempt: TextReference): readonly Receipt[];
    /**
     * §8.4: the result bytes an attempt produced are retained in the same transaction that
     * appends the Receipt naming them. An audited Receipt is append-only, so this store owes
     * retention on write and never a release.
     */
    appendReceipt(transaction: TransactionalSqlite, record: Receipt): void;
    private decodeApproval;
    private decodeClaim;
    private decodeAttempt;
    private decodeReceipt;
    private one;
}
export {};
