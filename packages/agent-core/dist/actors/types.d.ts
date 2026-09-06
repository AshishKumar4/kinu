import { type ActorId } from "./id.js";
export type ActorKind = "tenant" | "workspace" | "run" | "environment" | "slate";
export declare class ActorRef {
    readonly kind: ActorKind;
    readonly id: ActorId;
    constructor(kind: ActorKind, id: ActorId);
    equals(other: ActorRef): boolean;
}
export declare class ActorFence {
    readonly actor: ActorRef;
    readonly epoch: number;
    constructor(actor: ActorRef, epoch: number);
    matches(actor: ActorRef, epoch: number): boolean;
}
export type TransactionOperation<TTransaction, TResult> = (transaction: TTransaction) => TResult;
export type ActorCommand<TTransaction, TResult> = TransactionOperation<TTransaction, TResult>;
export type SynchronousResultGuard<TResult> = [Extract<TResult, PromiseLike<unknown>>] extends [
    never
] ? [] : [error: "Actor transaction callbacks must be synchronous"];
export interface TransactionalStore<TTransaction> {
    transaction<TResult>(operation: TransactionOperation<TTransaction, TResult>, ...guard: SynchronousResultGuard<TResult>): TResult;
}
