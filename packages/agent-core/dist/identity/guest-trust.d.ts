import { Digest, RecordCodec, Revision, SecretRef } from "../core/index.js";
import { GuestTrustId, TenantId } from "./id.js";
export type GuestTrustState = "active" | "revoked";
export type GuestTrustVerifier = TokenGuestTrustVerifier | CallbackGuestTrustVerifier;
export interface TokenGuestTrustVerifier {
    readonly kind: "token";
    readonly issuer: string;
    readonly key: SecretRef;
}
export interface CallbackGuestTrustVerifier {
    readonly kind: "callback";
    readonly endpoint: string;
}
export declare class GuestTrust {
    #private;
    readonly id: GuestTrustId;
    readonly hostTenant: TenantId;
    readonly homeTenant: TenantId;
    readonly revision: Revision;
    readonly handshakeDigest?: Digest | undefined;
    static get codec(): RecordCodec<GuestTrust>;
    readonly verifier: GuestTrustVerifier;
    constructor(id: GuestTrustId, hostTenant: TenantId, homeTenant: TenantId, verifier: GuestTrustVerifier, state: GuestTrustState, revision: Revision, handshakeDigest?: Digest | undefined);
    static encode(trust: GuestTrust): Uint8Array;
    static decode(bytes: Uint8Array): GuestTrust;
    get isActive(): boolean;
    get state(): GuestTrustState;
    rotate(verifier: GuestTrustVerifier): GuestTrust;
    revoke(): GuestTrust;
    assertCanReplace(next: GuestTrust): void;
}
