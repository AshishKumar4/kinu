import type { ActorRef } from "../../actors/index.js";
import { ContentOwnerEdge, ContentRetention, TransientContentAccess, TransientContentLease, TransientContentLeaseState, type MediaHint, type TenantContentPolicyReader, type TransientContentBinding } from "../../content/index.js";
import { ContentRef } from "../../core/index.js";
import type { TenantId } from "../../identity/index.js";
import { TransactionalSqlite } from "./sqlite.js";
export declare class SqliteContentRetention extends ContentRetention<TransactionalSqlite> {
    private readonly database;
    constructor(database: TransactionalSqlite, tenant: TenantId, actor: ActorRef);
    retain(transaction: TransactionalSqlite, edge: ContentOwnerEdge, operationAtValue: Date): void;
    holds(transaction: TransactionalSqlite, ref: ContentRef): boolean;
    release(transaction: TransactionalSqlite, edge: ContentOwnerEdge, operationAtValue: Date): void;
    collect(transaction: TransactionalSqlite, policy: TenantContentPolicyReader<TransactionalSqlite>, observedAtValue: Date): readonly ContentRef[];
    protected listOwnerEdges(transaction: TransactionalSqlite): readonly ContentOwnerEdge[];
    protected requireTransaction(transaction: TransactionalSqlite): void;
}
export declare class SqliteTransientContentAccess extends TransientContentAccess {
    private readonly database;
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    private readonly now;
    constructor(database: TransactionalSqlite, tenant: TenantId, actor: ActorRef, now?: () => Date);
    acquire(binding: TransientContentBinding, bytes?: Uint8Array, hint?: MediaHint): Promise<TransientContentLease | undefined>;
    acquireInTransaction(transaction: TransactionalSqlite, binding: TransientContentBinding, operationAtValue: Date, bytes?: Uint8Array, hint?: MediaHint): TransientContentLease | undefined;
    readInTransaction(transaction: TransactionalSqlite, expected: TransientContentLeaseState): Uint8Array;
    matchesInTransaction(transaction: TransactionalSqlite, expected: TransientContentLeaseState, binding: TransientContentBinding, now: Date): boolean;
    closeInTransaction(transaction: TransactionalSqlite, expected: TransientContentLeaseState, operationAt: Date): void;
    private requireLease;
    private requireGeneration;
    private lease;
}
export declare function initializeSqliteContentOwner(database: TransactionalSqlite, tenant: TenantId, actor: ActorRef): void;
