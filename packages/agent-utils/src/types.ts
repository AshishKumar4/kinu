// ---------------------------------------------------------------------------
// Core types for @kinu/agent-utils
// ---------------------------------------------------------------------------

/**
 * The one SQL primitive in the repo. Core re-exports these from
 * `types/primitives.ts` as part of its portability layer — the definition
 * lives here because `agent-utils` is the bottom of the package DAG and core
 * already depends on it, so this is the only place a single definition can sit.
 */

/** Primitive types a bound value may take. */
export type SqlValue = string | number | boolean | null | ArrayBuffer;

/**
 * Tagged-template SQL executor. The Agents SDK `Agent.sql`, Durable Object
 * SQLite and better-sqlite3 all satisfy it. For DDL (CREATE TABLE etc), which
 * binds nothing, core declares a separate `RawSqlExec`.
 *
 * Obtain from any Agent subclass via `this.sql.bind(this) as SqlExecutor`.
 */
export interface SqlExecutor {
	<T = unknown>(query: TemplateStringsArray, ...values: SqlValue[]): T[];
}

/** Row type that includes both typed columns and raw SQL values. */
export type SqlRow<T> = T & Record<string, SqlValue>;
