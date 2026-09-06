import { DetachedEffectExecution, type DetachedEffectExecutionPersistence, type EffectAttemptId } from "../../../invocations/index.js";
import { TransactionalSqlite } from "../sqlite.js";
/**
 * The SQLite store for detached execution records (§8.4's substrate implementation of one
 * Invocation-owned seam).
 *
 * The table is added rather than folded into the existing invocation tables: the record has no
 * reference type parameters, so it needs no projection callbacks, and no existing table's shape
 * changes. One row per EffectAttempt is the whole concurrency rule — an attempt is detached at
 * most once — so the primary key states it instead of a check in application code, and the
 * stored revision makes an out-of-order transition a refusal rather than a last write that
 * wins.
 */
export declare class SqliteDetachedEffectExecutionPersistence implements DetachedEffectExecutionPersistence<TransactionalSqlite> {
    constructor(database: TransactionalSqlite);
    detachedExecution(transaction: TransactionalSqlite, attempt: EffectAttemptId): DetachedEffectExecution | undefined;
    releasedDetachedExecutions(transaction: TransactionalSqlite, limit: number): readonly DetachedEffectExecution[];
    appendDetachedExecution(transaction: TransactionalSqlite, record: DetachedEffectExecution): void;
}
