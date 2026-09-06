import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import type { JsonObject } from "./data.js";
import { AuthorityCheckEvidence } from "./evidence.js";
import { TargetAuthorityPermitRequest } from "./permit-request.js";
/** The exact denied Tenant decision for one target-owned permit request. */
export declare class TargetAuthorityPermitDenial {
    readonly request: TargetAuthorityPermitRequest;
    readonly evidence: AuthorityCheckEvidence;
    static get codec(): RecordCodec<TargetAuthorityPermitDenial>;
    constructor(request: TargetAuthorityPermitRequest, evidence: AuthorityCheckEvidence);
    digest(): Digest;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): TargetAuthorityPermitDenial;
    static encode(denial: TargetAuthorityPermitDenial): Uint8Array;
    static decode(bytes: Uint8Array): TargetAuthorityPermitDenial;
}
