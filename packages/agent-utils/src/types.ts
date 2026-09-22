export type SqlValue = string | number | boolean | null | ArrayBuffer;

/** Tagged-template SQL executor (Agents SDK `Agent.sql`, Durable Object SQLite, better-sqlite3). */
export interface SqlExecutor {
	<T = unknown>(query: TemplateStringsArray, ...values: SqlValue[]): T[];
}

export type SqlRow<T> = T & Record<string, SqlValue>;
