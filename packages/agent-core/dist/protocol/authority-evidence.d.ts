import { AuthorityCheckEvidence, AuthorityCheckRequest, AuthorityPermit, TargetAuthorityPermitRequest, TargetLeaseEvidence, BindingValidationEvidence, BindingValidationRequest } from "../authority/index.js";
import { RecordCodec } from "../core/index.js";
import type { CommandPayloadCodec } from "./payload.js";
export declare class AuthorityCheckReply {
    readonly evidence: AuthorityCheckEvidence;
    static get codec(): RecordCodec<AuthorityCheckReply>;
    constructor(evidence: AuthorityCheckEvidence);
    static encode(reply: AuthorityCheckReply): Uint8Array;
    static decode(bytes: Uint8Array): AuthorityCheckReply;
}
export declare class BindingValidationReply {
    readonly evidence: BindingValidationEvidence;
    static get codec(): RecordCodec<BindingValidationReply>;
    constructor(evidence: BindingValidationEvidence);
    static encode(reply: BindingValidationReply): Uint8Array;
    static decode(bytes: Uint8Array): BindingValidationReply;
}
export declare class AuthorityPermitIssuanceRequest {
    readonly targetRequest: TargetAuthorityPermitRequest;
    static get codec(): RecordCodec<AuthorityPermitIssuanceRequest>;
    constructor(targetRequest: TargetAuthorityPermitRequest);
    static encode(request: AuthorityPermitIssuanceRequest): Uint8Array;
    static decode(bytes: Uint8Array): AuthorityPermitIssuanceRequest;
}
export declare class AuthorityPermitIssuanceReply {
    readonly kind: "issued" | "denied";
    readonly evidence: AuthorityCheckEvidence;
    readonly permit: AuthorityPermit | undefined;
    static get codec(): RecordCodec<AuthorityPermitIssuanceReply>;
    private constructor();
    static issued(evidence: AuthorityCheckEvidence, permit: AuthorityPermit): AuthorityPermitIssuanceReply;
    static denied(evidence: AuthorityCheckEvidence): AuthorityPermitIssuanceReply;
    requirePermit(): AuthorityPermit;
    static encode(reply: AuthorityPermitIssuanceReply): Uint8Array;
    static decode(bytes: Uint8Array): AuthorityPermitIssuanceReply;
}
export declare class AuthorityCheckPayloadCodec implements CommandPayloadCodec<AuthorityCheckRequest> {
    decode(bytes: Uint8Array): AuthorityCheckRequest;
    encode(request: AuthorityCheckRequest): Uint8Array;
}
export declare class BindingValidationPayloadCodec implements CommandPayloadCodec<BindingValidationRequest> {
    decode(bytes: Uint8Array): BindingValidationRequest;
    encode(request: BindingValidationRequest): Uint8Array;
}
export declare class TargetLeaseEvidencePayloadCodec implements CommandPayloadCodec<TargetLeaseEvidence> {
    decode(bytes: Uint8Array): TargetLeaseEvidence;
    encode(evidence: TargetLeaseEvidence): Uint8Array;
}
export declare class AuthorityPermitIssuancePayloadCodec implements CommandPayloadCodec<AuthorityPermitIssuanceRequest> {
    decode(bytes: Uint8Array): AuthorityPermitIssuanceRequest;
    encode(request: AuthorityPermitIssuanceRequest): Uint8Array;
}
