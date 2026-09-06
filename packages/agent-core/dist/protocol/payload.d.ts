import type { ActorRef } from "../actors/index.js";
import type { TransientContentBinding, TransientContentLease } from "../content/index.js";
import type { ContentRef, Digest } from "../core/index.js";
import { AgentCoreError } from "../errors.js";
import type { TenantId } from "../identity/index.js";
export type PayloadMalformedReason = "absent" | "missing" | "referenceMismatch" | "submittedMismatch" | "tooLarge";
export interface CommandPayloadCodec<Payload = unknown> {
    decode(bytes: Uint8Array): Payload;
}
export declare class CommandPayloadMalformedError extends AgentCoreError {
    constructor(message?: string);
}
export declare class PayloadLeaseBinding implements TransientContentBinding {
    #private;
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly envelopeDigest: Digest;
    readonly ref: ContentRef;
    readonly digest: Digest;
    constructor(tenant: TenantId, actor: ActorRef, envelopeDigest: Digest, ref: ContentRef, digest: Digest, expiresAt: Date);
    get expiresAt(): Date;
    matches(tenant: TenantId, actor: ActorRef, envelopeDigest: Digest, ref: ContentRef, digest: Digest): boolean;
}
interface PreparedPayloadState {
    readonly lease?: TransientContentLease;
    readonly binding?: PayloadLeaseBinding;
    readonly malformedReason?: PayloadMalformedReason;
}
export declare class PreparedCommandPayload {
    constructor(issuer: symbol, state: PreparedPayloadState);
    get lease(): TransientContentLease | undefined;
    get binding(): PayloadLeaseBinding | undefined;
    get malformedReason(): PayloadMalformedReason | undefined;
}
export declare function issueLeasedCommandPayload(lease: TransientContentLease, binding: PayloadLeaseBinding): PreparedCommandPayload;
export declare function issueMalformedCommandPayload(malformedReason: PayloadMalformedReason): PreparedCommandPayload;
export declare function inspectPreparedCommandPayload(value: PreparedCommandPayload): Readonly<PreparedPayloadState> | undefined;
export {};
