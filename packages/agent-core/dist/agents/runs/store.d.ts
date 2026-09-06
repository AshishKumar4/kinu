import type { ActorRef, SynchronousResultGuard } from "../../actors/index.js";
import { CodecRecord } from "../record-data.js";
import { ContentOwnerEdge, ContentStore } from "../../content/index.js";
import { CodecDeclaration, Revision, type Digest, RecordCodec, type JsonValue, type JsonObject } from "../../core/index.js";
import type { TenantId } from "../../identity/index.js";
import { AcceptanceCriterion, AcceptanceVerdict } from "./acceptance.js";
import { RunCommit } from "./commit.js";
import { RunConfigurationSnapshot } from "./pins.js";
import { Run, RunBranch } from "./run.js";
import { RunCheckpoint, Turn, TurnInboxEntry } from "./turn.js";
import { TurnPlacementSnapshot } from "./placement.js";
import { SpawnReservation } from "./spawn.js";
import type { AcceptanceId, RunBranchId, RunCheckpointId, RunId, SpawnReservationId, TurnInboxEntryId } from "./id.js";
import type { RunCommitId, TurnId } from "../../execution-references/index.js";
import { RunAdmissionRegistry } from "./admission.js";
import { ForcedTurnCancellation } from "./forced-cancellation.js";
import type { LeaseToken } from "./lease.js";
export interface RunExecutionScope {
    readonly run: Run;
    readonly turn: Turn;
    readonly branch: RunBranch;
    readonly head: RunCommit;
    readonly effectiveCommit: RunCommit;
    readonly placement: TurnPlacementSnapshot;
    readonly checkpoint: RunCheckpoint | undefined;
}
export declare const RUN_RECORD_KINDS: readonly ["configuration", "run", "branch", "commit", "turn", "placement", "checkpoint", "inbox", "spawn", "admission", "forcedCancellation", "acceptance", "verdict", "targetLeaseEvidence"];
export type RunRecordKind = (typeof RUN_RECORD_KINDS)[number];
declare class OpaqueRunTransaction {
    #private;
    constructor();
}
export type RunTransaction = OpaqueRunTransaction;
export interface StoredRunRecord {
    readonly kind: RunRecordKind;
    readonly key: string;
    readonly revision: number | null;
    readonly bytes: Uint8Array;
}
export interface StoredRunParent {
    readonly commit: string;
    readonly ordinal: number;
    readonly parent: string;
}
interface RunStorageBackend<Transaction> {
    transaction<Result>(operation: (transaction: Transaction) => Result, ...guard: SynchronousResultGuard<Result>): Result;
    get(transaction: Transaction, kind: RunRecordKind, key: string): StoredRunRecord | undefined;
    list(transaction: Transaction, kind: RunRecordKind): readonly StoredRunRecord[];
    validate(record: StoredRunRecord): void;
    poison(transaction: Transaction, failure: Error): never;
    insert(transaction: Transaction, record: StoredRunRecord): void;
    replace(transaction: Transaction, record: StoredRunRecord, expectedRevision: number): void;
    insertParent(transaction: Transaction, edge: StoredRunParent): void;
    parents(transaction: Transaction, commit: string): readonly StoredRunParent[];
    retain(transaction: Transaction, edge: ContentOwnerEdge, operationAt: Date): void;
    release(transaction: Transaction, edge: ContentOwnerEdge, operationAt: Date): void;
    verify(transaction: Transaction, ownerPrefixes: readonly string[], expected: readonly ContentOwnerEdge[]): void;
}
export declare function ownRunStorageBackend<Transaction>(backend: RunStorageBackend<Transaction>): RunStorageBackend<Transaction>;
export declare abstract class RunStoragePort<Transaction> {
    #private;
    readonly tenant: TenantId;
    readonly owner: ActorRef;
    readonly content: ContentStore;
    protected constructor(tenant: TenantId, owner: ActorRef, content: ContentStore, backend: RunStorageBackend<Transaction>, clock?: () => Date);
    protected static createTransaction(): RunTransaction;
    transaction<Result>(operation: (transaction: Transaction) => Result, ...guard: SynchronousResultGuard<Result>): Result;
    get(transaction: Transaction, kind: RunRecordKind, key: string): StoredRunRecord | undefined;
    list(transaction: Transaction, kind: RunRecordKind): readonly StoredRunRecord[];
    insert(transaction: Transaction, record: StoredRunRecord): void;
    replace(transaction: Transaction, record: StoredRunRecord, expectedRevision: number): void;
    insertParent(transaction: Transaction, edge: StoredRunParent): void;
    parents(transaction: Transaction, commit: string): readonly StoredRunParent[];
    private verifyContentCustody;
    private mutate;
    private reconcileContentCustody;
}
export declare class RunRepository<Transaction> {
    readonly storage: RunStoragePort<Transaction>;
    constructor(storage: RunStoragePort<Transaction>);
    get content(): ContentStore;
    transaction<Result>(operation: (transaction: Transaction) => Result, ...guard: SynchronousResultGuard<Result>): Result;
    loadExecutionScope(tx: Transaction, token: LeaseToken, now: Date): RunExecutionScope;
    insertConfiguration(tx: Transaction, value: RunConfigurationSnapshot): void;
    loadConfiguration(tx: Transaction, key: string): RunConfigurationSnapshot | undefined;
    insertRun(tx: Transaction, value: Run): void;
    replaceRun(tx: Transaction, expected: Revision, value: Run): void;
    loadRun(tx: Transaction, id: RunId): Run | undefined;
    listRuns(tx: Transaction): readonly Run[];
    insertBranch(tx: Transaction, value: RunBranch): void;
    replaceBranch(tx: Transaction, expected: Revision, value: RunBranch): void;
    loadBranch(tx: Transaction, id: RunBranchId): RunBranch | undefined;
    listBranches(tx: Transaction): readonly RunBranch[];
    insertCommit(tx: Transaction, value: RunCommit): void;
    loadCommit(tx: Transaction, id: RunCommitId): RunCommit | undefined;
    listCommits(tx: Transaction): readonly RunCommit[];
    insertTurn(tx: Transaction, value: Turn): void;
    replaceTurn(tx: Transaction, expected: Revision, value: Turn): void;
    loadTurn(tx: Transaction, id: TurnId): Turn | undefined;
    listTurns(tx: Transaction): readonly Turn[];
    insertPlacement(tx: Transaction, value: TurnPlacementSnapshot): void;
    loadPlacement(tx: Transaction, id: TurnId): TurnPlacementSnapshot | undefined;
    insertCheckpoint(tx: Transaction, value: RunCheckpoint): void;
    loadCheckpoint(tx: Transaction, id: RunCheckpointId): RunCheckpoint | undefined;
    insertInbox(tx: Transaction, value: TurnInboxEntry): void;
    loadInbox(tx: Transaction, id: TurnInboxEntryId): TurnInboxEntry | undefined;
    listInbox(tx: Transaction, turn: TurnId): readonly TurnInboxEntry[];
    insertSpawn(tx: Transaction, value: SpawnReservation): void;
    loadSpawn(tx: Transaction, id: SpawnReservationId): SpawnReservation | undefined;
    loadSpawnForChild(tx: Transaction, child: RunId): SpawnReservation | undefined;
    insertAdmission(tx: Transaction, value: RunAdmissionRegistry): void;
    replaceAdmission(tx: Transaction, expected: RunAdmissionRegistry, value: RunAdmissionRegistry): void;
    loadAdmission(tx: Transaction, id: RunId): RunAdmissionRegistry | undefined;
    insertForcedCancellation(tx: Transaction, value: ForcedTurnCancellation): void;
    loadForcedCancellation(tx: Transaction, turn: TurnId): ForcedTurnCancellation | undefined;
    listForcedCancellations(tx: Transaction, run: RunId): readonly ForcedTurnCancellation[];
    insertAcceptanceCriterion(tx: Transaction, value: AcceptanceCriterion): void;
    loadAcceptanceCriterion(tx: Transaction, id: AcceptanceId): AcceptanceCriterion | undefined;
    insertAcceptanceVerdict(tx: Transaction, value: AcceptanceVerdict): void;
    loadAcceptanceVerdict(tx: Transaction, acceptance: AcceptanceId, subject: Digest): AcceptanceVerdict | undefined;
    isAncestor(tx: Transaction, ancestor: RunCommitId, descendant: RunCommitId): boolean;
    private insert;
    private replace;
    private load;
    private list;
    private validateParents;
}
/**
 * One immutable target lease attestation stored under its idempotency key. The
 * canonical bytes are opaque to the runs plane: the authority plane owns their
 * shape, the runs plane owns the durable, co-transacted storage.
 */
export declare class TargetLeaseEvidenceRecord extends CodecRecord {
    readonly key: string;
    readonly evidence: string;
    constructor(init: {
        readonly key: string;
        readonly evidence: string;
    });
    static get codec(): RecordCodec<TargetLeaseEvidenceRecord>;
    toData(): JsonObject;
    static fromData(payload: JsonValue): TargetLeaseEvidenceRecord;
}
export declare const targetLeaseEvidenceRecordCodec: RecordCodec<TargetLeaseEvidenceRecord>;
/**
 * The record set a Run protocol command's execution writes, at the codec versions this
 * build writes them under (§8.3). It is derived from the same descriptor table the storage
 * reads and writes through, so a codec major that moves here moves in exactly one place and
 * a reader compares against the set it will actually decode.
 */
export declare const RUN_RECORD_CODECS: CodecDeclaration;
export {};
