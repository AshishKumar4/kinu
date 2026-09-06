import { ContentRef, type ContentRetentionField, Digest, type JsonValue, RecordCodec, Revision } from "../../core/index.js";
import { PrincipalRef } from "../../identity/index.js";
import { RunCommitId, TurnId } from "../../execution-references/index.js";
import { CodecRecord } from "../record-data.js";
import { RunBranchId, RunCheckpointId, RunId, TurnInboxEntryId } from "./id.js";
import { TurnLease, type LeaseToken } from "./lease.js";
import { RunPins } from "./pins.js";
import { TurnStatus, type TerminalOutcome } from "./generated/turn-status/AgentCore/Extract/TurnStatus.js";
/**
 * The Turn status vocabulary and every transition it admits are lowered by the TSLean
 * compiler from `formal/AgentCore/Extract/TurnStatus.lean`, the module the Lean kernel
 * checks: the abstract base, the frozen singleton per case, and the four moves. A move the
 * table refuses answers `none`, and `admittedStatus` turns that into this context's stable
 * `turn.invalid-state` refusal — the code and the message are runtime taxonomy, so they
 * stay here, while which moves exist is decided once, in Lean.
 */
export { TurnStatus };
export type TurnTerminalStatus = TerminalOutcome;
export interface TurnCacheLineage {
    readonly turn: TurnId;
    readonly promptPrefix: Digest;
}
export interface TurnInit {
    readonly id: TurnId;
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly startHead: RunCommitId;
    readonly effectiveInput: RunCommitId;
    readonly pins: RunPins;
    readonly placement: Digest;
    readonly input: ContentRef;
    readonly status?: TurnStatus;
    readonly lease?: TurnLease;
    readonly checkpoint?: RunCheckpointId | undefined;
    readonly result?: ContentRef | undefined;
    readonly cacheLineage?: TurnCacheLineage | undefined;
    readonly revision: Revision;
}
export declare class Turn extends CodecRecord {
    static get codec(): RecordCodec<Turn>;
    readonly id: TurnId;
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly startHead: RunCommitId;
    readonly effectiveInput: RunCommitId;
    readonly pins: RunPins;
    readonly placement: Digest;
    readonly input: ContentRef;
    readonly status: TurnStatus;
    readonly lease: TurnLease;
    readonly checkpoint: RunCheckpointId | undefined;
    readonly result: ContentRef | undefined;
    readonly cacheLineage: TurnCacheLineage | undefined;
    readonly revision: Revision;
    constructor(init: TurnInit);
    claim(holder: PrincipalRef, now: Date, expiresAt: Date): Turn;
    renew(token: LeaseToken, now: Date, expiresAt: Date): Turn;
    reclaim(holder: PrincipalRef, now: Date, expiresAt: Date): Turn;
    suspend(token: LeaseToken, checkpoint: RunCheckpointId, now: Date): Turn;
    complete(token: LeaseToken, outcome: TurnTerminalStatus, result: ContentRef, now: Date): Turn;
    cancelUnheld(): Turn;
    forceCancel(): Turn;
    revise(): Turn;
    requireToken(token: LeaseToken, now: Date): void;
    toData(): JsonValue;
    static fromData(value: JsonValue): Turn;
    private transition;
}
export declare function turnContentRetention(value: Turn): readonly ContentRetentionField[];
export declare const TurnCodec: RecordCodec<Turn>;
export declare class RunCheckpoint extends CodecRecord {
    readonly id: RunCheckpointId;
    readonly turn: TurnId;
    readonly commit: RunCommitId;
    readonly state: ContentRef;
    readonly inboxCursor: number;
    readonly tree: ContentRef | undefined;
    static get codec(): RecordCodec<RunCheckpoint>;
    constructor(id: RunCheckpointId, turn: TurnId, commit: RunCommitId, state: ContentRef, inboxCursor: number, tree: ContentRef | undefined);
    toData(): JsonValue;
    static fromData(value: JsonValue): RunCheckpoint;
}
export declare function runCheckpointContentRetention(value: RunCheckpoint): readonly ContentRetentionField[];
export declare const RunCheckpointCodec: RecordCodec<RunCheckpoint>;
export declare class TurnInboxEntry extends CodecRecord {
    #private;
    readonly id: TurnInboxEntryId;
    readonly turn: TurnId;
    readonly sequence: number;
    readonly event: string;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
    readonly idempotencyKey: string;
    static get codec(): RecordCodec<TurnInboxEntry>;
    constructor(id: TurnInboxEntryId, turn: TurnId, sequence: number, event: string, payload: ContentRef, payloadDigest: Digest, idempotencyKey: string, cancellationToken: LeaseToken | undefined, recordedAt: Date);
    readonly cancellationToken: LeaseToken | undefined;
    get recordedAt(): Date;
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnInboxEntry;
}
export declare function turnInboxEntryContentRetention(value: TurnInboxEntry): readonly ContentRetentionField[];
export declare const TurnInboxEntryCodec: RecordCodec<TurnInboxEntry>;
