import { ActorRef, type SynchronousResultGuard, type TransactionOperation } from "../actors/index.js";
import { Digest, RecordCodec, Revision, type JsonValue } from "../core/index.js";
import type { ContributionAttribution } from "../facets/index.js";
import { TenantId } from "../identity/index.js";
import { DeploymentId, DeploymentKey } from "./id.js";
import { ManagedOrigin } from "./origin.js";
import type { FacetInstallFailure } from "./install-outcome.js";
import { ActorPlan, MaterializationPlan } from "./plan.js";
import type { ValidationAttestation } from "./attestation.js";
export interface DeploymentRecordInit {
    readonly id: DeploymentId;
    readonly tenantId: TenantId;
    readonly key: DeploymentKey;
    readonly activePlanId?: Digest;
    readonly pendingRolloutId?: Digest;
    readonly nextGeneration: number;
    readonly revision: Revision;
}
export declare class DeploymentRecord {
    readonly id: DeploymentId;
    readonly tenantId: TenantId;
    readonly key: DeploymentKey;
    readonly activePlanId: Digest | undefined;
    readonly pendingRolloutId: Digest | undefined;
    readonly nextGeneration: number;
    readonly revision: Revision;
    static get codec(): RecordCodec<DeploymentRecord>;
    constructor(id: DeploymentId, tenantId: TenantId, key: DeploymentKey, activePlanId: Digest | undefined, pendingRolloutId: Digest | undefined, nextGeneration: number, revision: Revision);
    static initial(tenantId: TenantId, key: DeploymentKey): DeploymentRecord;
    begin(rolloutId: Digest, generation: number): DeploymentRecord;
    compensate(failedRolloutId: Digest, compensationRolloutId: Digest, generation: number): DeploymentRecord;
    complete(rolloutId: Digest, planId: Digest): DeploymentRecord;
    static encode(record: DeploymentRecord): Uint8Array;
    static decode(bytes: Uint8Array): DeploymentRecord;
    static fromData(value: JsonValue): DeploymentRecord;
    toData(): JsonValue;
}
export interface MaterializationRolloutInit {
    readonly plan: MaterializationPlan;
    readonly previousPlanId?: Digest;
    readonly compensates?: Digest;
    readonly id?: Digest;
}
export declare class MaterializationRollout {
    static get codec(): RecordCodec<MaterializationRollout>;
    readonly id: Digest;
    readonly plan: MaterializationPlan;
    readonly previousPlanId: Digest | undefined;
    readonly compensates: Digest | undefined;
    constructor(init: MaterializationRolloutInit);
    static encode(record: MaterializationRollout): Uint8Array;
    static decode(bytes: Uint8Array): MaterializationRollout;
    static fromData(value: JsonValue): MaterializationRollout;
    toData(): JsonValue;
}
export type OutboxStatus = "pending" | "acknowledged";
export interface MaterializationApplyReceipt {
    readonly outcome: "applied";
    readonly rolloutId: Digest;
    readonly outboxId: Digest;
    readonly actorPlanId: Digest;
    readonly replyDigest: Digest;
}
export declare class MaterializationOutboxEntry {
    readonly rolloutId: Digest;
    readonly target: ActorRef;
    readonly actorPlanId: Digest;
    readonly status: OutboxStatus;
    readonly attempts: number;
    readonly replyDigest: Digest | undefined;
    readonly revision: Revision;
    static get codec(): RecordCodec<MaterializationOutboxEntry>;
    readonly id: Digest;
    readonly idempotencyKey: string;
    constructor(rolloutId: Digest, target: ActorRef, actorPlanId: Digest, status: OutboxStatus, attempts: number, replyDigest: Digest | undefined, revision: Revision, id?: Digest);
    static pending(rolloutId: Digest, plan: ActorPlan): MaterializationOutboxEntry;
    attempted(): MaterializationOutboxEntry;
    acknowledge(replyDigest: Digest): MaterializationOutboxEntry;
    static encode(record: MaterializationOutboxEntry): Uint8Array;
    static decode(bytes: Uint8Array): MaterializationOutboxEntry;
    static fromData(value: JsonValue): MaterializationOutboxEntry;
    toData(): JsonValue;
}
export declare abstract class MaterializationControlStore<Transaction> {
    abstract transaction<Result>(operation: TransactionOperation<Transaction, Result>, ...guard: SynchronousResultGuard<Result>): Result;
    abstract loadDeployment(transaction: Transaction, id: DeploymentId): DeploymentRecord | undefined;
    abstract insertAttestation(transaction: Transaction, attestation: ValidationAttestation): void;
    abstract loadAttestation(transaction: Transaction, id: Digest): ValidationAttestation | undefined;
    abstract compareAndSetDeployment(transaction: Transaction, expected: Revision | undefined, deployment: DeploymentRecord): boolean;
    abstract insertRollout(transaction: Transaction, rollout: MaterializationRollout): void;
    abstract loadRollout(transaction: Transaction, id: Digest): MaterializationRollout | undefined;
    abstract loadPlan(transaction: Transaction, id: Digest): MaterializationPlan | undefined;
    abstract insertOutbox(transaction: Transaction, entry: MaterializationOutboxEntry): void;
    abstract loadOutbox(transaction: Transaction, id: Digest): MaterializationOutboxEntry | undefined;
    abstract listOutbox(transaction: Transaction, rolloutId: Digest): readonly MaterializationOutboxEntry[];
    abstract compareAndSetOutbox(transaction: Transaction, expected: Revision, entry: MaterializationOutboxEntry): boolean;
    abstract insertInstallFailure(transaction: Transaction, failure: FacetInstallFailure): void;
    /**
     * SPEC §4.1: every recorded failed install of exactly this contribution, in canonical
     * id order. The caller compares each against the `ManagedOrigin` it is about to install
     * under, because only an unchanged Scope refuses a retry.
     */
    abstract listInstallFailures(transaction: Transaction, attribution: ContributionAttribution): readonly FacetInstallFailure[];
}
export declare abstract class MaterializationPlanAdmissionPort {
    abstract permits(plan: MaterializationPlan, attestation: ValidationAttestation): boolean;
}
export declare class MaterializationRolloutController<Transaction> {
    private readonly store;
    private readonly admission;
    constructor(store: MaterializationControlStore<Transaction>, admission: MaterializationPlanAdmissionPort);
    begin(plan: MaterializationPlan, key: DeploymentKey, previous?: MaterializationPlan, compensates?: Digest, attestation?: ValidationAttestation): MaterializationRollout;
    acknowledge(entryId: Digest, receipt: MaterializationApplyReceipt): MaterializationOutboxEntry;
    complete(rolloutId: Digest): DeploymentRecord;
}
export declare function requirePlanAttestation(plan: MaterializationPlan, attestation: ValidationAttestation): void;
export declare function expectedOutboxEntries(rollout: MaterializationRollout): readonly MaterializationOutboxEntry[];
export declare function requireExactOutboxClosure(rollout: MaterializationRollout, entries: readonly MaterializationOutboxEntry[]): void;
export declare function isLegalOutboxTransition(current: MaterializationOutboxEntry, next: MaterializationOutboxEntry): boolean;
export declare function isLegalDeploymentTransition(current: DeploymentRecord | undefined, next: DeploymentRecord): boolean;
export declare function forwardRollbackPlan(active: MaterializationPlan, failed: MaterializationPlan, origin: ManagedOrigin): MaterializationPlan;
