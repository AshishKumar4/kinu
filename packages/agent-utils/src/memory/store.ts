import type { SqlExecutor } from "../types";
import { readText, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { chunkMarkdown, hashText } from "./chunker";
import { searchFts } from "./query";
import type { MemorySearchResult } from "./query";

const SNIPPET_MAX_CHARS = 700;

const utf8 = new TextEncoder();

interface ChunkRow { id: string; path: string; start_line: number; end_line: number; hash: string }

interface FtsRow extends ChunkRow { rank: number }

/** A memory chunk with its verbatim text. Declared here because core depends on agent-utils. */
export interface IndexedChunk {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	text: string;
}

/** Chunks a vector index must upsert and chunk ids it must delete after (re)indexing a file. */
export interface MemoryIndexDelta {
	upserted: IndexedChunk[];
	deletedIds: string[];
}

export type NoteReader = (path: string) => Promise<string | null>;

/** A note's file identity as it was indexed; one that differs changed under the index. Null: indexed, not yet trusted. */
export type NoteStamp = string | null;

/** The note holds the text; rows keep lines and hash, FTS5 the terms. */
export function initMemoryChunkTables(sql: SqlExecutor): void {
	void sql`
		CREATE TABLE IF NOT EXISTS memory_note_chunks (
			id         TEXT PRIMARY KEY,
			path       TEXT    NOT NULL,
			start_line INTEGER NOT NULL,
			end_line   INTEGER NOT NULL,
			hash       TEXT    NOT NULL
		)
	`;
	void sql`CREATE INDEX IF NOT EXISTS idx_mc_path ON memory_note_chunks(path)`;
	void sql`
		CREATE TABLE IF NOT EXISTS memory_note_files (
			path  TEXT PRIMARY KEY,
			stamp TEXT
		)
	`;
	void sql`
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_note_chunks_fts USING fts5(
			text,
			content='',
			contentless_delete=1
		)
	`;
}

export class MemoryStore {
	constructor(private readonly vfs: Pick<VFS, 'readFile' | 'writeFile'>, private readonly sql: SqlExecutor) {}

	ensureSchema(): void {
		initMemoryChunkTables(this.sql);
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.vfs.writeFile(path, utf8.encode(content));
	}

	async appendToFile(path: string, content: string): Promise<void> {
		let existing = "";

		try {
			existing = await readText(this.vfs, path);
		} catch (err) {
			// Only a missing file starts fresh; overwriting on other errors destroys notes.
			if (!isMissingFileError(err)) throw err;
		}

		await this.writeFile(path, existing + content);
	}

	async readFile(path: string): Promise<string | null> {
		try {
			return await readText(this.vfs, path);
		} catch (err) {
			// Only a missing file is absence; null would read as a legitimately empty file.
			if (!isMissingFileError(err)) throw err;

			return null;
		}
	}

	/** Each indexed note's stamp, by path. */
	stamps(): Map<string, NoteStamp> {
		const rows = this.sql<{ path: string; stamp: NoteStamp }>`SELECT path, stamp FROM memory_note_files`;

		return new Map(rows.map((row) => [row.path, row.stamp]));
	}

	/** The stamp `path` was indexed at; undefined when it never was. */
	stampOf(path: string): NoteStamp | undefined {
		return this.sql<{ stamp: NoteStamp }>`SELECT stamp FROM memory_note_files WHERE path = ${path}`.at(0)?.stamp;
	}

	/** (Re)index a note as the file `stamp` names held it; the vector index's delta. */
	async indexFile(path: string, content: string, stamp: NoteStamp = null): Promise<MemoryIndexDelta> {
		const delta = await this.replaceChunks(path, content);

		void this.sql`
			INSERT INTO memory_note_files (path, stamp) VALUES (${path}, ${stamp})
			ON CONFLICT(path) DO UPDATE SET stamp = excluded.stamp
		`;

		return delta;
	}

	/** A note that is gone, or is no file: its chunks and its stamp leave. */
	async forgetFile(path: string): Promise<MemoryIndexDelta> {
		const delta = await this.replaceChunks(path, '');
		void this.sql`DELETE FROM memory_note_files WHERE path = ${path}`;

		return delta;
	}

	private async replaceChunks(path: string, content: string): Promise<MemoryIndexDelta> {
		const chunks = await chunkMarkdown(content);

		const existing = this.sql<{ id: string; hash: string }>`
			SELECT id, hash FROM memory_note_chunks WHERE path = ${path}
		`;

		const existingMap = new Map(existing.map((r) => [r.id, r.hash]));
		const newIds = new Set<string>();
		const upserted: IndexedChunk[] = [];

		for (const chunk of chunks) {
			const id = `${path}:${chunk.startLine}-${chunk.endLine}`;
			newIds.add(id);

			if (existingMap.get(id) === chunk.hash) continue;

			void this.sql`DELETE FROM memory_note_chunks_fts WHERE rowid IN (SELECT rowid FROM memory_note_chunks WHERE id = ${id})`;
			void this.sql`
				INSERT OR REPLACE INTO memory_note_chunks (id, path, start_line, end_line, hash)
				VALUES (${id}, ${path}, ${chunk.startLine}, ${chunk.endLine}, ${chunk.hash})
			`;
			void this.sql`INSERT INTO memory_note_chunks_fts (rowid, text) SELECT rowid, ${chunk.text} FROM memory_note_chunks WHERE id = ${id}`;
			upserted.push({ id, path, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text });
		}

		const deletedIds: string[] = [];

		for (const [id] of existingMap) {
			if (!newIds.has(id)) {
				void this.sql`DELETE FROM memory_note_chunks_fts WHERE rowid IN (SELECT rowid FROM memory_note_chunks WHERE id = ${id})`;
				void this.sql`DELETE FROM memory_note_chunks WHERE id = ${id}`;
				deletedIds.push(id);
			}
		}

		return { upserted, deletedIds };
	}

	/** A backfill page; `next` is null after the last. */
	async allChunksAfter(afterId: string, limit: number): Promise<{ readonly chunks: IndexedChunk[]; readonly next: string | null }> {
		const rows = this.sql<ChunkRow>`
			SELECT id, path, start_line, end_line, hash FROM memory_note_chunks
			WHERE id > ${afterId} ORDER BY id LIMIT ${limit}
		`;

		const chunks = (await chunkTexts(rows, (path) => this.readFile(path))).flatMap(({ row, text }) => (text === null ? [] : [{
			id: row.id, path: row.path, startLine: row.start_line, endLine: row.end_line, text,
		}]));

		return { chunks, next: rows.length < limit ? null : rows.at(-1)?.id ?? null };
	}

	async search(query: string, limit = 10, reindex: (path: string) => Promise<void> = async (path) => this.reindex(path)): Promise<MemorySearchResult[]> {
		return searchMemoryChunks({ sql: this.sql, read: (path) => this.readFile(path), reindex }, query, limit);
	}

	private async reindex(path: string): Promise<void> {
		const content = await this.readFile(path);

		await (content === null ? this.forgetFile(path) : this.indexFile(path, content));
	}
}

/** Null where the note's lines no longer hash to the row. */
async function chunkTexts<Row extends ChunkRow>(rows: readonly Row[], read: NoteReader): Promise<Array<{ row: Row; text: string | null }>> {
	const notes = new Map<string, Promise<string[] | null>>();

	const linesOf = (path: string): Promise<string[] | null> => {
		let lines = notes.get(path);

		if (lines === undefined) {
			lines = read(path).then((content) => content?.split("\n") ?? null);
			notes.set(path, lines);
		}

		return lines;
	};

	return Promise.all(rows.map(async (row) => {
		const lines = await linesOf(row.path);
		const text = lines?.slice(row.start_line - 1, row.end_line).join("\n") ?? null;

		return { row, text: text !== null && await hashText(text) === row.hash ? text : null };
	}));
}

interface NoteIndex {
	readonly sql: SqlExecutor;
	readonly read: NoteReader;
	readonly reindex?: (path: string) => Promise<void>;
}

/** Strict all-term page, then partial matches up to `limit`. */
async function searchMemoryChunks({ sql, read, reindex }: NoteIndex, query: string, limit = 10): Promise<MemorySearchResult[]> {
	if (!query.trim()) return [];

	const ranked = (): FtsRow[] => searchFts(query, limit, (match, capacity) => runFtsQuery(sql, match, capacity), (row) => row.id);
	let hits = await chunkTexts(ranked(), read);
	const stale = [...new Set(hits.filter((hit) => hit.text === null).map((hit) => hit.row.path))];

	if (stale.length > 0 && reindex !== undefined) {
		for (const path of stale) await reindex(path);
		hits = await chunkTexts(ranked(), read);
	}

	// bm25() is more negative for better matches; |rank|/(1+|rank|) keeps the score monotone with relevance.
	return hits.flatMap(({ row: r, text }) => (text === null ? [] : [{
		path: r.path,
		startLine: r.start_line,
		endLine: r.end_line,
		snippet: text.length > SNIPPET_MAX_CHARS ? text.slice(0, SNIPPET_MAX_CHARS) + "..." : text,
		score: Math.abs(r.rank) / (1 + Math.abs(r.rank)),
	}]));
}

function runFtsQuery(sql: SqlExecutor, ftsQuery: string, limit: number): FtsRow[] {
	return sql<FtsRow>`
		SELECT mc.id, mc.path, mc.start_line, mc.end_line, mc.hash, bm25(memory_note_chunks_fts) AS rank
		FROM memory_note_chunks_fts
		JOIN memory_note_chunks mc ON mc.rowid = memory_note_chunks_fts.rowid
		WHERE memory_note_chunks_fts MATCH ${ftsQuery}
		ORDER BY rank ASC, mc.rowid ASC
		LIMIT ${limit}
	`;
}

function isMissingFileError<Failure>(failure: Failure): failure is Failure & Error & { code: "ENOENT" } {
	return failure instanceof Error && "code" in failure && failure.code === "ENOENT";
}
