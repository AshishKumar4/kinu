import { ActorRef, type SynchronousResultGuard } from "../actors/index.js";
import { ContentRef } from "../core/index.js";
import { TenantId } from "../identity/index.js";
import { MediaHint } from "./media.js";
import { ByteRange } from "./range.js";
import { ContentOwnerEdge, ContentRetention, type TenantContentPolicyReader } from "./retention.js";
import { ContentStat } from "./stat.js";
import { ContentStore, type ContentPutResult } from "./store.js";
import { TransientContentAccess, TransientContentLease, TransientContentLeaseState, type TransientContentBinding } from "./transient.js";
export interface MemoryContentSnapshot {
    readonly version: 1;
    readonly binding: {
        readonly tenant: string;
        readonly actor: {
            readonly kind: ActorRef["kind"];
            readonly id: string;
        };
    } | null;
    readonly content: readonly {
        readonly ref: string;
        readonly digest: string;
        readonly bytes: Uint8Array;
        readonly mediaType: string | null;
    }[];
    readonly edges: readonly Uint8Array[];
    readonly relations: readonly {
        readonly ref: string;
        readonly unownedSince: number | null;
    }[];
    readonly leases: readonly Uint8Array[];
}
export type MemoryContentRetentionSnapshot = MemoryContentSnapshot;
export declare class MemoryContentRetentionState {
    constructor(tenant: TenantId, actor: ActorRef);
    static restore(tenant: TenantId, actor: ActorRef, snapshot: MemoryContentSnapshot): MemoryContentRetentionState;
    snapshot(): MemoryContentSnapshot;
    clone(): MemoryContentRetentionState;
}
export declare class MemoryContentStore extends ContentStore {
    constructor(snapshot?: MemoryContentSnapshot);
    static restore(snapshot: MemoryContentSnapshot): MemoryContentStore;
    retention(tenant: TenantId, actor: ActorRef): MemoryContentRetention;
    transient(tenant: TenantId, actor: ActorRef, now?: () => Date): MemoryTransientContentAccess;
    transaction<Result>(operation: (transaction: MemoryContentRetentionState) => Result, ..._guard: SynchronousResultGuard<Result>): Result;
    snapshot(): MemoryContentSnapshot;
    put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult>;
    get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array>;
    stat(ref: ContentRef): Promise<ContentStat | undefined>;
}
export declare class MemoryContentRetention extends ContentRetention<MemoryContentRetentionState> {
    private readonly owner;
    constructor(owner: MemoryContentStore, tenant: TenantId, actor: ActorRef);
    retain(transaction: MemoryContentRetentionState, edge: ContentOwnerEdge, operationAtValue: Date): void;
    holds(transaction: MemoryContentRetentionState, ref: ContentRef): boolean;
    release(transaction: MemoryContentRetentionState, edge: ContentOwnerEdge, operationAtValue: Date): void;
    collect(transaction: MemoryContentRetentionState, policy: TenantContentPolicyReader<MemoryContentRetentionState>, observedAtValue: Date): readonly ContentRef[];
    protected listOwnerEdges(transaction: MemoryContentRetentionState): readonly ContentOwnerEdge[];
    private requireState;
}
export declare class MemoryTransientContentAccess extends TransientContentAccess {
    private readonly store;
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    private readonly now;
    constructor(store: MemoryContentStore, tenant: TenantId, actor: ActorRef, now?: () => Date);
    acquire(binding: TransientContentBinding, bytes?: Uint8Array, hint?: MediaHint): Promise<TransientContentLease | undefined>;
    acquireInTransaction(transaction: MemoryContentRetentionState, binding: TransientContentBinding, operationAtValue: Date, bytes?: Uint8Array, hint?: MediaHint): TransientContentLease | undefined;
    readInTransaction(transaction: MemoryContentRetentionState, expected: TransientContentLeaseState): Uint8Array;
    matchesInTransaction(transaction: MemoryContentRetentionState, expected: TransientContentLeaseState, binding: TransientContentBinding, now: Date): boolean;
    closeInTransaction(transaction: MemoryContentRetentionState, expected: TransientContentLeaseState, operationAt: Date): void;
    private loadLease;
    private requireGeneration;
    private lease;
    private requireState;
    private requireLeaseBinding;
}
