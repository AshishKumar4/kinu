import { Digest } from "../../../core/index.js";
import type { ActorRef } from "../../../actors/index.js";
import { AuditRecord, InvocationPublicationOutbox, MediatedReplayRecord, type AuditAppendContext, type AuditKind, type InvocationEvidencePersistence, type InvocationReplayPersistence } from "../../../invocations/index.js";
import type { AuditRecordId } from "../../../interaction-references/index.js";
import { TransactionalSqlite } from "../sqlite.js";
export interface SqliteInvocationAuditAppendPort {
    findAudit(transaction: TransactionalSqlite, id: AuditRecordId): AuditRecord | undefined;
    findAuditByEvidence(transaction: TransactionalSqlite, actor: ActorRef, kind: AuditKind): AuditRecord | undefined;
    appendAudit(transaction: TransactionalSqlite, record: AuditRecord, context?: AuditAppendContext): void;
}
export declare class SqliteInvocationMediationPersistence implements InvocationReplayPersistence<TransactionalSqlite>, InvocationEvidencePersistence<TransactionalSqlite> {
    private readonly audits;
    constructor(database: TransactionalSqlite, audits: SqliteInvocationAuditAppendPort);
    replay(transaction: TransactionalSqlite, scope: string, requestKey: string): MediatedReplayRecord | undefined;
    replayById(transaction: TransactionalSqlite, id: Digest): MediatedReplayRecord | undefined;
    appendReplay(transaction: TransactionalSqlite, record: MediatedReplayRecord): void;
    appendAudit(transaction: TransactionalSqlite, record: AuditRecord, context?: AuditAppendContext): void;
    audit(transaction: TransactionalSqlite, id: AuditRecordId): AuditRecord | undefined;
    findAuditByEvidence(transaction: TransactionalSqlite, actor: ActorRef, kind: AuditKind): AuditRecord | undefined;
    publication(transaction: TransactionalSqlite, id: Digest): InvocationPublicationOutbox | undefined;
    pendingPublications(transaction: TransactionalSqlite): readonly InvocationPublicationOutbox[];
    appendPublication(transaction: TransactionalSqlite, record: InvocationPublicationOutbox): void;
}
