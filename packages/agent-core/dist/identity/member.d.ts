import { RecordCodec, Revision } from "../core/index.js";
import { MembershipId, RoleName } from "./id.js";
import { GuestVerification } from "./guest-verification.js";
import { ScopeRef } from "./scope.js";
import { type SubjectRef } from "./subject.js";
export type MembershipState = "active" | "suspended" | "revoked";
declare class MembershipRestorationAuthority {
}
export declare class Membership {
    #private;
    readonly id: MembershipId;
    readonly scope: ScopeRef;
    readonly role: RoleName;
    readonly revision: Revision;
    readonly guestVerification?: GuestVerification | undefined;
    static get codec(): RecordCodec<Membership>;
    readonly subject: SubjectRef;
    constructor(id: MembershipId, scope: ScopeRef, subject: SubjectRef, role: RoleName, state: MembershipState, revision: Revision, guestVerification?: GuestVerification | undefined, internalToken?: MembershipRestorationAuthority);
    static encode(membership: Membership): Uint8Array;
    static decode(bytes: Uint8Array): Membership;
    get isActive(): boolean;
    get state(): MembershipState;
    revise(role: RoleName, state: MembershipState): Membership;
    withGuestVerification(verification: GuestVerification): Membership;
    suspend(): Membership;
    activate(): Membership;
    revoke(): Membership;
}
export {};
