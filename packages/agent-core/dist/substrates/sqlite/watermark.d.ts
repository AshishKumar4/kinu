import { InvalidationWatermark, type InvalidationWatermarkStore, type ScopeEpoch } from "../../authority/index.js";
import type { ActorRef } from "../../actors/index.js";
import type { TenantId } from "../../identity/index.js";
import { TransactionalSqlite } from "./sqlite.js";
export declare class SqliteInvalidationWatermarkStore implements InvalidationWatermarkStore {
    private readonly database;
    private readonly ownerTenant;
    private readonly owner;
    constructor(database: TransactionalSqlite, ownerTenant: TenantId, owner: ActorRef);
    load(key: string): InvalidationWatermark | undefined;
    save(watermark: InvalidationWatermark): void;
    loadInTransaction(transaction: TransactionalSqlite, key: string): InvalidationWatermark | undefined;
    saveInTransaction(transaction: TransactionalSqlite, watermark: InvalidationWatermark): void;
    joinInTransaction(transaction: TransactionalSqlite, key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark;
    private saveUsing;
    join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark;
    private loadUsing;
    private requireTransaction;
}
