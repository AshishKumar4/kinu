import type { SqlExecutor, SqlRow } from "../types";
import type { CraftedTool, CraftedToolProvider } from "../codemode/builder";
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

export class CraftStore implements CraftedToolProvider {
	private readonly sql: SqlExecutor;

	constructor(sql: SqlExecutor) {
		this.sql = sql;
	}

	ensureSchema(): void {
		initCraftedToolsTables(this.sql);
	}

	create(input: { name: string; description: string; code: string }): CraftedTool {
		const now = Date.now();

		void this.sql`
			INSERT INTO crafted_tools (name, description, code, created_at, updated_at)
			VALUES (${input.name}, ${input.description}, ${input.code}, ${now}, ${now})
		`;

		return {
			name: input.name,
			description: input.description,
			code: input.code,
			createdAt: now,
			updatedAt: now,
		};
	}

	update(name: string, patch: { description?: string; code?: string }): CraftedTool | null {
		const existing = this.get(name);

		if (!existing) return null;

		const now = Date.now();
		const desc = patch.description ?? existing.description;
		const code = patch.code ?? existing.code;

		void this.sql`
			UPDATE crafted_tools SET description = ${desc}, code = ${code}, updated_at = ${now}
			WHERE name = ${name}
		`;

		return { name, description: desc, code, createdAt: existing.createdAt, updatedAt: now };
	}

	delete(name: string): boolean {
		const rows = [...this.sql`DELETE FROM crafted_tools WHERE name = ${name} RETURNING name`];

		return rows.length > 0;
	}

	get(name: string): CraftedTool | null {
		const rows = this.sql<CraftedToolRow>`SELECT * FROM crafted_tools WHERE name = ${name}`;

		return rows.length > 0 ? rowToTool(rows[0]) : null;
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

	getAll(): CraftedTool[] {
		const rows = this.sql<CraftedToolRow>`SELECT * FROM crafted_tools`;

		return rows.map(rowToTool);
	}
}

/** `AgentRuntime.craftStore`: a miss is `undefined` and a write answers nothing. */
export interface CraftStoreView {
	create(tool: Omit<CraftedTool, "createdAt" | "updatedAt">): void;
	update(name: string, patch: Partial<CraftedTool>): void;
	get(name: string): CraftedTool | undefined;
	delete(name: string): void;
	list(): CraftedTool[];
	search(query: string, limit?: number): CraftedTool[];
}

export function craftStoreView(store: CraftStore): CraftStoreView {
	return {
		create(tool) {
			store.create(tool);
		},
		update(name, patch) {
			store.update(name, patch);
		},
		get(name) {
			return store.get(name) ?? undefined;
		},
		delete(name) {
			store.delete(name);
		},
		list() {
			return store.list();
		},
		search(query, limit = 10) {
			return store.search(query, limit);
		},
	};
}
