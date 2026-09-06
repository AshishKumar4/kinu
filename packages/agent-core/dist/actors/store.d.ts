import { ActorRecoveryState } from "./fence.js";
import { ActorRef, type ActorKind, type SynchronousResultGuard, type TransactionOperation, type TransactionalStore } from "./types.js";
export declare const ACTOR_STATE_SNAPSHOT: unique symbol;
type ActorCloneSnapshot = boolean | number | string | null | bigint | symbol | object | undefined;
export interface ActorCloneOwnedState {
    [ACTOR_STATE_SNAPSHOT](): ActorCloneSnapshot;
}
export interface ActorStore<TTransaction> extends TransactionalStore<TTransaction> {
    bindActor(actor: ActorRef): void;
    /**
     * The stable bootstrap record, decoded before any record the Actor itself owns.
     * It never carries a codec declaration: keeping that carrier stable lets an older
     * runtime construct and fence the Actor instead of failing before it can refuse work.
     */
    loadRecoveryState(transaction: TTransaction, actor: ActorRef): ActorRecoveryState | undefined;
    saveRecoveryState(transaction: TTransaction, state: ActorRecoveryState): void;
    /**
     * Raw canonical CodecDeclaration bytes in the separate record-set bootstrap carrier.
     * Stores deliberately do not decode these bytes: Actor decides compatibility before it
     * starts its record-owning work and defers a malformed or future carrier to operations.
     */
    loadRecordSetDeclaration(transaction: TTransaction, actor: ActorRef): Uint8Array | undefined;
    saveRecordSetDeclaration(transaction: TTransaction, actor: ActorRef, declaration: Uint8Array): void;
}
export declare class ActorActivation {
    readonly kind: "created" | "recovered";
    readonly recovery: ActorRecoveryState;
    private constructor();
    static created(recovery: ActorRecoveryState): ActorActivation;
    static recovered(recovery: ActorRecoveryState): ActorActivation;
}
export type ActorStartOperation<TTransaction> = (transaction: TTransaction, activation: ActorActivation) => void;
export interface ActorActivationStore<TTransaction> extends ActorStore<TTransaction> {
    activateActor(actor: ActorRef, start: ActorStartOperation<TTransaction>): ActorRecoveryState;
}
export interface ActorLocalStore<TTransaction, TReadTransaction = TTransaction> extends ActorStore<TTransaction> {
    read<TResult>(transaction: TTransaction, operation: TransactionOperation<TReadTransaction, TResult>, ...guard: SynchronousResultGuard<TResult>): TResult;
}
export interface MemoryActorStoreSnapshot<TState> {
    readonly version: 1 | 2;
    readonly state: TState;
    readonly actor: {
        readonly kind: ActorKind;
        readonly id: string;
    } | null;
    readonly recoveryState: Uint8Array | null;
    readonly recordSetDeclaration?: Uint8Array | null;
}
export declare class MemoryActorStore<TTransaction extends object> implements ActorLocalStore<TTransaction>, ActorActivationStore<TTransaction> {
    #private;
    private readonly clone;
    constructor(value: TTransaction, clone: (value: TTransaction) => TTransaction);
    static restore<TState extends object>(snapshot: MemoryActorStoreSnapshot<TState>, clone: (value: TState) => TState): MemoryActorStore<TState>;
    bindActor(actor: ActorRef): void;
    activateActor(actor: ActorRef, start: ActorStartOperation<TTransaction>): ActorRecoveryState;
    transaction<TResult>(operation: TransactionOperation<TTransaction, TResult>, ..._guard: SynchronousResultGuard<TResult>): TResult;
    read<TResult>(transaction: TTransaction, operation: TransactionOperation<TTransaction, TResult>, ..._guard: SynchronousResultGuard<TResult>): TResult;
    loadRecoveryState(transaction: TTransaction, actor: ActorRef): ActorRecoveryState | undefined;
    saveRecoveryState(transaction: TTransaction, state: ActorRecoveryState): void;
    loadRecordSetDeclaration(transaction: TTransaction, actor: ActorRef): Uint8Array | undefined;
    saveRecordSetDeclaration(transaction: TTransaction, actor: ActorRef, declaration: Uint8Array): void;
    snapshot(): MemoryActorStoreSnapshot<TTransaction>;
    private requireActor;
}
export declare function requireSynchronousResult<TResult>(result: TResult): TResult;
export {};
