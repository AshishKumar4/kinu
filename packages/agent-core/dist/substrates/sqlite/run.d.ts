import { type ActorRef } from "../../actors/index.js";
import { RunStoragePort, type RunRecordKind, type RunTransaction, type StoredRunParent, type StoredRunRecord } from "../../agents/index.js";
import type { TenantId } from "../../identity/index.js";
import { TransactionalSqlite } from "./sqlite.js";
export type SqliteRunRecordKind = RunRecordKind;
export type SqliteStoredRunRecord = StoredRunRecord;
export type SqliteStoredRunParent = StoredRunParent;
export declare class SqliteRunStorage extends RunStoragePort<RunTransaction> {
    constructor(database: TransactionalSqlite, tenant: TenantId, owner: ActorRef, now?: () => Date, recordConstraint?: (record: SqliteStoredRunRecord) => void);
}
