import { type ActorActivationStore, type ActorLocalStore, type ActorRecoveryState, type ActorRef, type ActorStartOperation, type SynchronousResultGuard, type TransactionOperation } from "../actors/index.js";
import type { TargetLeaseEvidence, TargetLeaseEvidenceReference } from "./target-lease-evidence.js";
import type { AuthorityPermit } from "./permit.js";
import { type AuthorityPermitIssueStore, type MemoryAuthorityPermitSnapshot } from "./permit-store.js";
import { type MemoryTenantControlSnapshot } from "./memory.js";
import type { TenantAuthorityReadStore } from "./runtime.js";
export declare abstract class TenantAuthorityTransactionPort<Transaction> {
    abstract authority(transaction: Transaction): TenantAuthorityReadStore;
}
/** One Tenant-owned store spanning current authority reads and durable permit issuance. */
export type TenantAuthorityPermitStore<Transaction> = TenantAuthorityTransactionPort<Transaction> & AuthorityPermitIssueStore<Transaction>;
export interface MemoryTenantAuthorityPermitState<State> {
    authority(state: State): MemoryTenantControlSnapshot;
    permits(state: State): MemoryAuthorityPermitSnapshot;
    savePermits(state: State, snapshot: MemoryAuthorityPermitSnapshot): void;
}
/** Reference adapter keeping authority reads and permit writes in one Memory Actor span. */
export declare class MemoryTenantAuthorityPermitStore<State extends object> extends TenantAuthorityTransactionPort<State> implements ActorLocalStore<State>, ActorActivationStore<State>, AuthorityPermitIssueStore<State> {
    private readonly actors;
    readonly owner: ActorRef;
    private readonly state;
    constructor(actors: ActorLocalStore<State> & ActorActivationStore<State>, owner: ActorRef, state: MemoryTenantAuthorityPermitState<State>);
    bindActor(actor: ActorRef): void;
    activateActor(actor: ActorRef, start: ActorStartOperation<State>): ActorRecoveryState;
    loadRecoveryState(state: State, actor: ActorRef): ActorRecoveryState | undefined;
    saveRecoveryState(state: State, recovery: ActorRecoveryState): void;
    loadRecordSetDeclaration(state: State, actor: ActorRef): Uint8Array | undefined;
    saveRecordSetDeclaration(state: State, actor: ActorRef, declaration: Uint8Array): void;
    transaction<Result>(operation: TransactionOperation<State, Result>, ...guard: SynchronousResultGuard<Result>): Result;
    read<Result>(transaction: State, operation: TransactionOperation<State, Result>, ...guard: SynchronousResultGuard<Result>): Result;
    authority(transaction: State): TenantAuthorityReadStore;
    issued(transaction: State, nonce: string): AuthorityPermit | undefined;
    issue(transaction: State, permit: AuthorityPermit): AuthorityPermit;
    projectedEvidence(transaction: State, reference: TargetLeaseEvidenceReference): TargetLeaseEvidence | undefined;
    projectEvidence(transaction: State, evidence: TargetLeaseEvidence): TargetLeaseEvidence;
    private readPermits;
    private permitStore;
}
