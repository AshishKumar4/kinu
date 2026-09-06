import { Digest, Revision, SemVer } from "../core/index.js";
import type { ActorRef } from "../actors/index.js";
import type { RunCommitId } from "../agents/index.js";
import type { AuditRecordId, ReceiptId } from "../invocations/index.js";
import type { PackagePin } from "./package-lock.js";
import type { MaterializationPlan } from "./plan.js";
import { PackagePinHolder, RunPinEvidence } from "./reconciliation.js";
export interface BlueprintPinReference {
    readonly version: SemVer;
    readonly digest: Digest;
}
export interface DefinitionPinSet {
    readonly blueprint: BlueprintPinReference;
    readonly packages: readonly PackagePin[];
}
/**
 * SPEC §5.2: a reservation is held by one of the five pin holders, not by a Run alone. A
 * Turn, an Environment Session, a tree checkpoint, and a Snapshot each pin a release on
 * their own, and a Session and a Snapshot outlive the Run that created them, so the
 * holder is a `PackagePinHolder` rather than the Run's `ActorRef`.
 */
export interface RunPinReservationRequest {
    readonly holder: PackagePinHolder;
    readonly pins: DefinitionPinSet;
    readonly sourceRevision: Revision;
    readonly idempotencyKey: string;
}
export interface RunPinReservationReference {
    readonly id: Digest;
    readonly revision: Revision;
}
export interface RunMigrationEvidenceReference {
    readonly run: ActorRef;
    readonly commitId: RunCommitId;
    readonly receiptId: ReceiptId;
    readonly auditId: AuditRecordId;
    readonly fromPinsDigest: Digest;
    readonly toPinsDigest: Digest;
    readonly revision: Revision;
}
export declare abstract class RunPinsReservationPort<Transaction> {
    abstract reserve(transaction: Transaction, request: RunPinReservationRequest): RunPinReservationReference;
    abstract release(transaction: Transaction, reservation: RunPinReservationReference, migration?: RunMigrationEvidenceReference): boolean;
    abstract removalEvidence(transaction: Transaction, pins: DefinitionPinSet): RunPinEvidence;
    abstract verifyMigration(transaction: Transaction, evidence: RunMigrationEvidenceReference): boolean;
}
export declare abstract class DefinitionSourceRevisionPort<Transaction, Snapshot> {
    abstract verifyDefinitionClosure(transaction: Transaction, snapshot: Snapshot, plan: MaterializationPlan): boolean;
}
export declare class FailClosedRunPinsReservationPort<Transaction> extends RunPinsReservationPort<Transaction> {
    reserve(): RunPinReservationReference;
    release(): boolean;
    removalEvidence(): RunPinEvidence;
    verifyMigration(): boolean;
}
/**
 * SPEC §5.2 and §9.3 retention, held in memory: a Package release stays resolvable while
 * any Run, Turn, Session, tree checkpoint, or Snapshot pins it, and removal proceeds only
 * once the last holder of any kind has released. The evidence names every retaining
 * holder, so a removal defers on a Turn, a Session, a tree checkpoint, or a Snapshot with
 * no Run in the picture at all.
 */
export declare class RecordedRunPinsReservationPort<Transaction> extends RunPinsReservationPort<Transaction> {
    #private;
    reserve(_transaction: Transaction, request: RunPinReservationRequest): RunPinReservationReference;
    release(_transaction: Transaction, reservation: RunPinReservationReference, migration?: RunMigrationEvidenceReference): boolean;
    removalEvidence(_transaction: Transaction, pins: DefinitionPinSet): RunPinEvidence;
    verifyMigration(_transaction: Transaction, evidence: RunMigrationEvidenceReference): boolean;
}
