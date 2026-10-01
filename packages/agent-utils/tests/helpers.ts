import type { VfsDirent } from '@nimbus-sh/core/vfs/vfs.js';
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { SqlExecutor, SqlValue } from "../src/types";

export interface TestDb {
	db: Database;
	sql: SqlExecutor;
	execRaw: (ddl: string) => void;
}

/** bun:sqlite-backed SqlExecutor with the backends' ArrayBuffer → Uint8Array coercion. */
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

/** A map-backed byte filesystem; the production filesystem lives in Nimbus. */
export function createMemoryVfs(seed: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(seed));

	return {
		files,
		async readFile(path: string): Promise<Uint8Array> {
			const content = files.get(path);

			if (content === undefined) {
				throw Object.assign(
					new Error(`ENOENT: no such file or directory, open '${path}'`),
					{ code: "ENOENT" },
				);
			}

			return new TextEncoder().encode(content);
		},
		async writeFile(path: string, data: Uint8Array): Promise<void> {
			files.set(path, new TextDecoder().decode(data));
		},
		async readdir(path: string): Promise<VfsDirent[]> {
			const prefix = path === "" || path === "." ? "" : `${path}/`;
			const names = new Set<string>();

			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const name = key.slice(prefix.length).split("/").at(0);

				if (name) names.add(name);
			}

			return [...names].map((name) => ({ name, type: files.has(`${prefix}${name}`) ? 'file' : 'directory' }));
		},
	};
}
