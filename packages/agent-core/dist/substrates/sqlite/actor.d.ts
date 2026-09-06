import { ActorRef, ActorRecoveryState, type ActorLocalStore, type ActorStartOperation, type SynchronousResultGuard, type TransactionOperation } from "../../actors/index.js";
import { ReadableSqlite, TransactionalSqlite } from "./sqlite.js";
export declare function isActiveSqliteActorTransaction(transaction: TransactionalSqlite): boolean;
export declare class SqliteActorStore implements ActorLocalStore<TransactionalSqlite, ReadableSqlite> {
    #private;
    private readonly database;
    constructor(database: TransactionalSqlite);
    bindActor(actor: ActorRef): void;
    activateActor(actor: ActorRef, start: ActorStartOperation<TransactionalSqlite>): ActorRecoveryState;
    transaction<TResult>(operation: TransactionOperation<TransactionalSqlite, TResult>, ..._guard: SynchronousResultGuard<TResult>): TResult;
    /** Runtime-guarded form for ports whose interface cannot express the conditional tuple. */
    transact<TResult>(operation: TransactionOperation<TransactionalSqlite, TResult>): TResult;
    read<TResult>(transaction: TransactionalSqlite, operation: TransactionOperation<ReadableSqlite, TResult>, ..._guard: SynchronousResultGuard<TResult>): TResult;
    loadRecoveryState(transaction: TransactionalSqlite, actor: ActorRef): ActorRecoveryState | undefined;
    saveRecoveryState(transaction: TransactionalSqlite, state: ActorRecoveryState): void;
    loadRecordSetDeclaration(transaction: TransactionalSqlite, actor: ActorRef): Uint8Array | undefined;
    saveRecordSetDeclaration(transaction: TransactionalSqlite, actor: ActorRef, declaration: Uint8Array): void;
    private requireBoundActor;
    private bindIdentity;
    private storedIdentity;
    private requireActiveTransaction;
}
