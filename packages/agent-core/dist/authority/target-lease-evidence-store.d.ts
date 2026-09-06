import type { ActorRef, SynchronousResultGuard } from "../actors/index.js";
import { RunId, RunStoragePort, Turn, TurnId, TurnLease, type LeaseToken } from "../agents/index.js";
import { Digest } from "../core/index.js";
import type { PrincipalRef, TenantId } from "../identity/index.js";
import { TargetAuthorityPermitRequest } from "./permit-request.js";
import { TargetLeaseEvidence } from "./target-lease-evidence.js";
import type { InvalidationWatermark } from "./epoch.js";
export interface TargetLeaseEvidenceStore<Transaction> {
    readonly owner: ActorRef;
    transaction<Result>(operation: (transaction: Transaction) => Result, ...guard: SynchronousResultGuard<Result>): Result;
    evidence(transaction: Transaction, idempotencyKey: string): TargetLeaseEvidence | undefined;
    record(transaction: Transaction, evidence: TargetLeaseEvidence): TargetLeaseEvidence;
}
/**
 * Source-local facts read in the same Actor transaction that records lease evidence.
 * The source owns these facts; no Tenant projection may substitute for this read.
 */
export interface TargetLeaseEvidenceSourceState {
    readonly run: RunId;
    readonly lease: TurnLease;
    readonly watermark: InvalidationWatermark;
    readonly invocationIntent: Digest;
}
export declare abstract class TargetLeaseEvidenceSourcePort<Transaction> {
    abstract current(transaction: Transaction, source: ActorRef, run: RunId, lease: LeaseToken): TargetLeaseEvidenceSourceState | undefined;
}
/**
 * The canonical owners behind one source Actor's attestation reads. The Turn lease
 * comes from the RunRepository, the holder watermark from the canonical watermark
 * owner, and the delegation intent from the canonical intent owner — an adapter must
 * read them through this seam inside the recording transaction and must never keep
 * its own mutable copy of any of them.
 */
export interface TargetLeaseEvidenceSourceFacts<Transaction> {
    /** The canonical Turn record behind this id, loaded inside the same transaction. */
    turn(transaction: Transaction, turn: TurnId): Turn | undefined;
    watermark(transaction: Transaction, holder: PrincipalRef): InvalidationWatermark;
    invocationIntent(transaction: Transaction, run: RunId): Digest | undefined;
}
/** The Run-Actor transactional span the evidence records inside. */
export interface TargetLeaseEvidenceSourceRuns<Transaction> {
    transaction<Result>(operation: (transaction: Transaction) => Result, ...guard: SynchronousResultGuard<Result>): Result;
}
export interface TargetLeaseEvidenceSourceStore<Transaction> extends TargetLeaseEvidenceStore<Transaction> {
    readonly tenant: TenantId;
    readonly source: TargetLeaseEvidenceSourcePort<Transaction>;
}
/** Records source-verified immutable evidence in the exact source Actor transaction. */
export declare class TargetLeaseEvidenceIssuer<Transaction> {
    private readonly store;
    private readonly source;
    constructor(store: TargetLeaseEvidenceStore<Transaction>, source: TargetLeaseEvidenceSourcePort<Transaction>);
    attest(transaction: Transaction, request: TargetAuthorityPermitRequest, now: Date): TargetLeaseEvidence | undefined;
    /**
     * A committed record whose response was lost replays unchanged while the exact
     * request still binds it and every live condition held at issuance still holds:
     * the original deadline has not passed, the current lease admits its token even
     * after a same-token renewal, and the current watermark has not invalidated the
     * path. The original deadline is never regenerated — renewal cannot extend an
     * attestation that already exists.
     */
    private replay;
}
/**
 * Immutable target lease evidence persisted through the source Run Actor's own
 * canonical run storage, keyed by idempotency key. The Turn lease, holder
 * watermark, and delegation intent are read only through `facts` — the canonical
 * RunRepository, watermark owner, and intent owner — inside whichever Run-Actor
 * transaction the caller opens on that same storage. One implementation serves
 * every substrate; no substrate keeps its own copy of any source fact.
 */
export declare class RunTargetLeaseEvidenceStore<Transaction extends object> implements TargetLeaseEvidenceSourceStore<Transaction>, TargetLeaseEvidenceSourcePort<Transaction> {
    readonly tenant: TenantId;
    readonly owner: ActorRef;
    private readonly storage;
    private readonly facts;
    constructor(tenant: TenantId, owner: ActorRef, storage: RunStoragePort<Transaction>, facts: TargetLeaseEvidenceSourceFacts<Transaction>);
    /** The read side over this exact owner's canonical source state; the store itself. */
    readonly source: TargetLeaseEvidenceSourcePort<Transaction>;
    transaction<Result>(operation: (transaction: Transaction) => Result, ...guard: SynchronousResultGuard<Result>): Result;
    current(transaction: Transaction, source: ActorRef, run: RunId, token: LeaseToken): TargetLeaseEvidenceSourceState | undefined;
    evidence(transaction: Transaction, idempotencyKey: string): TargetLeaseEvidence | undefined;
    record(transaction: Transaction, evidence: TargetLeaseEvidence): TargetLeaseEvidence;
}
