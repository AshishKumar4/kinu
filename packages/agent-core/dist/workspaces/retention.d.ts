import { ActorRef } from "../actors/index.js";
import { ContentRef, Digest, RecordCodec } from "../core/index.js";
import { ContentRetention } from "../content/index.js";
import { TenantId } from "../identity/index.js";
import { ContentRetentionId, RetainedRecordRef } from "./id.js";
export declare abstract class RetainedRecordKind {
    static event(): RetainedRecordKind;
    static routeReservation(): RetainedRecordKind;
    static routeProjection(): RetainedRecordKind;
    static view(): RetainedRecordKind;
    static viewDelta(): RetainedRecordKind;
    abstract readonly kind: "event" | "routeReservation" | "routeProjection" | "view" | "viewDelta";
    equals(other: RetainedRecordKind): boolean;
}
export interface ContentRetentionReferenceInit {
    readonly id: ContentRetentionId;
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly recordKind: RetainedRecordKind;
    readonly record: RetainedRecordRef;
    readonly content: ContentRef;
    readonly digest: Digest;
}
export declare class ContentRetentionReference {
    static get codec(): RecordCodec<ContentRetentionReference>;
    static encode(reference: ContentRetentionReference): Uint8Array;
    static decode(bytes: Uint8Array): ContentRetentionReference;
    readonly init: ContentRetentionReferenceInit;
    constructor(init: ContentRetentionReferenceInit);
    get id(): ContentRetentionId;
    get tenant(): TenantId;
    get actor(): ActorRef;
    get recordKind(): RetainedRecordKind;
    get record(): RetainedRecordRef;
    get content(): ContentRef;
    get digest(): Digest;
}
/**
 * The workspaces plane's window onto content custody (§8.4). `verify` asks whether the
 * named bytes are durably present before a record may name them; `retain` registers the
 * owner edge for the record that now names them, inside the same transaction as that
 * record; `release` drops the edge when the naming record is retired; `discard` reclaims
 * bytes a rejected write left behind.
 */
export interface ContentRetentionPort<Transaction> {
    verify(transaction: Transaction, reference: ContentRetentionReference): boolean;
    retain(transaction: Transaction, reference: ContentRetentionReference): void;
    release(transaction: Transaction, reference: ContentRetentionReference): void;
    discard(reference: ContentRetentionReference): void;
}
/**
 * The one implementation of that port over the §8.4 seam: the retained reference names its
 * own record kind and identity, so its owner key is the same shape every other plane's
 * custody derives, and the retention it writes is the retention the collection sweep reads.
 */
export declare class WorkspaceContentRetention<Transaction> implements ContentRetentionPort<Transaction> {
    private readonly retention;
    private readonly now;
    constructor(retention: ContentRetention<Transaction>, now?: () => Date);
    verify(transaction: Transaction, reference: ContentRetentionReference): boolean;
    retain(transaction: Transaction, reference: ContentRetentionReference): void;
    release(transaction: Transaction, reference: ContentRetentionReference): void;
    discard(_reference: ContentRetentionReference): void;
    private edge;
    private operationTime;
}
