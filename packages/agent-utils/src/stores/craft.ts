import type { SqlExecutor, SqlRow } from "../types";
import type { CraftedTool, CraftedToolProvider } from "../codemode/builder";

// ---------------------------------------------------------------------------
// SQLite row type
// ---------------------------------------------------------------------------

type CraftRow = SqlRow<{
	name: string;
	description: string;
	params: string | null;
	code: string;
	scope: string;
	created_at: number;
	updated_at: number;
}>;

function rowToTool(row: CraftRow): CraftedTool {
	return {
		name: row.name,
		description: row.description,
		params: row.params ? JSON.parse(row.params) as Record<string, string> : null,
		code: row.code,
		scope: row.scope as CraftedTool["scope"],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ---------------------------------------------------------------------------
// CraftStore — SQLite + FTS5 storage for agent-crafted tools
// ---------------------------------------------------------------------------

export class CraftStore implements CraftedToolProvider {
	private sql: SqlExecutor;

	constructor(sql: SqlExecutor) {
		this.sql = sql;
	}

	ensureSchema(): void {
		void this.sql`
			CREATE TABLE IF NOT EXISTS crafted_tools (
				name TEXT PRIMARY KEY,
				description TEXT NOT NULL,
				params TEXT,
				code TEXT NOT NULL,
				scope TEXT NOT NULL DEFAULT 'local',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		void this.sql`
			CREATE VIRTUAL TABLE IF NOT EXISTS crafted_tools_fts USING fts5(
				name, description,
				content=crafted_tools, content_rowid=rowid
			)
		`;
		// Triggers to keep FTS in sync
		void this.sql`
			CREATE TRIGGER IF NOT EXISTS crafted_tools_ai AFTER INSERT ON crafted_tools BEGIN
				INSERT INTO crafted_tools_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
			END
		`;
		void this.sql`
			CREATE TRIGGER IF NOT EXISTS crafted_tools_ad AFTER DELETE ON crafted_tools BEGIN
				INSERT INTO crafted_tools_fts(crafted_tools_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
			END
		`;
		void this.sql`
			CREATE TRIGGER IF NOT EXISTS crafted_tools_au AFTER UPDATE ON crafted_tools BEGIN
				INSERT INTO crafted_tools_fts(crafted_tools_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
				INSERT INTO crafted_tools_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
			END
		`;
	}

	create(input: { name: string; description: string; params?: Record<string, string> | null; code: string; scope?: CraftedTool["scope"] }): CraftedTool {
		const now = Date.now();
		const paramsJson = input.params ? JSON.stringify(input.params) : null;
		const scope = input.scope ?? "local";

		void this.sql`
			INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
			VALUES (${input.name}, ${input.description}, ${paramsJson}, ${input.code}, ${scope}, ${now}, ${now})
		`;

		return {
			name: input.name,
			description: input.description,
			params: input.params ?? null,
			code: input.code,
			scope,
			createdAt: now,
			updatedAt: now,
		};
	}

	update(name: string, patch: { description?: string; params?: Record<string, string> | null; code?: string; scope?: CraftedTool["scope"] }): CraftedTool | null {
		const existing = this.get(name);
		if (!existing) return null;

		const now = Date.now();
		const desc = patch.description ?? existing.description;
		const paramsJson = patch.params !== undefined ? (patch.params ? JSON.stringify(patch.params) : null) : (existing.params ? JSON.stringify(existing.params) : null);
		const code = patch.code ?? existing.code;
		const scope = patch.scope ?? existing.scope;

		void this.sql`
			UPDATE crafted_tools SET description = ${desc}, params = ${paramsJson}, code = ${code}, scope = ${scope}, updated_at = ${now}
			WHERE name = ${name}
		`;

		return { name, description: desc, params: patch.params !== undefined ? patch.params : existing.params, code, scope, createdAt: existing.createdAt, updatedAt: now };
	}

	delete(name: string): boolean {
		const rows = [...this.sql`DELETE FROM crafted_tools WHERE name = ${name} RETURNING name`];
		return rows.length > 0;
	}

	get(name: string): CraftedTool | null {
		const rows = [...this.sql`SELECT * FROM crafted_tools WHERE name = ${name}`] as CraftRow[];
		return rows.length > 0 ? rowToTool(rows[0]) : null;
	}

	list(): CraftedTool[] {
		const rows = [...this.sql`SELECT * FROM crafted_tools ORDER BY updated_at DESC`] as CraftRow[];
		return rows.map(rowToTool);
	}

	search(query: string, limit = 10): CraftedTool[] {
		const safeQuery = `"${query.replace(/"/g, '""')}"`;
		const rows = [...this.sql`
			SELECT t.* FROM crafted_tools t
			JOIN crafted_tools_fts f ON t.rowid = f.rowid
			WHERE crafted_tools_fts MATCH ${safeQuery}
			ORDER BY rank
			LIMIT ${limit}
		`] as CraftRow[];
		return rows.map(rowToTool);
	}

	getAll(): CraftedTool[] {
		const rows = [...this.sql`SELECT * FROM crafted_tools`] as CraftRow[];
		return rows.map(rowToTool);
	}
}
