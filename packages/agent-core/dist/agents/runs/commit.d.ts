import { ContentRef, type ContentRetentionField, Digest, type JsonObject, type JsonValue, RecordCodec } from "../../core/index.js";
import { RunCommitId, TurnId } from "../../execution-references/index.js";
import { ReceiptId } from "../../invocation-references/index.js";
import { AuditRecordId, InvocationId, RouteReservationId } from "../../interaction-references/index.js";
import { CodecRecord } from "../record-data.js";
import { RunBranchId, RunId } from "./id.js";
import { type LeaseToken } from "./lease.js";
import { RunPins } from "./pins.js";
import type { RunEvidencePort } from "./evidence.js";
export type SystemCause = {
    readonly kind: "receipt";
    readonly audit: AuditRecordId;
    readonly receipt: ReceiptId;
} | {
    readonly kind: "delivery";
    readonly audit: AuditRecordId;
    readonly reservation: RouteReservationId;
} | {
    readonly kind: "control";
    readonly audit: AuditRecordId;
    readonly receipt: ReceiptId;
};
export interface RunMigration {
    readonly from: RunPins;
    readonly to: RunPins;
}
/** Every Run commit kind, in the order the record vocabulary lists them. */
export declare const RUN_COMMIT_KINDS: readonly ["root", "message", "checkpoint", "invocation", "eventDelivery", "result", "merge", "verdict", "undo", "migration", "rewrite", "modelInput"];
export type RunCommitKind = (typeof RUN_COMMIT_KINDS)[number];
export type CommitWriter = {
    readonly kind: "root";
} | {
    readonly kind: "turn";
    readonly token: LeaseToken;
} | {
    readonly kind: "system";
    readonly cause: SystemCause;
};
export type MergeResolution = {
    readonly kind: "pick";
    readonly parent: RunCommitId;
} | {
    readonly kind: "concat";
} | {
    readonly kind: "synthesize";
    readonly token: LeaseToken;
    readonly receipt: ReceiptId;
};
export type TreeMergeResolution = {
    readonly policy: "ours" | "theirs";
    readonly side: RunCommitId;
    readonly base: ContentRef;
    readonly environment: string;
} | {
    readonly policy: "perPath";
    readonly base: ContentRef;
    readonly environment: string;
    readonly resolutions: readonly PathResolution[];
};
export interface PathResolution {
    readonly path: string;
    readonly side: RunCommitId;
}
/**
 * The two ordered parents of a merge commit (§5.2): the head the merge lands on, and the head
 * of the distinct lineage it joins in. Distinctness is a property of this value rather than a
 * length a later reader measures, so a merge that joins one lineage to itself is not a record
 * a caller can build or a decoder can restore.
 */
export declare class MergeParents {
    readonly target: RunCommitId;
    readonly source: RunCommitId;
    /** The pair in the order the merge declared, which is the commit's own parent list. */
    readonly ordered: readonly RunCommitId[];
    constructor(target: RunCommitId, source: RunCommitId);
}
export interface RunCommitInit {
    readonly id: RunCommitId;
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly kind: RunCommitKind;
    readonly parents: readonly RunCommitId[];
    readonly pins: RunPins;
    readonly writer: CommitWriter;
    readonly subjectTurn?: TurnId | undefined;
    readonly content?: ContentRef | undefined;
    readonly selects?: RunCommitId | undefined;
    /**
     * Rewrite only: the exact commit identities this rewrite removes from the effective
     * transcript, empty when the attempt was abandoned. Identities rather than a span,
     * because once one rewrite exists the commits a second covers are not an interval.
     */
    readonly shadows?: readonly RunCommitId[] | undefined;
    /** Message only: the Invocations this commit's content requests. */
    readonly requests?: readonly InvocationId[] | undefined;
    readonly treeCheckpoint?: ContentRef | undefined;
    readonly resolution?: MergeResolution | undefined;
    readonly treeResolution?: TreeMergeResolution | undefined;
    readonly invocation?: InvocationId | undefined;
    readonly receipt?: ReceiptId | undefined;
    readonly reservation?: RouteReservationId | undefined;
    readonly migration?: RunMigration | undefined;
}
export declare class RunCommit extends CodecRecord {
    static get codec(): RecordCodec<RunCommit>;
    readonly id: RunCommitId;
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly kind: RunCommitKind;
    readonly parents: readonly RunCommitId[];
    /** Present on exactly a merge commit, where it is the record's own parent order. */
    readonly mergeParents: MergeParents | undefined;
    readonly pins: RunPins;
    readonly writer: CommitWriter;
    readonly subjectTurn: TurnId | undefined;
    readonly content: ContentRef | undefined;
    readonly selects: RunCommitId | undefined;
    readonly shadows: readonly RunCommitId[] | undefined;
    readonly requests: readonly InvocationId[] | undefined;
    readonly treeCheckpoint: ContentRef | undefined;
    readonly resolution: MergeResolution | undefined;
    readonly treeResolution: TreeMergeResolution | undefined;
    readonly invocation: InvocationId | undefined;
    readonly receipt: ReceiptId | undefined;
    readonly reservation: RouteReservationId | undefined;
    readonly migration: {
        readonly from: RunPins;
        readonly to: RunPins;
    } | undefined;
    readonly proposalDigest: Digest;
    constructor(init: RunCommitInit);
    isTurnAuthored(kind: RunCommitKind, token: LeaseToken): boolean;
    toData(): JsonValue;
    proposalData(): JsonObject;
    static fromData(value: JsonValue): RunCommit;
}
export declare function runCommitContentRetention(value: RunCommit): readonly ContentRetentionField[];
export declare const RunCommitCodec: RecordCodec<RunCommit>;
export declare function validateCommitWriter<Transaction>(transaction: Transaction, commit: RunCommit, evidence: RunEvidencePort<Transaction>): void;
