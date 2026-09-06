import { ActorRef } from "../actors/index.js";
import { Digest, type JsonValue, RecordCodec } from "../core/index.js";
import { FacetRef, type Impact } from "../facets/index.js";
import { PrincipalRef, TenantId } from "../identity/index.js";
import { Binding } from "./binding.js";
import { type JsonObject } from "./data.js";
import { PathEpochEvidence } from "./epoch.js";
import { GrantId } from "./id.js";
export type AuthorityDecisionReason = "allowed" | "missingPrincipal" | "inactivePrincipal" | "invalidBinding" | "missingGrant" | "revokedGrant" | "invalidDelegation" | "guestElevation" | "guestVerificationExpired" | "noMatchingAllow" | "matchingDeny" | "stalePath";
export interface AuthorityOperationIntent {
    readonly facet: FacetRef;
    readonly operation: string;
    readonly impact: Impact;
    readonly arguments: Readonly<Record<string, JsonValue>>;
    readonly argumentsDigest: Digest;
}
export interface AuthorityCheckRequestInit {
    readonly ownerTenant: TenantId;
    readonly owner: ActorRef;
    readonly ownerFence: number;
    readonly principal: PrincipalRef;
    readonly binding: Binding;
    readonly intent: AuthorityOperationIntent;
    readonly expectedPath: PathEpochEvidence;
    readonly invocationDigest: Digest;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
    readonly nonce: string;
}
export declare class AuthorityCheckRequest {
    static get codec(): RecordCodec<AuthorityCheckRequest>;
    readonly intent: AuthorityOperationIntent;
    constructor(init: AuthorityCheckRequestInit);
    readonly ownerTenant: TenantId;
    readonly owner: ActorRef;
    readonly ownerFence: number;
    readonly principal: PrincipalRef;
    readonly binding: Binding;
    readonly invocationDigest: Digest;
    readonly expectedPath: PathEpochEvidence;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
    readonly nonce: string;
    digest(): Digest;
    static encode(record: AuthorityCheckRequest): Uint8Array;
    static decode(bytes: Uint8Array): AuthorityCheckRequest;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): AuthorityCheckRequest;
}
export declare class AuthorityCheckEvidence {
    #private;
    readonly issuerTenant: TenantId;
    readonly issuer: ActorRef;
    readonly requestDigest: Digest;
    readonly bindingKey: string;
    readonly bindingGeneration: number;
    readonly decision: "allow" | "deny";
    readonly reason: AuthorityDecisionReason;
    readonly pathEpochs: PathEpochEvidence;
    static get codec(): RecordCodec<AuthorityCheckEvidence>;
    readonly matchedAllow: readonly GrantId[];
    readonly matchedDeny: readonly GrantId[];
    constructor(issuerTenant: TenantId, issuer: ActorRef, requestDigest: Digest, bindingKey: string, bindingGeneration: number, decision: "allow" | "deny", reason: AuthorityDecisionReason, matchedAllow: readonly GrantId[], matchedDeny: readonly GrantId[], pathEpochs: PathEpochEvidence, checkedAt: Date);
    static encode(record: AuthorityCheckEvidence): Uint8Array;
    static decode(bytes: Uint8Array): AuthorityCheckEvidence;
    get checkedAt(): Date;
    get allowed(): boolean;
    binds(request: AuthorityCheckRequest): boolean;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): AuthorityCheckEvidence;
}
export type AuthorityAdmission = AuthorityCheckEvidence;
