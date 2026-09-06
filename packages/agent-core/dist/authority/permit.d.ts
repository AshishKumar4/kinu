import { ActorRef } from "../actors/index.js";
import { RunId, type LeaseToken } from "../agents/index.js";
import { Digest, RecordCodec, Revision, type JsonValue } from "../core/index.js";
import { PackagePin } from "../definition/index.js";
import { BindingName, FacetRef, type Impact, OperationRef, ProtectionDomain } from "../facets/index.js";
import { PrincipalRef, TenantId } from "../identity/index.js";
import { ClaimWorkerId, ItemClaimId } from "../invocation-references/index.js";
import { InvocationId } from "../interaction-references/index.js";
import { type JsonObject } from "./data.js";
import { PathEpochEvidence } from "./epoch.js";
export interface AuthorityPermitTarget {
    readonly actor: ActorRef;
    readonly fence: number;
    readonly domain: ProtectionDomain;
}
export interface AuthorityPermitBinding {
    readonly name: BindingName;
    readonly generation: Revision;
}
export interface AuthorityPermitReservation {
    readonly run: RunId;
    readonly registryEpoch: number;
    readonly obligation: {
        readonly kind: "invocationItem";
        readonly invocation: InvocationId;
        readonly itemIndex: number;
        readonly itemKey: string;
    };
}
export type AuthorityPermitClaimOwner = {
    readonly kind: "executor";
    readonly token: LeaseToken;
    readonly worker: ClaimWorkerId;
} | {
    readonly kind: "system";
    readonly actor: ActorRef;
    readonly worker: ClaimWorkerId;
};
export type AuthorityPermitSource = {
    readonly kind: "initiator";
    readonly principal: PrincipalRef;
    readonly binding: BindingName;
} | {
    readonly kind: "delegated";
    readonly principal: PrincipalRef;
    readonly binding: BindingName;
};
export interface AuthorityPermitExpectationInit {
    readonly tenant: TenantId;
    readonly issuer: ActorRef;
    readonly source: ActorRef;
    readonly target: AuthorityPermitTarget;
    readonly principal: PrincipalRef;
    readonly binding: AuthorityPermitBinding;
    readonly facet: FacetRef;
    readonly operation: OperationRef;
    readonly package: PackagePin;
    readonly impact: Impact;
    readonly invocation: InvocationId;
    readonly reservation: AuthorityPermitReservation;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
    readonly claim: ItemClaimId;
    readonly claimOwner: AuthorityPermitClaimOwner;
    readonly itemKey: string;
    readonly argumentsDigest: Digest;
    readonly intentDigest: Digest;
    readonly pathEpochs: PathEpochEvidence;
    readonly authority: AuthorityPermitSource;
    readonly lease?: LeaseToken | undefined;
}
export declare class AuthorityPermitExpectation {
    readonly tenant: TenantId;
    readonly issuer: ActorRef;
    readonly source: ActorRef;
    readonly target: AuthorityPermitTarget;
    readonly principal: PrincipalRef;
    readonly binding: AuthorityPermitBinding;
    readonly facet: FacetRef;
    readonly operation: OperationRef;
    readonly package: PackagePin;
    readonly impact: Impact;
    readonly invocation: InvocationId;
    readonly reservation: AuthorityPermitReservation;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
    readonly claim: ItemClaimId;
    readonly claimOwner: AuthorityPermitClaimOwner;
    readonly itemKey: string;
    readonly argumentsDigest: Digest;
    readonly intentDigest: Digest;
    readonly pathEpochs: PathEpochEvidence;
    readonly authority: AuthorityPermitSource;
    readonly lease: LeaseToken | undefined;
    constructor(init: AuthorityPermitExpectationInit);
    equals(other: AuthorityPermitExpectation): boolean;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): AuthorityPermitExpectation;
}
export interface AuthorityPermitInit extends AuthorityPermitExpectationInit {
    readonly nonce: string;
    readonly requestDigest: Digest;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
}
export declare class AuthorityPermit {
    #private;
    static get codec(): RecordCodec<AuthorityPermit>;
    readonly expectation: AuthorityPermitExpectation;
    readonly nonce: string;
    readonly requestDigest: Digest;
    constructor(init: AuthorityPermitInit);
    static encode(permit: AuthorityPermit): Uint8Array;
    static decode(bytes: Uint8Array): AuthorityPermit;
    get tenant(): TenantId;
    get issuer(): ActorRef;
    get source(): ActorRef;
    get target(): AuthorityPermitTarget;
    get principal(): PrincipalRef;
    get binding(): AuthorityPermitBinding;
    get facet(): FacetRef;
    get operation(): OperationRef;
    get package(): PackagePin;
    get impact(): Impact;
    get invocation(): InvocationId;
    get reservation(): AuthorityPermitReservation;
    get itemIndex(): number;
    get attemptOrdinal(): number;
    get claim(): ItemClaimId;
    get claimOwner(): AuthorityPermitClaimOwner;
    get itemKey(): string;
    get argumentsDigest(): Digest;
    get intentDigest(): Digest;
    get pathEpochs(): PathEpochEvidence;
    get authority(): AuthorityPermitSource;
    get lease(): LeaseToken | undefined;
    get issuedAt(): Date;
    get expiresAt(): Date;
    digest(): Digest;
    assertConsumable(expected: AuthorityPermitExpectation, now: Date): void;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): AuthorityPermit;
}
