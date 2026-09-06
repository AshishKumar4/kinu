import { type JsonValue, RecordCodec } from "../../core/index.js";
import { RunCommitId } from "../../execution-references/index.js";
import { ApprovalId, EffectAttemptId } from "../../invocation-references/index.js";
import { InvocationId, RouteReservationId } from "../../interaction-references/index.js";
import { CodecRecord } from "../record-data.js";
import { AcceptanceId, RunId } from "./id.js";
export type RunObligation = {
    readonly kind: "approval";
    readonly approval: ApprovalId;
} | {
    readonly kind: "invocationItem";
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
} | {
    readonly kind: "route";
    readonly reservation: RouteReservationId;
} | {
    readonly kind: "reconciliation";
    readonly attempt: EffectAttemptId;
} | {
    readonly kind: "systemCommit";
    readonly commit: RunCommitId;
} | {
    readonly kind: "acceptance";
    readonly acceptance: AcceptanceId;
};
export interface RunAdmissionReservation {
    readonly run: RunId;
    readonly registryEpoch: number;
    readonly obligation: RunObligation;
}
export interface RunAdmissionRegistryInit {
    readonly run: RunId;
    readonly epoch: number;
    readonly open: boolean;
    readonly reserved: readonly RunObligation[];
    readonly completed: readonly RunObligation[];
}
export interface RunObligationReservation {
    readonly registry: RunAdmissionRegistry;
    readonly reservation: RunAdmissionReservation;
}
export declare class RunAdmissionRegistry extends CodecRecord {
    static get codec(): RecordCodec<RunAdmissionRegistry>;
    readonly run: RunId;
    readonly epoch: number;
    readonly open: boolean;
    readonly reserved: readonly RunObligation[];
    readonly completed: readonly RunObligation[];
    constructor(init: RunAdmissionRegistryInit);
    static initial(run: RunId): RunAdmissionRegistry;
    reserve(obligation: RunObligation): RunObligationReservation;
    accepts(reservation: RunAdmissionReservation): boolean;
    reservation(obligation: RunObligation): RunAdmissionReservation | undefined;
    complete(reservation: RunAdmissionReservation): RunAdmissionRegistry;
    close(): RunAdmissionRegistry;
    frontier(): readonly RunObligation[];
    toData(): JsonValue;
    static fromData(value: JsonValue): RunAdmissionRegistry;
    private completionKey;
}
export declare const RunAdmissionRegistryCodec: RecordCodec<RunAdmissionRegistry>;
export declare abstract class RunAdmissionValidationPort<Transaction> {
    abstract accepts(transaction: Transaction, reservation: RunAdmissionReservation): boolean;
}
export declare function runObligationKey(obligation: RunObligation): string;
export declare function copyRunObligation(obligation: RunObligation): RunObligation;
export declare function runObligationData(obligation: RunObligation): JsonValue;
export declare function decodeRunObligation(value: JsonValue): RunObligation;
