import type { ActorRef } from "../actors/index.js";
import { Digest, Revision } from "../core/index.js";
import type { FacetRef } from "../facets/index.js";
import type { TenantId } from "../identity/index.js";
import type { InvocationId, RouteReservationId } from "../interaction-references/index.js";
import type { DeploymentId } from "./id.js";
import type { ManagedStateRecord } from "./generation.js";
import type { PackagePin } from "./package-lock.js";
/**
 * SPEC §5.2: every Package release stays resolvable while any Run, Turn, Session, tree
 * checkpoint, or Snapshot pins it. The five are the whole vocabulary and each defers a
 * removal on its own: a Session and a Snapshot outlive the Run that created them, so an
 * implementation that consulted Runs alone would licence a removal §5.2 forbids. The
 * identity stays a canonical token beside its kind because the five holders are records
 * of five different planes; pairing kind with token is what keeps a Turn's pin from being
 * answered by a Run-shaped check.
 */
export type PinHolderKind = "run" | "turn" | "session" | "tree-checkpoint" | "snapshot";
export declare class PackagePinHolder {
    readonly kind: PinHolderKind;
    readonly id: string;
    constructor(kind: PinHolderKind, id: string);
    get key(): string;
    equals(other: PackagePinHolder): boolean;
}
export type PinEvidenceKind = "clear" | "blocked" | "unknown" | "stale" | "partial";
/**
 * What the pin-holding planes answer about one Package release. Three shapes for three
 * answers, because a release nothing pins, a release named holders retain, and a question
 * the integration could not answer have three different consequences: the first proceeds,
 * the second defers as a §9.3 pending obligation naming each holder, and the third is a
 * divergence no obligation expresses — a rejected reconciliation rather than a removal
 * left pending on an unstated reason.
 */
export declare abstract class RunPinEvidence {
    static clear(): RunPinEvidence;
    /** The exact holders retaining the release, which is why the removal defers. */
    static retained(holders: readonly PackagePinHolder[]): RunPinEvidence;
    /** An answer the integration could not complete, which states no obligation at all. */
    static inconclusive(kind: Exclude<PinEvidenceKind, "clear" | "blocked">, reason: string): RunPinEvidence;
    abstract get kind(): PinEvidenceKind;
    abstract get holders(): readonly PackagePinHolder[];
    /** Whether this answer decides the question at all, either way. */
    abstract get conclusive(): boolean;
    get permitsChange(): boolean;
    /**
     * SPEC §9.3: the deferral this evidence states for one held managed record. Retained
     * evidence becomes one obligation per holder, so each of the five holders defers the
     * removal on its own.
     */
    abstract deferral(held: DeferredManagedRecord, release: PackagePin): ReconciliationDeferral;
}
export interface ManagedResourceOwner {
    readonly tenantId: TenantId;
    readonly deploymentId: DeploymentId;
    readonly actor: ActorRef;
}
export interface ManagedResourceSnapshot extends ManagedResourceOwner {
    readonly resourceId: Digest;
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desiredDigest: Digest;
    readonly revision: Revision;
}
export type ManagedResourceChange = {
    readonly kind: "update";
    readonly current: ManagedResourceSnapshot;
    readonly desired: ManagedStateRecord;
} | {
    readonly kind: "remove";
    readonly current: ManagedResourceSnapshot;
};
/**
 * SPEC §9.3: the exact Blueprint-managed record a deferral holds, and the change held
 * there. Every obligation names one, because the record it holds is the first of the
 * three facts a pending obligation states.
 */
export declare class DeferredManagedRecord {
    readonly resourceId: Digest;
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly change: ManagedResourceChange["kind"];
    constructor(change: ManagedResourceChange);
    get key(): string;
}
/**
 * SPEC §9.3 states four deferrals and no others, each with its own discharging condition,
 * so this set is closed: a host that would need a fifth has a divergence it cannot express
 * as a pending obligation, which is a rejected reconciliation rather than a new case here.
 */
export type ReconciliationObligationKind = "reliance" | "drain" | "reservation" | "retention";
export declare abstract class ReconciliationObligation {
    readonly held: DeferredManagedRecord;
    protected constructor(held: DeferredManagedRecord);
    abstract get kind(): ReconciliationObligationKind;
    /** The exact record this obligation waits on. */
    abstract get record(): string;
    /** The exact reason the change is held. */
    abstract get reason(): string;
    /** The exact condition that discharges it. */
    abstract get condition(): string;
    get key(): string;
}
/** SPEC §4.1, §9.3: a withdrawal held by the reliance guard. */
export declare class RelianceHoldObligation extends ReconciliationObligation {
    readonly dependent: FacetRef;
    constructor(held: DeferredManagedRecord, dependent: FacetRef);
    get kind(): "reliance";
    get record(): string;
    get reason(): string;
    get condition(): string;
}
/** SPEC §4.1, §9.3: one admitted Invocation item draining against a withdrawing Facet. */
export declare class InvocationDrainObligation extends ReconciliationObligation {
    readonly item: InvocationId;
    constructor(held: DeferredManagedRecord, item: InvocationId);
    get kind(): "drain";
    get record(): string;
    get reason(): string;
    get condition(): string;
}
/** SPEC §4.1, §6.2, §9.3: one RouteReservation a retired Subscription leaves unadmitted. */
export declare class RouteReservationObligation extends ReconciliationObligation {
    readonly reservation: RouteReservationId;
    constructor(held: DeferredManagedRecord, reservation: RouteReservationId);
    get kind(): "reservation";
    get record(): string;
    get reason(): string;
    get condition(): string;
}
/** SPEC §5.2, §9.3: a Package release one named pin holder retains. */
export declare class PackageRetentionObligation extends ReconciliationObligation {
    readonly release: PackagePin;
    readonly holder: PackagePinHolder;
    constructor(held: DeferredManagedRecord, release: PackagePin, holder: PackagePinHolder);
    get kind(): "retention";
    get record(): string;
    get reason(): string;
    get condition(): string;
    /**
     * SPEC §5.2 lists five holders and each retains the release on its own, so two holders
     * of one release are two pending obligations rather than one obligation deduplicated
     * down to whichever holder was seen first.
     */
    get key(): string;
}
/**
 * SPEC §9.3: what a managed-resource owner answers about one change. Clear proceeds,
 * holding defers under named obligations, and unanswerable is the divergence a host cannot
 * express — which `planReconciliation` rejects rather than admitting as pending work.
 */
export declare abstract class ReconciliationDeferral {
    static clear(): ReconciliationDeferral;
    static holding(obligations: readonly ReconciliationObligation[]): ReconciliationDeferral;
    static unanswerable(reason: string): ReconciliationDeferral;
    abstract get obligations(): readonly ReconciliationObligation[];
    /** Whether the owner could state the pending set at all. */
    abstract get answerable(): boolean;
    abstract get reason(): string | undefined;
}
/**
 * SPEC §9.3: the pending set a reconciliation outcome carries. Convergence is that set
 * being empty and is derived here rather than reported beside it, so no host states a
 * converged Scope while an obligation stands.
 */
export declare class PendingObligationSet {
    static get empty(): PendingObligationSet;
    readonly obligations: readonly ReconciliationObligation[];
    constructor(obligations: readonly ReconciliationObligation[]);
    get converged(): boolean;
    ofKind(kind: ReconciliationObligationKind): readonly ReconciliationObligation[];
}
export declare abstract class ManagedResourcePort<Transaction> {
    abstract get(transaction: Transaction, resourceId: Digest): ManagedResourceSnapshot | undefined;
    abstract list(transaction: Transaction, owner: ManagedResourceOwner): readonly ManagedResourceSnapshot[];
    /**
     * SPEC §9.3: the deferrals this owner states for one change, each naming its record,
     * reason, and discharging condition.
     */
    abstract deferrals(transaction: Transaction, change: ManagedResourceChange): ReconciliationDeferral;
    abstract create(transaction: Transaction, desired: ManagedStateRecord): ManagedResourceSnapshot;
    abstract update(transaction: Transaction, current: ManagedResourceSnapshot, desired: ManagedStateRecord): ManagedResourceSnapshot;
    abstract remove(transaction: Transaction, current: ManagedResourceSnapshot): void;
}
export type ReconciliationAction = {
    readonly kind: "create";
    readonly desired: ManagedStateRecord;
} | {
    readonly kind: "adopt";
    readonly current: ManagedResourceSnapshot;
    readonly desired: ManagedStateRecord;
} | {
    readonly kind: "update";
    readonly current: ManagedResourceSnapshot;
    readonly desired: ManagedStateRecord;
} | {
    readonly kind: "remove";
    readonly current: ManagedResourceSnapshot;
} | {
    readonly kind: "noop";
    readonly current: ManagedResourceSnapshot;
    readonly desired: ManagedStateRecord;
};
/**
 * SPEC §9.3: one manually created resource the operator explicitly adopted. A manual edit
 * is adopted only as a change to the Blueprint, so the adopted record names the declaring
 * record's identity and the exact state the operator inspected; an adoption the desired
 * generation does not declare would mark an unattributed record Blueprint-managed and is
 * rejected instead.
 */
export declare class AdoptedManagedRecord {
    readonly resourceId: Digest;
    readonly observed: Digest;
    constructor(resourceId: Digest, observed: Digest);
}
/**
 * SPEC §9.3: the reconciliation outcome. It carries its own pending set, so `converged` is
 * that set being empty rather than a second answer a host supplies beside it.
 */
export declare class ReconciliationPlan {
    readonly pending: PendingObligationSet;
    readonly actions: readonly ReconciliationAction[];
    constructor(actions: readonly ReconciliationAction[], pending: PendingObligationSet);
    get converged(): boolean;
}
export declare function planReconciliation<Transaction>(transaction: Transaction, resources: ManagedResourcePort<Transaction>, owner: ManagedResourceOwner, previous: readonly ManagedStateRecord[], desired: readonly ManagedStateRecord[], adoptions?: readonly AdoptedManagedRecord[]): ReconciliationPlan;
export declare function applyReconciliation<Transaction>(transaction: Transaction, resources: ManagedResourcePort<Transaction>, plan: ReconciliationPlan): void;
