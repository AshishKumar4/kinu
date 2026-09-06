import type { ActorRef } from "../../actors/index.js";
import { ByteRange, ContentStat, ContentStore, MediaHint, type ContentPutResult } from "../../content/index.js";
import { ContentRef, Digest } from "../../core/index.js";
import type { TenantId } from "../../identity/index.js";
import { SqliteContentRetention, SqliteTransientContentAccess } from "./content-retention.js";
import { type SqliteRow, TransactionalSqlite } from "./sqlite.js";
export interface StoredSqliteContent {
    readonly ref: ContentRef;
    readonly digest: Digest;
    readonly bytes: Uint8Array;
    readonly hint: MediaHint | undefined;
    readonly size: number;
}
export declare class SqliteContentStore extends ContentStore {
    private readonly database;
    static initializeOwner(database: TransactionalSqlite, tenant: TenantId, actor: ActorRef): void;
    constructor(database: TransactionalSqlite);
    retention(tenant: TenantId, actor: ActorRef): SqliteContentRetention;
    transient(tenant: TenantId, actor: ActorRef, now?: () => Date): SqliteTransientContentAccess;
    put(bytesValue: Uint8Array, hint?: MediaHint): Promise<ContentPutResult>;
    get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array>;
    stat(ref: ContentRef): Promise<ContentStat | undefined>;
}
export declare function initializeSqliteContent(database: TransactionalSqlite): void;
export declare function loadSqliteContent(database: TransactionalSqlite, ref: ContentRef): StoredSqliteContent | undefined;
export declare function listSqliteContent(database: TransactionalSqlite): readonly StoredSqliteContent[];
export declare function deleteSqliteContent(database: TransactionalSqlite, ref: ContentRef): void;
export declare function sqliteContentStat(content: StoredSqliteContent): ContentStat;
export declare function insertSqliteContent(database: TransactionalSqlite, ref: ContentRef, digest: Digest, contentBytes: Uint8Array, hint?: MediaHint): void;
export declare function sqliteBytes(row: SqliteRow, column: string): Uint8Array;
export declare function sqliteText(row: SqliteRow, column: string): string;
export declare function sqliteInteger(row: SqliteRow, column: string): number;
