import type { ActorKind, ActorRef } from "../actors/index.js";
import type { TenantId } from "../identity/index.js";
import { AuditRecord, type AuditAppendContext, type AuditKind, type AuditRecordId, type WriteRecordId } from "../invocations/index.js";
import type { CommandIdentity, ProtocolPersistence } from "./dispatcher.js";
import { WriteRecord, type CommandOutcome } from "./write.js";
export type ProtocolCallerProjection = {
    readonly kind: "principal";
    readonly tenantId: TenantId;
    readonly id: string;
} | {
    readonly kind: "actor";
    readonly actorKind: ActorKind;
    readonly id: string;
};
export interface ProtocolIdentityProjection {
    readonly caller: ProtocolCallerProjection;
    readonly idempotencyKey: string;
}
export interface ProtocolWriteIdentityProjection {
    readonly writeId: WriteRecordId;
    readonly identity: ProtocolIdentityProjection;
}
export interface StoredProtocolAudit {
    readonly id: string;
    readonly evidenceIdentity: string;
    readonly evidenceKind: AuditKind["kind"];
    readonly writeId?: WriteRecordId;
    readonly writeOutcome?: CommandOutcome;
    readonly bytes: Uint8Array;
}
export interface StoredProtocolWrite {
    readonly id: string;
    readonly auditId: AuditRecordId;
    readonly outcome: CommandOutcome;
    readonly bytes: Uint8Array;
}
export declare abstract class ProtocolRecordStorage {
    abstract findAudit(id: string): StoredProtocolAudit | undefined;
    abstract findAuditByEvidence(identity: string): StoredProtocolAudit | undefined;
    abstract findWrite(id: string): StoredProtocolWrite | undefined;
    abstract scanAudits(): readonly StoredProtocolAudit[];
    abstract scanWrites(): readonly StoredProtocolWrite[];
    abstract insertAudit(record: StoredProtocolAudit): void;
    abstract insertWrite(record: StoredProtocolWrite, identity: ProtocolIdentityProjection | undefined): void;
    abstract synchronizeIdentityProjection(entries: readonly ProtocolWriteIdentityProjection[]): void;
}
export declare abstract class ProtocolPersistenceAdapter<Transaction> implements ProtocolPersistence<Transaction> {
    protected abstract storage(transaction: Transaction): ProtocolRecordStorage;
    repair(transaction: Transaction): void;
    findWrite(transaction: Transaction, identity: CommandIdentity): WriteRecord | undefined;
    findWriteById(transaction: Transaction, id: WriteRecordId): WriteRecord | undefined;
    findAudit(transaction: Transaction, id: AuditRecordId): AuditRecord | undefined;
    findAuditByEvidence(transaction: Transaction, actor: ActorRef, kind: AuditKind): AuditRecord | undefined;
    appendAudit(transaction: Transaction, record: AuditRecord, context?: AuditAppendContext): void;
    appendWrite(transaction: Transaction, record: WriteRecord): void;
    private validateDuplicate;
    private validateStoredDuplicate;
    private originalIdentityEntries;
    private validateStoredGraph;
    private loadAudit;
    private decodeStoredAudit;
    private loadWrite;
    private decodeStoredWrite;
    private requireReciprocalAudit;
    private validateStoredWriteAuditCause;
}
export declare function protocolIdentityProjection(identity: CommandIdentity): ProtocolIdentityProjection;
export declare function protocolIdentityProjectionsEqual(left: ProtocolIdentityProjection, right: ProtocolIdentityProjection): boolean;
