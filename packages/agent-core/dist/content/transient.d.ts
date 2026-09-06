import { ActorRef } from "../actors/index.js";
import { ContentRef, Digest, RecordCodec } from "../core/index.js";
import { TenantId } from "../identity/index.js";
import type { MediaHint } from "./media.js";
export interface TransientContentBinding {
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly envelopeDigest: Digest;
    readonly ref: ContentRef;
    readonly digest: Digest;
    readonly expiresAt: Date;
}
export declare class TransientContentLeaseState {
    #private;
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    readonly envelopeDigest: Digest;
    readonly ref: ContentRef;
    readonly digest: Digest;
    static get codec(): RecordCodec<TransientContentLeaseState>;
    constructor(tenant: TenantId, actor: ActorRef, envelopeDigest: Digest, ref: ContentRef, digest: Digest, acquiredAt: Date, expiresAt: Date, closedAt?: Date);
    static encode(lease: TransientContentLeaseState): Uint8Array;
    static decode(bytes: Uint8Array): TransientContentLeaseState;
    get acquiredAt(): Date;
    get expiresAt(): Date;
    get closedAt(): Date | undefined;
    get inactiveAt(): Date | undefined;
    isActive(now: Date): boolean;
    matches(binding: TransientContentBinding): boolean;
    close(operationAt: Date): TransientContentLeaseState;
}
export declare abstract class TransientContentLease {
    abstract read(): Uint8Array;
    abstract matches(binding: TransientContentBinding, now: Date): boolean;
    abstract close(): Promise<void>;
}
export declare abstract class TransientContentAccess {
    abstract acquire(binding: TransientContentBinding, bytes?: Uint8Array, hint?: MediaHint): Promise<TransientContentLease | undefined>;
}
