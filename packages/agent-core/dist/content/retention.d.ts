import { ActorRef } from "../actors/index.js";
import { ContentRef, type ContentRetentionField, RecordCodec } from "../core/index.js";
import { TenantId } from "../identity/index.js";
import type { ContentStat } from "./stat.js";
export declare class ContentOwnerEdge {
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly ownerKey: string;
    readonly ref: ContentRef;
    static get codec(): RecordCodec<ContentOwnerEdge>;
    constructor(tenant: TenantId, actor: ActorRef, ownerKey: string, ref: ContentRef);
    static encode(edge: ContentOwnerEdge): Uint8Array;
    static decode(bytes: Uint8Array): ContentOwnerEdge;
    equals(other: ContentOwnerEdge): boolean;
}
/**
 * The namespace one record kind's owner keys share. A store verifies its whole custody
 * against exactly the namespaces of the kinds it owns, and the encoded tuple below always
 * begins with the kind, so this prefix reaches every key of one kind and no key of another.
 */
export declare function contentOwnerNamespace(kind: string): string;
/**
 * The owner key one durable record's field holds its ContentRef under. It is the repo's
 * injective composite-key idiom — one canonical JSON tuple of the kind, the record's own
 * key, and the field — so no record identity or field name can collide with another's key
 * by containing a separator, and one Actor's record families stay distinct inside the
 * single custody namespace §8.4 gives it.
 *
 * The format changed once, from a hand-built `record:<kind>:<len>:<key>:<field>`
 * concatenation to this tuple encoding, inside the same wave that introduced it and before
 * any durable store shipped an owner edge written under the old shape. No migration is owed:
 * the two builds never meet over one stored set, and the §8.3 declaration gate refuses the
 * older build's records on activation rather than decoding them.
 */
export declare function contentOwnerKey(kind: string, key: string, field: string): string;
/**
 * A durable record as the custody plane sees it: its wire kind, the identity its store
 * keys it under, and the ContentRefs its fields name right now.
 */
export interface RetainedContentRecord {
    readonly kind: string;
    readonly key: string;
    readonly fields: readonly ContentRetentionField[];
}
/**
 * The seam a record store calls on every durable write of a content-bearing record. It is
 * deliberately narrower than `ContentRetention`: a store registers and releases the records
 * it owns and never collects, and it names records rather than owner edges, so the Tenant,
 * the Actor and the owner key stay the custody plane's to decide.
 */
export interface ContentCustodyPort<Transaction> {
    /**
     * Registers every ContentRef `record` names and releases every one the stored record
     * named before and no longer does, inside the writer's own transaction.
     */
    retain(transaction: Transaction, record: RetainedContentRecord, previous?: RetainedContentRecord): void;
    /** Releases every ContentRef `record` names, for a removal path that drops the record. */
    release(transaction: Transaction, record: RetainedContentRecord): void;
}
/**
 * The one implementation of that seam: it derives each record's owner edges and reconciles
 * them through a `ContentRetention`, so a store's write path and the collection sweep read
 * the same custody state. Retention is idempotent, so re-registering an unchanged record is
 * a no-op rather than a conflict, and a field whose ContentRef moved releases the old edge
 * before it retains the new one — the swap the §8.4 custody contract requires.
 */
export declare class ContentRecordCustody<Transaction> implements ContentCustodyPort<Transaction> {
    private readonly retention;
    private readonly now;
    constructor(retention: ContentRetention<Transaction>, now?: () => Date);
    retain(transaction: Transaction, record: RetainedContentRecord, previous?: RetainedContentRecord): void;
    release(transaction: Transaction, record: RetainedContentRecord): void;
    private edges;
    private operationTime;
}
export interface ContentCollectionCandidate {
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly stat: ContentStat;
    readonly unownedSince: Date;
    readonly observedAt: Date;
}
export interface TenantContentPolicyReader<TTransaction> {
    allowsCollection(transaction: TTransaction, candidate: ContentCollectionCandidate): boolean | undefined;
}
export declare abstract class ContentRetention<TTransaction> {
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    protected constructor(tenant: TenantId, actor: ActorRef);
    abstract retain(transaction: TTransaction, edge: ContentOwnerEdge, operationAt: Date): void;
    abstract release(transaction: TTransaction, edge: ContentOwnerEdge, operationAt: Date): void;
    /**
     * Whether this Actor's content plane holds the bytes `ref` names, read inside the
     * caller's own transaction. A record may name only content its Actor already holds, and
     * `retain` refuses the rest; this is the same question asked before the record is built,
     * so a write path can reject with its own protocol error instead of a custody fault.
     */
    abstract holds(transaction: TTransaction, ref: ContentRef): boolean;
    abstract collect(transaction: TTransaction, policy: TenantContentPolicyReader<TTransaction>, observedAt: Date): readonly ContentRef[];
    verifyExactNamespace(transaction: TTransaction, ownerKeyPrefixes: readonly string[], expected: readonly ContentOwnerEdge[]): void;
    protected abstract listOwnerEdges(transaction: TTransaction): readonly ContentOwnerEdge[];
    protected requireOwner(edge: ContentOwnerEdge): void;
}
export declare function requireCollectionTime(value: Date): Date;
export declare function requireOperationTime(value: Date, name?: string): Date;
