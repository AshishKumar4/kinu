import type { ActorRef } from "../actors/index.js";
import { RunBranchId, RunCommitId, RunId, TurnId } from "../agents/index.js";
import { TextId, type Revision } from "../core/index.js";
import type { CurrentLease, ProtocolCommand } from "./dispatcher.js";
import type { CommandEnvelope } from "./envelope.js";
import type { ProtocolCommandExecution, ProtocolValueCodec } from "./registration.js";
export declare const RUN_COMMANDS: Readonly<{
    create: "run.create";
    createBranch: "run.branch.create";
    appendSystem: "run.commit.system";
    appendTurn: "run.commit.turn";
    merge: "run.merge";
    undo: "run.undo";
    migrate: "run.migrate";
    terminalize: "run.terminalize";
    spawn: "run.spawn";
    createTurn: "turn.create";
    claimTurn: "turn.claim";
    renewTurn: "turn.renew";
    reclaimTurn: "turn.reclaim";
    suspendTurn: "turn.suspend";
    completeTurn: "turn.complete";
    cancelHeldTurn: "turn.cancelHeld";
    cancelUnheldTurn: "turn.cancelUnheld";
    deliverTurnEvent: "turn.deliverEvent";
}>;
export type RunProtocolRequest = {
    readonly kind: "createRun";
    readonly run: RunId;
} | {
    readonly kind: "createBranch";
    readonly run: RunId;
    readonly branch: RunBranchId;
} | {
    readonly kind: "appendSystem" | "merge" | "undo" | "migrate";
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly commit: RunCommitId;
} | {
    readonly kind: "appendTurn";
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly commit: RunCommitId;
} | {
    readonly kind: "terminalize";
    readonly run: RunId;
    readonly turn: TurnId;
    readonly commit: RunCommitId;
    readonly outcome: "succeeded" | "failed" | "cancelled";
} | {
    readonly kind: "spawn";
    readonly run: RunId;
    readonly turn: TurnId;
    readonly child: RunId;
    readonly reservation: RunProtocolRecordRef<"spawn">;
} | {
    readonly kind: "createTurn";
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly turn: TurnId;
} | {
    readonly kind: "claimTurn" | "renewTurn" | "reclaimTurn";
    readonly turn: TurnId;
    readonly expiresAt: Date;
} | {
    readonly kind: "suspendTurn";
    readonly turn: TurnId;
    readonly commit: RunCommitId;
} | {
    readonly kind: "completeTurn";
    readonly turn: TurnId;
    readonly commit: RunCommitId;
    readonly outcome: "succeeded" | "failed" | "cancelled";
} | {
    readonly kind: "cancelHeldTurn" | "cancelUnheldTurn";
    readonly turn: TurnId;
} | {
    readonly kind: "deliverTurnEvent";
    readonly turn: TurnId;
    readonly entry: RunProtocolRecordRef<"inbox">;
};
export declare class RunProtocolRecordRef<Kind extends "spawn" | "inbox"> extends TextId {
    readonly recordKind: Kind;
    constructor(recordKind: Kind, value: string);
}
export declare abstract class RunProtocolPort<Transaction, Read, Reply, Observation> {
    abstract readonly replyCodec: ProtocolValueCodec<Reply>;
    abstract readonly observationCodec: ProtocolValueCodec<Observation>;
    abstract authorize(read: Read, envelope: CommandEnvelope, request: RunProtocolRequest): boolean;
    abstract permitsLifecycle(read: Read, request: RunProtocolRequest): boolean;
    abstract currentRevision(read: Read, request: RunProtocolRequest): Revision | undefined;
    abstract currentLease(read: Read, envelope: CommandEnvelope, request: RunProtocolRequest, at: Date): CurrentLease | undefined;
    abstract execute(transaction: Transaction, envelope: CommandEnvelope, request: RunProtocolRequest, at: Date): ProtocolCommandExecution<Reply, Observation>;
}
export declare function createRunProtocolCommands<Transaction, Read, Reply, Observation>(port: RunProtocolPort<Transaction, Read, Reply, Observation>, owner: ActorRef): readonly ProtocolCommand<Transaction, Read, RunProtocolRequest, Reply, Observation>[];
export declare const RunCommandPayload: Readonly<{
    encode(request: RunProtocolRequest): Uint8Array;
}>;
