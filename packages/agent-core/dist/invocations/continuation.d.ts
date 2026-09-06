import { Digest, RecordCodec, type JsonValue, type RecordVersion } from "../core/index.js";
import { type StructuralCodec } from "./codec.js";
import type { ItemClaimOwner } from "./claim.js";
import { ApprovalId, EffectAttemptId, ItemClaimId } from "./id.js";
import { InvocationId } from "../interaction-references/index.js";
export declare class InvocationContinuation<Lease> {
    #private;
    readonly invocation: InvocationId;
    readonly intentDigest: Digest;
    readonly approval: ApprovalId;
    readonly firstAttempt: EffectAttemptId;
    readonly firstItemIndex: number;
    readonly firstOrdinal: number;
    readonly firstClaim: ItemClaimId;
    readonly firstItemKey: string;
    readonly firstClaimOwner: ItemClaimOwner<Lease>;
    constructor(invocation: InvocationId, intentDigest: Digest, approval: ApprovalId, firstAttempt: EffectAttemptId, firstItemIndex: number, firstOrdinal: number, firstClaim: ItemClaimId, firstClaimOwner: ItemClaimOwner<Lease>, firstItemKey: string, admittedAt: Date);
    static encode<Lease>(record: InvocationContinuation<Lease>, lease: StructuralCodec<Lease>): Uint8Array;
    static decode<Lease>(bytes: Uint8Array, lease: StructuralCodec<Lease>): InvocationContinuation<Lease>;
    get admittedAt(): Date;
}
export declare class InvocationContinuationCodec<Lease> extends RecordCodec<InvocationContinuation<Lease>> {
    #private;
    constructor(lease: StructuralCodec<Lease>);
    protected encodePayload(record: InvocationContinuation<Lease>): JsonValue;
    protected decodePayload(payload: JsonValue, _version: RecordVersion): InvocationContinuation<Lease>;
}
