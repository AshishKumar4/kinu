import { type JsonValue, RecordCodec } from "../../core/index.js";
import { RunCommitId, TurnId } from "../../execution-references/index.js";
import { ApprovalId, EffectAttemptId } from "../../invocation-references/index.js";
import { InvocationId, RouteReservationId } from "../../interaction-references/index.js";
import { CodecRecord } from "../record-data.js";
import { type RunObligation } from "./admission.js";
import { type ResourceDimension } from "./ceiling.js";
import { AcceptanceId, RunId } from "./id.js";
import { type TerminalOutcome } from "./outcome.js";
/**
 * The audit one captured obligation implies (SPEC §5.6).
 *
 * SPEC declares this as `{ audit: AuditRecordId; evidence: … }` with the receipt case naming
 * a `ReceiptId`. Neither identity is carriable here, and §5.6 is what says so: the captured
 * set is "admitted Invocation items *without* a terminal current Receipt", and "Receipt,
 * delivery, projection, and Audit ids are never reserved" — so at capture there is no
 * Receipt to name and no AuditRecord to point at. The obligation is precisely the demand
 * that one come to exist; §5.6's own derivation rule ("**Settled** is derived, never
 * assigned") is discharged by resolving it against the port when evidence arrives, which is
 * what `AgentCore.ObligationDischarged` quantifies over rather than stores.
 *
 * What the capture *can* name is the reserved identity §5.6 hands it — "InvocationId plus
 * item index and item key" — and that identity fixes the item whose current Receipt the
 * audit must reach. The commit case carries SPEC's own field name.
 */
export type SettlementAuditObligation = {
    readonly kind: "receipt";
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
} | {
    readonly kind: "delivery";
    readonly reservation: RouteReservationId;
} | {
    readonly kind: "commit";
    readonly id: RunCommitId;
};
export interface SettlementObligationInit {
    readonly registryEpoch: number;
    readonly obligations: readonly RunObligation[];
}
export declare class SettlementObligation extends CodecRecord {
    static get codec(): RecordCodec<SettlementObligation>;
    readonly registryEpoch: number;
    readonly obligations: readonly RunObligation[];
    readonly requiredAudits: readonly SettlementAuditObligation[];
    constructor(init: SettlementObligationInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): SettlementObligation;
}
export declare const SettlementObligationCodec: RecordCodec<SettlementObligation>;
export type RunOutcome = TerminalOutcome;
export declare class TerminalSnapshot extends CodecRecord {
    #private;
    readonly run: RunId;
    readonly turn: TurnId;
    readonly preterminal: RunCommitId;
    readonly terminalCommit: RunCommitId;
    readonly outcome: RunOutcome;
    readonly obligation: SettlementObligation;
    readonly exhausted: ResourceDimension | undefined;
    static get codec(): RecordCodec<TerminalSnapshot>;
    constructor(run: RunId, turn: TurnId, preterminal: RunCommitId, terminalCommit: RunCommitId, outcome: RunOutcome, obligation: SettlementObligation, recordedAt: Date, exhausted?: ResourceDimension | undefined);
    get recordedAt(): Date;
    toData(): JsonValue;
    static fromData(value: JsonValue): TerminalSnapshot;
}
export declare const TerminalSnapshotCodec: RecordCodec<TerminalSnapshot>;
export declare abstract class SettlementEvidencePort<Transaction> {
    abstract approvalResolved(transaction: Transaction, approval: ApprovalId): boolean;
    abstract invocationItemTerminal(transaction: Transaction, invocation: InvocationId, itemIndex: number, itemKey: string): boolean;
    abstract routeTerminal(transaction: Transaction, route: RouteReservationId): boolean;
    abstract reconciliationSuperseded(transaction: Transaction, attempt: EffectAttemptId): boolean;
    abstract commitExists(transaction: Transaction, commit: RunCommitId): boolean;
    abstract acceptanceSatisfied(transaction: Transaction, acceptance: AcceptanceId): boolean;
    abstract auditSatisfied(transaction: Transaction, obligation: SettlementAuditObligation): boolean;
}
export declare function isSettled<Transaction>(transaction: Transaction, obligation: SettlementObligation, evidence: SettlementEvidencePort<Transaction>): boolean;
