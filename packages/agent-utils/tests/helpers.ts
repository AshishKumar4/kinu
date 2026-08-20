import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { SqlExecutor, SqlValue } from "../src/types";

export interface TestDb {
	db: Database;
	sql: SqlExecutor;
	execRaw: (ddl: string) => void;
}

/** bun:sqlite-backed SqlExecutor matching the backends' wrappers
 *  (ArrayBuffer → Uint8Array coercion included). */
export function createTestDb(): TestDb {
	const db = new Database(":memory:");
	const sql: SqlExecutor = function <T = unknown>(
		strings: TemplateStringsArray,
		...values: SqlValue[]
	): T[] {
		const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? "?" : ""), "");
		const bound: SQLQueryBindings[] = values.map((value) => (
			value instanceof ArrayBuffer ? new Uint8Array(value) : value
		));
		const stmt = db.prepare<T, SQLQueryBindings[]>(query);
		if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...bound);
		stmt.run(...bound);
		return [];
	};
	return { db, sql, execRaw: (ddl: string) => db.exec(ddl) };
}

/**
 * The three methods a store here consumes, over a Map.
 *
 * A fixture rather than the real filesystem because that lives in
 * `@kinu/core`, one layer up, and this package cannot import it — and
 * because `ReadWriteVFS` is exactly three methods, so a stand-in for it is
 * honest rather than a stub of something larger.
 */
export function createMemoryVfs(seed: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(seed));
	return {
		files,
		async readFile(path: string, options?: { encoding?: "utf8" }): Promise<Uint8Array | string> {
			const content = files.get(path);
			if (content === undefined) {
				throw Object.assign(
					new Error(`ENOENT: no such file or directory, open '${path}'`),
					{ code: "ENOENT" },
				);
			}
			return options?.encoding === "utf8" ? content : new TextEncoder().encode(content);
		},
		async writeFile(path: string, data: Uint8Array | string): Promise<void> {
			files.set(path, data instanceof Uint8Array ? new TextDecoder().decode(data) : data);
		},
		async readdir(path: string): Promise<string[]> {
			const prefix = path === "" || path === "." ? "" : `${path}/`;
			const names = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const name = key.slice(prefix.length).split("/").at(0);
				if (name) names.add(name);
			}
			return [...names];
		},
	};
}
