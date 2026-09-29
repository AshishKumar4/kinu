import { markStoreChanged } from "./changes";
import type { SqlExecutor, SqlRow } from "../types";
import type { CraftedTool } from "../codemode/builder";
import { fillToCapacity, relaxFtsQuery, sanitizeFtsQuery } from "../memory/query";

type CraftedToolRow = SqlRow<{
	name: string;
	description: string;
	code: string;
	created_at: number;
	updated_at: number;
}>;

function rowToTool(row: CraftedToolRow): CraftedTool {
	return {
		name: row.name,
		description: row.description,
		code: row.code,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Standalone so schema init needs no store. */
export function initCraftedToolsTables(sql: SqlExecutor): void {
	void sql`
		CREATE TABLE IF NOT EXISTS crafted_tools (
			name TEXT PRIMARY KEY,
			description TEXT NOT NULL DEFAULT '',
			code TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0,
			score REAL NOT NULL DEFAULT 0.5,
			uses INTEGER NOT NULL DEFAULT 0,
			last_used_at INTEGER NOT NULL DEFAULT 0
		)
	`;
	void sql`
		CREATE VIRTUAL TABLE IF NOT EXISTS crafted_tools_fts USING fts5(
			name, description,
			content=crafted_tools, content_rowid=rowid
		)
	`;
	void sql`
		CREATE TRIGGER IF NOT EXISTS crafted_tools_ai AFTER INSERT ON crafted_tools BEGIN
			INSERT INTO crafted_tools_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
		END
	`;
	void sql`
		CREATE TRIGGER IF NOT EXISTS crafted_tools_ad AFTER DELETE ON crafted_tools BEGIN
			INSERT INTO crafted_tools_fts(crafted_tools_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
		END
	`;
	void sql`
		CREATE TRIGGER IF NOT EXISTS crafted_tools_au AFTER UPDATE ON crafted_tools BEGIN
			INSERT INTO crafted_tools_fts(crafted_tools_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
			INSERT INTO crafted_tools_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
		END
	`;
}

/** `AgentRuntime.craftStore`: a miss is `undefined` and a write answers nothing. */
export class CraftStore {
	constructor(private readonly sql: SqlExecutor) {}

	ensureSchema(): void {
		initCraftedToolsTables(this.sql);
	}

	create(input: { name: string; description: string; code: string }): void {
		const now = Date.now();

		void this.sql`
			INSERT INTO crafted_tools (name, description, code, created_at, updated_at)
			VALUES (${input.name}, ${input.description}, ${input.code}, ${now}, ${now})
		`;
		markStoreChanged(this.sql);
	}

	update(name: string, patch: { description?: string; code?: string }): void {
		void this.sql`
			UPDATE crafted_tools
			SET description = COALESCE(${patch.description ?? null}, description),
				code = COALESCE(${patch.code ?? null}, code),
				updated_at = ${Date.now()}
			WHERE name = ${name}
		`;
		markStoreChanged(this.sql);
	}

	delete(name: string): void {
		void this.sql`DELETE FROM crafted_tools WHERE name = ${name}`;
		markStoreChanged(this.sql);
	}

	get(name: string): CraftedTool | undefined {
		const [row] = this.sql<CraftedToolRow>`SELECT * FROM crafted_tools WHERE name = ${name}`;

		return row === undefined ? undefined : rowToTool(row);
	}

	list(): CraftedTool[] {
		const rows = this.sql<CraftedToolRow>`SELECT * FROM crafted_tools ORDER BY updated_at DESC`;

		return rows.map(rowToTool);
	}

	/** All terms first, then any term to fill `limit`, as memory recall does. */
	search(query: string, limit = 10): CraftedTool[] {
		const strictQuery = sanitizeFtsQuery(query);
		const strict = this.matching(strictQuery, limit);
		const relaxed = strict.length >= limit ? null : relaxFtsQuery(strictQuery);

		const rows = relaxed === null
			? strict
			: fillToCapacity(strict, this.matching(relaxed, limit), limit, (row) => row.name);

		return rows.map(rowToTool);
	}

	private matching(match: string, limit: number): CraftedToolRow[] {
		return this.sql<CraftedToolRow>`
			SELECT t.* FROM crafted_tools t
			JOIN crafted_tools_fts f ON t.rowid = f.rowid
			WHERE crafted_tools_fts MATCH ${match}
			ORDER BY rank
			LIMIT ${limit}
		`;
	}
}
