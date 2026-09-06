import { Digest, RecordCodec, Revision, type JsonValue } from "../core/index.js";
import { AgentCoreError } from "../errors.js";
import type { GuestVerification } from "./guest-verification.js";
import { MembershipId, RoleName, ShareOfferId } from "./id.js";
import { Membership } from "./member.js";
import { ScopeRef } from "./scope.js";
import { type ForeignPrincipalRef, type PrincipalSubjectRef, type SubjectRef } from "./subject.js";
export type ShareOfferState = "open" | "revoked";
/**
 * Why a redemption was refused. A bearer redemption path must not collapse these into one
 * fact: a caller has to tell "you were too late" from "this was taken away from you", and an
 * exhausted bound from a secret that never matched. The closed `AgentCoreErrorCode` union
 * stays untouched — the denial is `authority.denied` and this narrows it, exactly as
 * `InvocationError` narrows `invocation.invalid`.
 */
export type ShareOfferRefusal = "bound-reached" | "expired" | "not-yet-open" | "revoked" | "secret-mismatch" | "team-subject";
export declare class ShareOfferRedemptionDenied extends AgentCoreError {
    readonly refusal: ShareOfferRefusal;
    constructor(refusal: ShareOfferRefusal, message: string);
}
/** The subject a bearer artifact can be held by: a Principal, never a Team. */
export type ShareOfferHolder = PrincipalSubjectRef | ForeignPrincipalRef;
/**
 * Identifies the holder a redemption is keyed on. Canonical tuple encoding preserves every
 * component boundary, including identifiers containing NUL. A foreign holder's
 * `verifiedVia` is deliberately excluded: re-verification changes evidence, not identity.
 */
export declare function shareOfferHolderKey(holder: ShareOfferHolder): string;
/** One recorded redemption: which holder redeemed, which Membership it minted, and when. */
export declare class ShareOfferRedemption {
    #private;
    readonly membership: MembershipId;
    readonly subject: ShareOfferHolder;
    readonly holderKey: string;
    constructor(subject: SubjectRef, membership: MembershipId, redeemedAt: Date);
    get redeemedAt(): Date;
    toData(): JsonValue;
    static fromData(value: JsonValue): ShareOfferRedemption;
}
export interface ShareOfferRedemptionRequest {
    /** The bearer secret the holder presents; only its digest is durable. */
    readonly secret: Uint8Array;
    readonly subject: SubjectRef;
    /** The Membership id a first redemption commits to. */
    readonly membership: MembershipId;
    readonly now: Date;
    /** Required for a foreign holder and refused for a local one, exactly as §3.3 fixes. */
    readonly guestVerification?: GuestVerification;
}
/**
 * A redemption either issues the offer's one Membership for a holder or replays the
 * redemption already recorded for that holder. A replay names the recorded Membership and
 * mints nothing: that Membership may since have been revised or revoked, and the offer is not
 * the record that answers for it.
 */
export declare abstract class ShareOfferRedemptionOutcome {
    abstract readonly offer: ShareOffer;
    abstract readonly membershipId: MembershipId;
    abstract readonly membership: Membership | undefined;
    abstract readonly isReplay: boolean;
    static issued(offer: ShareOffer, membership: Membership): ShareOfferRedemptionOutcome;
    static replayed(offer: ShareOffer, recorded: ShareOfferRedemption): ShareOfferRedemptionOutcome;
}
/**
 * A **ShareOffer** is a bearer artifact created before its subject is known — the record
 * behind handing someone a link. It is deferred Membership issuance and never a second
 * authority path: it carries no capability, no Grant and no lineage, and until a redemption is
 * recorded it confers nothing at all.
 */
export declare class ShareOffer {
    #private;
    readonly id: ShareOfferId;
    readonly scope: ScopeRef;
    readonly role: RoleName;
    readonly roleDigest: Digest;
    readonly secretDigest: Digest;
    readonly revision: Revision;
    static get codec(): RecordCodec<ShareOffer>;
    readonly bound: number;
    readonly redemptions: readonly ShareOfferRedemption[];
    constructor(id: ShareOfferId, scope: ScopeRef, role: RoleName, roleDigest: Digest, secretDigest: Digest, createdAt: Date, expiresAt: Date, bound: number, redemptions: readonly ShareOfferRedemption[], state: ShareOfferState, revision: Revision);
    static encode(offer: ShareOffer): Uint8Array;
    static decode(bytes: Uint8Array): ShareOffer;
    get state(): ShareOfferState;
    get isOpen(): boolean;
    get isExhausted(): boolean;
    get createdAt(): Date;
    get expiresAt(): Date;
    /**
     * Revocation stops every not-yet-recorded redemption. It never retracts a Membership a
     * recorded redemption already minted — that Membership is revoked as a Membership, on the
     * one enforcement plane, which is why nothing surviving a redemption is ambient (§3.4).
     */
    revoke(): ShareOffer;
    /**
     * `undefined` answers exactly one question — this holder has not redeemed — so the
     * parameter is a `ShareOfferHolder` rather than a `SubjectRef`: a Team cannot be asked at
     * all, instead of being answered with the same value as an unredeemed holder. A caller
     * that defeats the type is refused rather than silently told "not redeemed".
     */
    recordedFor(holder: ShareOfferHolder): ShareOfferRedemption | undefined;
    /**
     * Fail-closed order is load-bearing. The presented secret is checked first, so a wrong
     * secret learns nothing about the offer's state. A recorded holder then replays, ahead of
     * the lifecycle, window and bound checks, because a duplicate delivery of an
     * already-committed redemption mints nothing and must not be answered by minting a second
     * Membership. Only issuance is gated on the offer being open, unexpired and unexhausted.
     */
    redeem(request: ShareOfferRedemptionRequest): ShareOfferRedemptionOutcome;
    /**
     * What a store may accept over a stored offer. The offer's terms — Scope, Role, exact
     * Role content digest, bearer secret digest, window and bound — are immutable, revision
     * advances exactly once, a revoked offer is terminal, and recorded redemptions are
     * append-only and immutable: changing any prior redemption field would rewrite the
     * evidence of the Membership it minted, which §3.3 forbids.
     */
    assertCanReplace(next: ShareOffer): void;
    private transition;
}
