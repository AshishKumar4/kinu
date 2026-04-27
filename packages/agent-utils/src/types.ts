// ---------------------------------------------------------------------------
// Core types for @cf-utils/agent-utils
// ---------------------------------------------------------------------------

/** Primitive types accepted by Durable Object SQL. */
export type SqlValue = string | number | boolean | null | ArrayBuffer;

/**
 * Tagged-template SQL executor compatible with the Agents SDK `Agent.sql`.
 *
 * Obtain from any Agent subclass via `this.sql.bind(this) as SqlExecutor`.
 */
export interface SqlExecutor {
	<T = unknown>(query: TemplateStringsArray, ...values: SqlValue[]): T[];
}

/**
 * SqlExecutor augmented with `transactionSync` from `DurableObjectStorage`.
 *
 * Use this for stores that need atomic multi-statement SQL operations.
 * Build in any Agent subclass via:
 * ```ts
 * const sql = Object.assign(this.sql.bind(this), {
 *     transactionSync: this.ctx.storage.transactionSync.bind(this.ctx.storage),
 * }) as TransactionalSql;
 * ```
 */
export type TransactionalSql = SqlExecutor & {
	readonly transactionSync: <T>(fn: () => T) => T;
};

/** Row type that includes both typed columns and raw SQL values. */
export type SqlRow<T> = T & Record<string, SqlValue>;

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface WorkspaceTask {
	id: string;
	ticketNumber: number | null;
	parentId: string | null;
	title: string;
	description: string;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
}

export const TASK_PROMPT_MAX_CHARS = 4000;
export const TASK_PROMPT_MAX_ITEMS = 30;
