import { RecordCodec, type JsonValue, type RecordVersion } from "../core/index.js";
import { type StructuralCodec } from "./codec.js";
import { EffectAttemptId, ItemClaimId } from "./id.js";
import { AuditRecordId, InvocationId } from "../interaction-references/index.js";
import { AuthorityAdmissionReference } from "./ports.js";
export declare class EffectAttempt<Lease, Admission> {
    #private;
    readonly id: EffectAttemptId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly ordinal: number;
    readonly claim: ItemClaimId;
    readonly admission: AuthorityAdmissionReference<Admission>;
    readonly idempotencyKey: string;
    readonly auditCause: AuditRecordId;
    readonly token: Lease | undefined;
    static encode<Lease, Admission>(record: EffectAttempt<Lease, Admission>, lease: StructuralCodec<Lease>, admission: StructuralCodec<Admission>): Uint8Array;
    static decode<Lease, Admission>(bytes: Uint8Array, lease: StructuralCodec<Lease>, admission: StructuralCodec<Admission>): EffectAttempt<Lease, Admission>;
    constructor(id: EffectAttemptId, invocation: InvocationId, itemIndex: number, ordinal: number, claim: ItemClaimId, token: Lease | undefined, admission: AuthorityAdmissionReference<Admission>, startedAt: Date, idempotencyKey: string, auditCause: AuditRecordId);
    get startedAt(): Date;
}
export declare class EffectAttemptCodec<Lease, Admission> extends RecordCodec<EffectAttempt<Lease, Admission>> {
    #private;
    constructor(lease: StructuralCodec<Lease>, admission: StructuralCodec<Admission>);
    protected encodePayload(record: EffectAttempt<Lease, Admission>): JsonValue;
    protected decodePayload(payload: JsonValue, _version: RecordVersion): EffectAttempt<Lease, Admission>;
}
