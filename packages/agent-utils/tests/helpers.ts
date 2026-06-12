import { Database } from "bun:sqlite";
import type { SqlExecutor } from "../src/types";

export interface TestDb {
	db: Database;
	sql: SqlExecutor;
	execRaw: (ddl: string) => void;
}

/** bun:sqlite-backed SqlExecutor matching the backends' wrappers
 *  (ArrayBuffer → Uint8Array coercion included). */
export function createTestDb(): TestDb {
	const db = new Database(":memory:");
	const sql = (<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
		const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? "?" : ""), "");
		const bound = values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
		const stmt = db.prepare(query);
		if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...(bound as never[])) as T[];
		stmt.run(...(bound as never[]));
		return [];
	}) as SqlExecutor;
	return { db, sql, execRaw: (ddl: string) => db.exec(ddl) };
}
