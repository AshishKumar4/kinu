import { Digest, RecordCodec, Revision, type JsonValue } from "../core/index.js";
import { GuestTrustId } from "./id.js";
import { PrincipalRef } from "./principal-ref.js";
import { GuestVerificationScheme, type ForeignPrincipalRef } from "./subject.js";
export declare class GuestVerification {
    #private;
    readonly principal: PrincipalRef;
    readonly trustId: GuestTrustId;
    readonly trustRevision: Revision;
    readonly verifiedVia: GuestVerificationScheme;
    readonly evidenceDigest: Digest;
    static get codec(): RecordCodec<GuestVerification>;
    constructor(principal: PrincipalRef, trustId: GuestTrustId, trustRevision: Revision, verifiedVia: GuestVerificationScheme, evidenceDigest: Digest, verifiedAt: Date, expiresAt: Date, token: symbol);
    static encode(verification: GuestVerification): Uint8Array;
    static decode(bytes: Uint8Array): GuestVerification;
    get verifiedAt(): Date;
    get expiresAt(): Date;
    get isHostMinted(): boolean;
    admits(subject: ForeignPrincipalRef, now: Date): boolean;
    toData(): JsonValue;
}
export declare const guestVerificationCodec: RecordCodec<GuestVerification>;
export declare function mintGuestVerification(principal: PrincipalRef, trustId: GuestTrustId, trustRevision: Revision, verifiedVia: GuestVerificationScheme, evidenceDigest: Digest, verifiedAt: Date, expiresAt: Date): GuestVerification;
export declare function restoreGuestVerification(payload: JsonValue): GuestVerification;
export declare function isFreshGuestVerification(verification: GuestVerification): boolean;
export declare function isRestoredGuestVerification(verification: GuestVerification): boolean;
