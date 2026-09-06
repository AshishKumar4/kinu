import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import type { JsonObject } from "./data.js";
import { TargetLeaseEvidenceReference } from "./target-lease-evidence.js";
import { AuthorityPermitExpectation } from "./permit.js";
import { AuthorityCheckRequest } from "./evidence.js";
/** The target-owned immutable request from which its Tenant may issue one permit. */
export declare class TargetAuthorityPermitRequest {
    #private;
    readonly expectation: AuthorityPermitExpectation;
    readonly authority: AuthorityCheckRequest;
    readonly nonce: string;
    static get codec(): RecordCodec<TargetAuthorityPermitRequest>;
    constructor(expectation: AuthorityPermitExpectation, authority: AuthorityCheckRequest, nonce: string, expiresAt: Date, leaseEvidence?: TargetLeaseEvidenceReference | undefined);
    readonly leaseEvidence: TargetLeaseEvidenceReference | undefined;
    get expiresAt(): Date;
    identity(): Digest;
    digest(): Digest;
    toData(): JsonObject;
    static identityFor(expectation: AuthorityPermitExpectation, authority: AuthorityCheckRequest, nonce: string, expiresAt: Date): Digest;
    static fromData(value: JsonValue | undefined): TargetAuthorityPermitRequest;
    static encode(request: TargetAuthorityPermitRequest): Uint8Array;
    static decode(bytes: Uint8Array): TargetAuthorityPermitRequest;
}
