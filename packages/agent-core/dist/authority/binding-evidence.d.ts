import { ActorRef } from "../actors/index.js";
import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import { BindingName, FacetRef, ProtectionDomain } from "../facets/index.js";
import { ScopeRef, TenantId, type SubjectRef } from "../identity/index.js";
import { type JsonObject } from "./data.js";
import { PathEpochEvidence } from "./epoch.js";
import { GrantId } from "./id.js";
export interface BindingValidationRequestInit {
    readonly ownerTenant: TenantId;
    readonly workspaceActor: ActorRef;
    readonly workspaceFence: number;
    readonly scope: ScopeRef;
    readonly domain: ProtectionDomain;
    readonly name: BindingName;
    readonly grantId: GrantId;
    readonly facet: FacetRef;
    readonly nonce: string;
}
export declare class BindingValidationRequest {
    static get codec(): RecordCodec<BindingValidationRequest>;
    readonly domain: ProtectionDomain;
    constructor(init: BindingValidationRequestInit);
    readonly ownerTenant: TenantId;
    readonly workspaceActor: ActorRef;
    readonly workspaceFence: number;
    readonly scope: ScopeRef;
    readonly name: BindingName;
    readonly grantId: GrantId;
    readonly facet: FacetRef;
    readonly nonce: string;
    digest(): Digest;
    static encode(record: BindingValidationRequest): Uint8Array;
    static decode(bytes: Uint8Array): BindingValidationRequest;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): BindingValidationRequest;
}
export declare class BindingValidationEvidence {
    #private;
    readonly issuerTenant: TenantId;
    readonly issuer: ActorRef;
    readonly requestDigest: Digest;
    readonly scope: ScopeRef;
    readonly grantId: GrantId;
    readonly pathEpochs: PathEpochEvidence;
    static get codec(): RecordCodec<BindingValidationEvidence>;
    readonly subject: SubjectRef;
    constructor(issuerTenant: TenantId, issuer: ActorRef, requestDigest: Digest, scope: ScopeRef, subject: SubjectRef, grantId: GrantId, pathEpochs: PathEpochEvidence, checkedAt: Date);
    static encode(record: BindingValidationEvidence): Uint8Array;
    static decode(bytes: Uint8Array): BindingValidationEvidence;
    get checkedAt(): Date;
    binds(request: BindingValidationRequest): boolean;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): BindingValidationEvidence;
}
