import { ACTOR_STATE_SNAPSHOT, type ActorCloneOwnedState } from "../actors/index.js";
import { type StoredWorkspacePointer, type StoredWorkspaceRecord, type StoredWorkspaceUnique, type DeletableWorkspaceRecordKind, type WorkspaceRecordKind, type WorkspaceRecordStorage } from "./persistence.js";
export interface MemoryWorkspaceSnapshot {
    readonly version: 1;
    readonly records: readonly StoredWorkspaceRecord[];
    readonly uniques: readonly StoredWorkspaceUnique[];
    readonly pointers: readonly StoredWorkspacePointer[];
}
export declare class MemoryWorkspaceRecords implements WorkspaceRecordStorage, ActorCloneOwnedState {
    #private;
    constructor(snapshot?: MemoryWorkspaceSnapshot);
    findRecord(kind: WorkspaceRecordKind, id: string): StoredWorkspaceRecord | undefined;
    listRecords(kind: WorkspaceRecordKind): readonly StoredWorkspaceRecord[];
    insertRecord(record: StoredWorkspaceRecord): void;
    deleteRecords(kind: DeletableWorkspaceRecordKind, ids: readonly string[]): void;
    findUnique(namespace: string, key: string): StoredWorkspaceUnique | undefined;
    insertUnique(unique: StoredWorkspaceUnique): void;
    findPointer(namespace: string, key: string): StoredWorkspacePointer | undefined;
    compareAndSetPointer(pointer: StoredWorkspacePointer, expectedRecordKey: string | undefined): void;
    deletePointer(namespace: string, key: string, expectedRecordKey: string): void;
    snapshot(): MemoryWorkspaceSnapshot;
    clone(): MemoryWorkspaceRecords;
    [ACTOR_STATE_SNAPSHOT](): MemoryWorkspaceSnapshot;
}
