import { ActorRef } from "../actors/index.js";
import { RunId, type LeaseToken } from "../agents/index.js";
import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import { ProtectionDomain } from "../facets/index.js";
import { TenantId } from "../identity/index.js";
import { type JsonObject } from "./data.js";
import { InvalidationWatermark } from "./epoch.js";
export interface TargetLeaseEvidenceTarget {
    readonly actor: ActorRef;
    readonly fence: number;
    readonly domain: ProtectionDomain;
}
/** The stable source-delivery identity for one immutable lease attestation. */
export declare class TargetLeaseEvidenceKey {
    readonly source: ActorRef;
    readonly idempotencyKey: string;
    constructor(source: ActorRef, idempotencyKey: string);
    equals(other: TargetLeaseEvidenceKey): boolean;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): TargetLeaseEvidenceKey;
}
/** The exact immutable source evidence a target request names. */
export declare class TargetLeaseEvidenceReference {
    readonly key: TargetLeaseEvidenceKey;
    readonly digest: Digest;
    constructor(key: TargetLeaseEvidenceKey, digest: Digest);
    equals(other: TargetLeaseEvidenceReference): boolean;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): TargetLeaseEvidenceReference;
}
export interface TargetLeaseEvidenceBinding {
    readonly key: TargetLeaseEvidenceKey;
    readonly tenant: TenantId;
    readonly run: RunId;
    readonly lease: LeaseToken;
    readonly target: TargetLeaseEvidenceTarget;
    readonly requestIdentity: Digest;
}
export interface TargetLeaseEvidenceInit extends TargetLeaseEvidenceBinding {
    readonly deadline: Date;
    readonly watermark: InvalidationWatermark;
}
/**
 * A source-Actor's immutable attestation that one exact Turn lease authorizes one target
 * permit-request identity. It snapshots evidence and never represents current lease state.
 */
export declare class TargetLeaseEvidence {
    #private;
    static get codec(): RecordCodec<TargetLeaseEvidence>;
    readonly key: TargetLeaseEvidenceKey;
    readonly tenant: TenantId;
    readonly run: RunId;
    readonly lease: LeaseToken;
    readonly target: TargetLeaseEvidenceTarget;
    readonly requestIdentity: Digest;
    readonly watermark: InvalidationWatermark;
    constructor(init: TargetLeaseEvidenceInit);
    reference(): TargetLeaseEvidenceReference;
    get deadline(): Date;
    digest(): Digest;
    isCurrentAt(now: Date): boolean;
    matches(binding: TargetLeaseEvidenceBinding): boolean;
    toData(): JsonObject;
    static encode(record: TargetLeaseEvidence): Uint8Array;
    static decode(bytes: Uint8Array): TargetLeaseEvidence;
    static fromData(value: JsonValue | undefined): TargetLeaseEvidence;
}
