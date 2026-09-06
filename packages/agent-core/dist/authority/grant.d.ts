import { RecordCodec, type JsonValue } from "../core/index.js";
import { CapabilitySpec, type CapabilityEffect } from "../facets/index.js";
import { MembershipId, ScopeRef, type SubjectRef } from "../identity/index.js";
import { type JsonObject } from "./data.js";
import { GrantId } from "./id.js";
export type GrantEffect = CapabilityEffect;
export type GrantOrigin = {
    readonly kind: "direct";
} | {
    readonly kind: "role";
    readonly membershipId: MembershipId;
    readonly roleName: string;
    readonly ruleOrdinal: number;
    readonly guest: boolean;
};
export interface GrantInit {
    readonly id: GrantId;
    readonly scope: ScopeRef;
    readonly subject: SubjectRef;
    readonly effect: GrantEffect;
    readonly capability: CapabilitySpec;
    readonly origin: GrantOrigin;
    readonly attenuationOf?: GrantId;
    readonly state?: GrantState;
}
export declare abstract class GrantState {
    static get active(): GrantState;
    static get revoked(): GrantState;
    abstract readonly name: "active" | "revoked";
    abstract revoke(): GrantState;
    get isActive(): boolean;
}
export declare class Grant {
    readonly id: GrantId;
    readonly scope: ScopeRef;
    readonly effect: GrantEffect;
    readonly capability: CapabilitySpec;
    static get codec(): RecordCodec<Grant>;
    readonly state: GrantState;
    readonly attenuationOf: GrantId | undefined;
    readonly origin: GrantOrigin;
    readonly subject: SubjectRef;
    constructor(id: GrantId, scope: ScopeRef, subject: SubjectRef, effect: GrantEffect, capability: CapabilitySpec, origin: GrantOrigin, attenuationOf?: GrantId, state?: GrantState);
    static create(init: GrantInit): Grant;
    static encode(grant: Grant): Uint8Array;
    static decode(bytes: Uint8Array): Grant;
    get isLive(): boolean;
    revoke(): Grant;
    canAttenuate(child: Grant): boolean;
    assertCanReplace(next: Grant): void;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): Grant;
}
