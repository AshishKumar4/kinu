import { ACTOR_STATE_SNAPSHOT, type ActorCloneOwnedState } from "../actors/index.js";
import { ProtocolPersistenceAdapter, ProtocolRecordStorage, type ProtocolIdentityProjection, type ProtocolWriteIdentityProjection, type StoredProtocolAudit, type StoredProtocolWrite } from "./persistence.js";
export interface MemoryProtocolSnapshot {
    readonly audits: readonly StoredProtocolAudit[];
    readonly writes: readonly StoredProtocolWrite[];
    readonly identities: readonly ProtocolWriteIdentityProjection[];
}
export declare class MemoryProtocolRecords extends ProtocolRecordStorage implements ActorCloneOwnedState {
    #private;
    constructor(snapshot?: MemoryProtocolSnapshot);
    findAudit(id: string): StoredProtocolAudit | undefined;
    findAuditByEvidence(identity: string): StoredProtocolAudit | undefined;
    findWrite(id: string): StoredProtocolWrite | undefined;
    scanAudits(): readonly StoredProtocolAudit[];
    scanWrites(): readonly StoredProtocolWrite[];
    insertAudit(record: StoredProtocolAudit): void;
    insertWrite(record: StoredProtocolWrite, _identity: ProtocolIdentityProjection | undefined): void;
    synchronizeIdentityProjection(_entries: readonly ProtocolWriteIdentityProjection[]): void;
    clone(): MemoryProtocolRecords;
    snapshot(): MemoryProtocolSnapshot;
    [ACTOR_STATE_SNAPSHOT](): MemoryProtocolSnapshot;
}
export declare class MemoryProtocolPersistence<Transaction> extends ProtocolPersistenceAdapter<Transaction> {
    private readonly records;
    constructor(records: (transaction: Transaction) => MemoryProtocolRecords);
    protected storage(transaction: Transaction): ProtocolRecordStorage;
}
