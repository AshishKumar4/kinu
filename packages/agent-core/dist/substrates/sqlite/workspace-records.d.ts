import { TransactionalSqlite } from "./sqlite.js";
import { type DeletableWorkspaceRecordKind, type WorkspaceRecordKind } from "../../workspaces/index.js";
interface StoredWorkspaceRecord {
    readonly kind: WorkspaceRecordKind;
    readonly id: string;
    readonly bytes: Uint8Array;
}
interface StoredWorkspaceUnique {
    readonly namespace: string;
    readonly key: string;
    readonly recordKey: string;
}
interface StoredWorkspacePointer {
    readonly namespace: string;
    readonly key: string;
    readonly recordKey: string;
}
export declare class SqliteWorkspaceRecords {
    private readonly database;
    constructor(database: TransactionalSqlite);
    findRecord(kind: WorkspaceRecordKind, id: string): StoredWorkspaceRecord | undefined;
    listRecords(kind: WorkspaceRecordKind): readonly StoredWorkspaceRecord[];
    insertRecord(record: StoredWorkspaceRecord): void;
    deleteRecords(kind: DeletableWorkspaceRecordKind, ids: readonly string[]): void;
    findUnique(namespace: string, key: string): StoredWorkspaceUnique | undefined;
    insertUnique(unique: StoredWorkspaceUnique): void;
    findPointer(namespace: string, key: string): StoredWorkspacePointer | undefined;
    compareAndSetPointer(pointer: StoredWorkspacePointer, expectedRecordKey: string | undefined): void;
    deletePointer(namespace: string, key: string, expectedRecordKey: string): void;
    private requireSchema;
}
export {};
