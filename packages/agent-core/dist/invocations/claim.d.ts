import { ActorRef } from "../actors/index.js";
import { RecordCodec, type JsonValue, type RecordVersion } from "../core/index.js";
import { type StructuralCodec } from "./codec.js";
import { ClaimWorkerId, ItemClaimId } from "./id.js";
import { InvocationId } from "../interaction-references/index.js";
export type ItemClaimOwner<Lease> = {
    readonly kind: "executor";
    readonly token: Lease;
    readonly worker: ClaimWorkerId;
} | {
    readonly kind: "system";
    readonly actor: ActorRef;
    readonly worker: ClaimWorkerId;
};
export declare class ItemClaim<Lease> {
    #private;
    readonly id: ItemClaimId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
    readonly owner: ItemClaimOwner<Lease>;
    static encode<Lease>(record: ItemClaim<Lease>, lease: StructuralCodec<Lease>): Uint8Array;
    static decode<Lease>(bytes: Uint8Array, lease: StructuralCodec<Lease>): ItemClaim<Lease>;
    constructor(id: ItemClaimId, invocation: InvocationId, itemIndex: number, attemptOrdinal: number, owner: ItemClaimOwner<Lease>, expiresAt: Date);
    get expiresAt(): Date;
    requireFuture(now: Date): void;
    recover(id: ItemClaimId, owner: ItemClaimOwner<Lease>, expiresAt: Date, now: Date): ItemClaim<Lease>;
}
export declare class ItemClaimCodec<Lease> extends RecordCodec<ItemClaim<Lease>> {
    #private;
    constructor(lease: StructuralCodec<Lease>);
    protected encodePayload(record: ItemClaim<Lease>): JsonValue;
    protected decodePayload(payload: JsonValue, _version: RecordVersion): ItemClaim<Lease>;
}
