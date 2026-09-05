import type { SqlExecutor } from "../types";
import type { ReadWriteVFS } from "../vfs/types";
import { readVfsText } from "../core/utils";
import { chunkMarkdown } from "./chunker";
import { fillToCapacity, relaxFtsQuery, sanitizeFtsQuery } from "./query";
import type { MemorySearchResult } from "./query";

const DEFAULT_SNIPPET_MAX_CHARS = 700;

export interface MemoryConfig {
	memoryDir?: string;
	logsDir?: string;
	curatedFile?: string;
	indexedPrefixes?: string[];
	indexedFiles?: string[];
	snippetMaxChars?: number;
}

interface FtsRow { id: string; path: string; start_line: number; end_line: number; text: string; rank: number }

/** A memory chunk with its verbatim text — the unit a semantic index embeds.
 *  Core's vector store re-exports it. The declaration lives here because core
 *  depends on agent-utils and not the reverse. */
export interface IndexedChunk {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	text: string;
}

/** The change set produced by (re)indexing a file — what a downstream vector
 *  index must upsert (new/changed chunks, with text to embed) and delete
 *  (chunk ids whose line range no longer exists). */
export interface MemoryIndexDelta {
	upserted: IndexedChunk[];
	deletedIds: string[];
}

/**
 * The `memory_chunks` FTS5 index tables.
 *
 * Standalone so a workspace's schema initializer can create them without
 * constructing a store (core's `initWorkspaceSchema` calls this). Every
 * composition root that builds a MemoryStore also gets them via
 * {@link MemoryStore.ensureSchema}, which delegates here — one DDL, one
 * source of truth.
 */
export function initMemoryChunkTables(sql: SqlExecutor): void {
	void sql`
		CREATE TABLE IF NOT EXISTS memory_chunks (
			id         TEXT PRIMARY KEY,
			path       TEXT    NOT NULL,
			start_line INTEGER NOT NULL,
			end_line   INTEGER NOT NULL,
			hash       TEXT    NOT NULL,
			text       TEXT    NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`;
	void sql`CREATE INDEX IF NOT EXISTS idx_mc_path ON memory_chunks(path)`;
	void sql`
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
			text,
			content='memory_chunks',
			content_rowid='rowid'
		)
	`;
}

export class MemoryStore {
	private vfs: ReadWriteVFS;
	private sql: SqlExecutor;
	private memoryDir: string;
	private logsDir: string;
	readonly curatedFile: string;
	private indexedPrefixes: string[];
	private indexedFiles: string[];
	private snippetMaxChars: number;

	constructor(vfs: ReadWriteVFS, sql: SqlExecutor, config?: MemoryConfig) {
		this.vfs = vfs;
		this.sql = sql;
		this.memoryDir = config?.memoryDir ?? "memory";
		this.logsDir = config?.logsDir ?? `${this.memoryDir}/logs`;
		this.curatedFile = config?.curatedFile ?? `${this.memoryDir}/MEMORY.md`;
		this.indexedPrefixes = config?.indexedPrefixes ?? ["memory/", "identity.md"];
		this.indexedFiles = config?.indexedFiles ?? [];
		this.snippetMaxChars = config?.snippetMaxChars ?? DEFAULT_SNIPPET_MAX_CHARS;
	}

	ensureSchema(): void {
		initMemoryChunkTables(this.sql);
	}

	shouldIndex(path: string): boolean {
		if (this.indexedFiles.includes(path)) return true;
		return this.indexedPrefixes.some((p) => path.startsWith(p));
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.vfs.writeFile(path, content);
	}

	async appendToFile(path: string, content: string): Promise<void> {
		let existing = "";
		try {
			existing = await readVfsText(this.vfs, path);
		} catch (err) {
			// Only a missing file starts fresh. Any other read failure must
			// surface — silently overwriting here destroys the existing notes.
			if (!isMissingFileError(err)) throw err;
		}
		await this.writeFile(path, existing + content);
	}

	async readFile(path: string, lineRange?: { start: number; end: number }): Promise<string | null> {
		try {
			const content = await readVfsText(this.vfs, path);
			if (!lineRange) return content;
			const lines = content.split("\n");
			const start = Math.max(0, lineRange.start - 1);
			const end = Math.min(lines.length, lineRange.end);
			return lines.slice(start, end).join("\n");
		} catch (err) {
			// Only a missing file is absence. Any other read failure must surface:
			// null here is indistinguishable from a file that is legitimately empty.
			if (!isMissingFileError(err)) throw err;
			return null;
		}
	}

	async readCurated(): Promise<string | null> {
		return this.readFile(this.curatedFile);
	}

	/** (Re)index a file into FTS5 and report the semantic-index delta: chunks
	 *  that were inserted or changed (need embedding) and chunk ids that were
	 *  removed (need dropping from the vector index). FTS5 stays the source of
	 *  truth; a vector store, if any, is synced by the caller from the delta. */
	async indexFile(path: string, content: string): Promise<MemoryIndexDelta> {
		const chunks = await chunkMarkdown(content);
		const now = Date.now();

		const existing = this.sql<{ id: string; hash: string }>`
			SELECT id, hash FROM memory_chunks WHERE path = ${path}
		`;
		const existingMap = new Map(existing.map((r) => [r.id, r.hash]));
		const newIds = new Set<string>();
		const upserted: IndexedChunk[] = [];

		for (const chunk of chunks) {
			const id = `${path}:${chunk.startLine}-${chunk.endLine}`;
			newIds.add(id);
			if (existingMap.get(id) === chunk.hash) continue;

			void this.sql`DELETE FROM memory_chunks_fts WHERE rowid IN (SELECT rowid FROM memory_chunks WHERE id = ${id})`;
			void this.sql`
				INSERT OR REPLACE INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
				VALUES (${id}, ${path}, ${chunk.startLine}, ${chunk.endLine}, ${chunk.hash}, ${chunk.text}, ${now})
			`;
			void this.sql`INSERT INTO memory_chunks_fts (rowid, text) SELECT rowid, text FROM memory_chunks WHERE id = ${id}`;
			upserted.push({ id, path, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text });
		}

		const deletedIds: string[] = [];
		for (const [id] of existingMap) {
			if (!newIds.has(id)) {
				void this.sql`DELETE FROM memory_chunks_fts WHERE rowid IN (SELECT rowid FROM memory_chunks WHERE id = ${id})`;
				void this.sql`DELETE FROM memory_chunks WHERE id = ${id}`;
				deletedIds.push(id);
			}
		}
		return { upserted, deletedIds };
	}

	/** A bounded, ordered page of indexed chunks — the one-time semantic-index
	 *  backfill of chunks written before a vector store existed. Ordered by the
	 *  `id` primary key (a total order) so `afterId` pages a large table across
	 *  boots without re-embedding earlier chunks. */
	allChunksAfter(afterId: string, limit: number): IndexedChunk[] {
		const rows = this.sql<{ id: string; path: string; start_line: number; end_line: number; text: string }>`
			SELECT id, path, start_line, end_line, text FROM memory_chunks
			WHERE id > ${afterId} ORDER BY id LIMIT ${limit}
		`;
		return rows.map((r) => ({ id: r.id, path: r.path, startLine: r.start_line, endLine: r.end_line, text: r.text }));
	}

	removeIndex(path: string): void {
		void this.sql`DELETE FROM memory_chunks_fts WHERE rowid IN (SELECT rowid FROM memory_chunks WHERE path = ${path})`;
		void this.sql`DELETE FROM memory_chunks WHERE path = ${path}`;
	}

	/**
	 * Ranked chunk hits, best first: the strict all-term page, then ranked partial
	 * matches until `limit` distinct chunks are held. Same fill policy as the
	 * transcript recall surface in core, because it is the same question — see
	 * {@link fillToCapacity} for why one partial page of `limit` rows suffices.
	 */
	search(query: string, limit = 10): MemorySearchResult[] {
		if (!query.trim()) return [];

		const safeQuery = sanitizeFtsQuery(query);
		const strict = this.runFtsQuery(safeQuery, limit);
		const relaxed = strict.length >= limit ? null : relaxFtsQuery(safeQuery);
		const rows = relaxed === null
			? strict
			: fillToCapacity(strict, this.runFtsQuery(relaxed, limit), limit, (row) => row.id);

		// bm25() is negative, more negative = more relevant. The displayed score
		// must be monotone WITH relevance: |rank|/(1+|rank|) maps the strongest
		// match nearest 1. (The old 1/(1+|rank|) was inverted, and the 0.05
		// floor built on it filtered out exactly the strongest matches.)
		return rows.map((r) => ({
			path: r.path,
			startLine: r.start_line,
			endLine: r.end_line,
			snippet: r.text.length > this.snippetMaxChars
				? r.text.slice(0, this.snippetMaxChars) + "..."
				: r.text,
			score: Math.abs(r.rank) / (1 + Math.abs(r.rank)),
		}));
	}

	private runFtsQuery(ftsQuery: string, limit: number): FtsRow[] {
		return this.sql<FtsRow>`
			SELECT mc.id, mc.path, mc.start_line, mc.end_line, mc.text, bm25(memory_chunks_fts) AS rank
			FROM memory_chunks_fts
			JOIN memory_chunks mc ON mc.rowid = memory_chunks_fts.rowid
			WHERE memory_chunks_fts MATCH ${ftsQuery}
			ORDER BY rank ASC, mc.rowid ASC
			LIMIT ${limit}
		`;
	}

	todayLogPath(): string {
		const d = new Date();
		const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		return `${this.logsDir}/${date}.md`;
	}

	async listLogFiles(): Promise<string[]> {
		try {
			const entries = await this.vfs.readdir(this.logsDir);
			return entries
				.filter((name: string) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
				.sort((a: string, b: string) => b.localeCompare(a))
				.map((name: string) => `${this.logsDir}/${name}`);
		} catch (err) {
			// A logs directory that was never created is genuinely no logs. Any
			// other readdir failure must not read as an empty history.
			if (!isMissingFileError(err)) throw err;
			return [];
		}
	}

	async listFiles(prefix?: string): Promise<string[]> {
		const dir = prefix ?? this.memoryDir;
		try { return await this.vfs.readdir(dir); }
		catch (err) {
			if (!isMissingFileError(err)) throw err;
			return [];
		}
	}
}

function isMissingFileError<Failure>(failure: Failure): boolean {
	return failure instanceof Error && "code" in failure && failure.code === "ENOENT";
}
