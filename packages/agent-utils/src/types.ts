// ---------------------------------------------------------------------------
// Core types for @proteus/agent-utils
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

/** Row type that includes both typed columns and raw SQL values. */
export type SqlRow<T> = T & Record<string, SqlValue>;
