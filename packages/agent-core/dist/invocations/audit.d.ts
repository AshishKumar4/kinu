import { ActorRef } from "../actors/index.js";
import { Digest, RecordCodec } from "../core/index.js";
import { TenantId } from "../identity/index.js";
import { RunCommitId } from "../execution-references/index.js";
import { AuditRecordId, CorrelationId, EventId, InvocationId, RouteProjectionId, RouteReservationId } from "../interaction-references/index.js";
import { ApprovalId, EffectAttemptId, ReceiptId, WriteRecordId } from "./id.js";
import type { AttemptReceiptOutcome, PreEffectReceiptOutcome } from "./receipt.js";
import type { CommandOutcome } from "../protocol/index.js";
export type ApprovalAuditPhase = "pending" | "approved" | "denied" | "expired" | "consumed";
export type ReceiptAuditOutcome = PreEffectReceiptOutcome | AttemptReceiptOutcome;
export type WriteAuditOutcome = CommandOutcome;
export type AuditKind = {
    readonly kind: "invocation";
    readonly id: InvocationId;
} | {
    readonly kind: "approval";
    readonly id: ApprovalId;
    readonly phase: ApprovalAuditPhase;
} | {
    readonly kind: "attempt";
    readonly id: EffectAttemptId;
} | {
    readonly kind: "receipt";
    readonly id: ReceiptId;
    readonly outcome: ReceiptAuditOutcome;
} | {
    readonly kind: "receiptSuperseded";
    readonly previous: ReceiptId;
    readonly next: ReceiptId;
} | {
    readonly kind: "write";
    readonly id: WriteRecordId;
    readonly outcome: WriteAuditOutcome;
} | {
    readonly kind: "event";
    readonly id: EventId;
} | {
    readonly kind: "routeReserved";
    readonly id: RouteReservationId;
} | {
    readonly kind: "routeProjected";
    readonly projection: RouteProjectionId;
    readonly reservation: RouteReservationId;
} | {
    readonly kind: "delivery";
    readonly reservation: RouteReservationId;
} | {
    readonly kind: "commit";
    readonly id: RunCommitId;
};
export declare function auditEvidenceIdentity(actor: ActorRef, kind: AuditKind): Digest;
export interface AuditRecordInit {
    readonly id: AuditRecordId;
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    readonly correlation: CorrelationId;
    readonly cause?: AuditRecordId;
    readonly kind: AuditKind;
}
export declare class AuditRecord {
    static get codec(): RecordCodec<AuditRecord>;
    static encode(record: AuditRecord): Uint8Array;
    static decode(bytes: Uint8Array): AuditRecord;
    readonly id: AuditRecordId;
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    readonly correlation: CorrelationId;
    readonly cause: AuditRecordId | undefined;
    readonly kind: AuditKind;
    constructor(init: AuditRecordInit);
}
export type AuditRootAdmission = {
    readonly kind: "commandRejection";
} | {
    readonly kind: "routeProjection";
    readonly projection: RouteProjectionId;
    readonly reservation: RouteReservationId;
};
export interface AuditAppendContext {
    readonly rootAdmission?: AuditRootAdmission;
    readonly evidence?: AuditEvidenceResolver;
}
export interface AuditRecordLookup {
    get(id: AuditRecordId): AuditRecord | undefined;
}
export interface ApprovalAuditEvidence {
    readonly invocation: InvocationId;
    readonly phase: ApprovalAuditPhase;
}
export interface AttemptAuditEvidence {
    readonly invocation: InvocationId;
    readonly auditCause: AuditRecordId;
}
export interface ReceiptAuditEvidence {
    readonly invocation: InvocationId;
    readonly attempt?: EffectAttemptId;
    readonly outcome: ReceiptAuditOutcome;
    readonly previous?: ReceiptId;
}
export interface EventAuditEvidence {
    readonly receipt?: ReceiptId;
}
export interface RouteAuditEvidence {
    readonly event: EventId;
    readonly invocation: InvocationId;
    readonly projection: RouteProjectionId;
}
export interface DeliveryAuditEvidence {
    readonly reservation: RouteReservationId;
}
export interface CommitAuditEvidence {
    readonly receipt?: ReceiptId;
    readonly reservation?: RouteReservationId;
}
export interface ProjectionAuditEvidence {
    readonly actor: ActorRef;
    readonly tenant: TenantId;
}
export interface WriteAuditEvidence {
    readonly invocation: InvocationId;
    readonly outcome: WriteAuditOutcome;
}
export interface AuditEvidenceResolver {
    approval(id: ApprovalId, phase: ApprovalAuditPhase): ApprovalAuditEvidence | undefined;
    attempt(id: EffectAttemptId): AttemptAuditEvidence | undefined;
    receipt(id: ReceiptId): ReceiptAuditEvidence | undefined;
    event(id: EventId): EventAuditEvidence | undefined;
    route(id: RouteReservationId): RouteAuditEvidence | undefined;
    projection(projection: RouteProjectionId, reservation: RouteReservationId): ProjectionAuditEvidence | undefined;
    delivery(id: RouteReservationId): DeliveryAuditEvidence | undefined;
    commit(id: RunCommitId): CommitAuditEvidence | undefined;
    write(id: WriteRecordId): WriteAuditEvidence | undefined;
}
export declare function validateAuditAppend(record: AuditRecord, records: AuditRecordLookup, rootAdmission?: AuditRootAdmission, evidence?: AuditEvidenceResolver): void;
export declare function validateAuditRelation(record: AuditRecord, records: AuditRecordLookup, rootAdmission?: AuditRootAdmission, evidence?: AuditEvidenceResolver): void;
export declare function validateStoredAuditLinkage(record: AuditRecord, records: AuditRecordLookup): void;
export declare const AuditRecordCodec: RecordCodec<AuditRecord>;
