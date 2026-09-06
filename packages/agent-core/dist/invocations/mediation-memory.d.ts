import { Digest } from "../core/index.js";
import type { ActorRef } from "../actors/index.js";
import { AuditRecord, type AuditAppendContext, type AuditKind } from "./audit.js";
import type { InvocationEvidencePersistence, InvocationReplayPersistence } from "./ports.js";
import { InvocationPublicationOutbox } from "./publication.js";
import { MediatedReplayRecord } from "./replay.js";
export interface InvocationMediationMemoryState {
    readonly replays: Map<string, Uint8Array>;
    readonly replayRevision: Map<string, number>;
    readonly replayByRequest: Map<string, string>;
    readonly audits: Map<string, Uint8Array>;
    readonly auditByEvidence: Map<string, string>;
    readonly publications: Map<string, Uint8Array>;
}
export declare function createInvocationMediationMemoryState(): InvocationMediationMemoryState;
export declare function cloneInvocationMediationMemoryState(state: InvocationMediationMemoryState): InvocationMediationMemoryState;
export declare class MemoryInvocationMediationPersistence implements InvocationReplayPersistence<InvocationMediationMemoryState>, InvocationEvidencePersistence<InvocationMediationMemoryState> {
    replay(transaction: InvocationMediationMemoryState, scope: string, requestKey: string): MediatedReplayRecord | undefined;
    replayById(transaction: InvocationMediationMemoryState, id: Digest): MediatedReplayRecord | undefined;
    appendReplay(transaction: InvocationMediationMemoryState, record: MediatedReplayRecord): void;
    appendAudit(transaction: InvocationMediationMemoryState, record: AuditRecord, context?: AuditAppendContext): void;
    audit(transaction: InvocationMediationMemoryState, id: AuditRecord["id"]): AuditRecord | undefined;
    findAuditByEvidence(transaction: InvocationMediationMemoryState, actor: ActorRef, kind: AuditKind): AuditRecord | undefined;
    publication(transaction: InvocationMediationMemoryState, id: Digest): InvocationPublicationOutbox | undefined;
    pendingPublications(transaction: InvocationMediationMemoryState): readonly InvocationPublicationOutbox[];
    appendPublication(transaction: InvocationMediationMemoryState, record: InvocationPublicationOutbox): void;
}
