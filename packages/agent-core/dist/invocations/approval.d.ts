import { Digest, RecordCodec, Revision } from "../core/index.js";
import { PrincipalId } from "../identity/index.js";
import { ApprovalId, EffectAttemptId } from "./id.js";
import { InvocationId } from "../interaction-references/index.js";
export type ApprovalState = {
    readonly kind: "pending";
} | {
    readonly kind: "approved";
    readonly by: PrincipalId;
    readonly at: Date;
} | {
    readonly kind: "denied";
    readonly by: PrincipalId;
    readonly at: Date;
    readonly reason: string;
} | {
    readonly kind: "expired";
    readonly at: Date;
} | {
    readonly kind: "consumed";
    readonly by: PrincipalId;
    readonly approvedAt: Date;
    readonly at: Date;
    readonly firstAttempt: EffectAttemptId;
};
export declare class Approval {
    #private;
    readonly id: ApprovalId;
    readonly invocation: InvocationId;
    readonly intentDigest: Digest;
    readonly revision: Revision;
    static encode(record: Approval): Uint8Array;
    static decode(bytes: Uint8Array): Approval;
    constructor(id: ApprovalId, invocation: InvocationId, intentDigest: Digest, requestedAt: Date, expiresAt: Date | undefined, revision: Revision, state: ApprovalState);
    static pending(id: ApprovalId, invocation: InvocationId, intentDigest: Digest, requestedAt: Date, expiresAt?: Date): Approval;
    get requestedAt(): Date;
    get expiresAt(): Date | undefined;
    get state(): ApprovalState;
    approve(by: PrincipalId, at: Date): Approval;
    deny(by: PrincipalId, at: Date, reason: string): Approval;
    expire(at: Date): Approval;
    consume(firstAttempt: EffectAttemptId, at: Date): Approval;
    private transition;
    private requirePending;
    private requireBeforeExpiry;
}
export declare const ApprovalCodec: RecordCodec<Approval>;
