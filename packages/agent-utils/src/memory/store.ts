import * as v from "valibot";
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
	hash: string;
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	text: string;
	/** When its note was last written, where the reader knows. */
	writtenAt?: number;
}

export type NoteReader = (path: string) => Promise<string | null>;

/** When the lines of the note at `path` through `endLine` were written, read off the lines a hydration already holds. */
export type NoteDater = (path: string, lines: readonly string[], endLine: number) => Promise<number | undefined>;

/** A note's file identity as it was indexed; one that differs changed under the index. Null: indexed, not yet trusted. */
export type NoteStamp = string | null;

/** A chunk the vector scan ranked, with its text read back. */
export type NearestChunk = IndexedChunk & { readonly score: number };

/** DO storage reads a blob back as an ArrayBuffer, bun:sqlite as a Uint8Array. */
const EmbeddingSchema = v.union([v.instance(ArrayBuffer), v.instance(Uint8Array)]);

/** The note holds the text; rows keep lines and hash, FTS5 the terms, and the vector of the text each hash names. */
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
	// A normalized float32 embedding of the chunk text `hash` names: a chunk whose hash moved owes a vector again.
	void sql`
		CREATE TABLE IF NOT EXISTS memory_note_vectors (
			chunk_id  TEXT PRIMARY KEY,
			hash      TEXT NOT NULL,
			embedding BLOB NOT NULL
		)
	`;
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
	constructor(private readonly vfs: Pick<VFS, 'readFile' | 'writeFile'>, private readonly sql: SqlExecutor, private readonly transactionSync: (write: () => void) => void) {}

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

	/** (Re)index a note as the file `stamp` names held it. */
	async indexFile(path: string, content: string, stamp: NoteStamp = null): Promise<void> {
		await this.replaceChunks(path, content, stamp);
	}

	/** A note that is gone, or is no file: its chunks, their vectors and its stamp leave. */
	async forgetFile(path: string): Promise<void> {
		await this.replaceChunks(path, '', undefined);
	}

	private async replaceChunks(path: string, content: string, stamp: NoteStamp | undefined): Promise<void> {
		const chunks = await chunkMarkdown(content);

		this.transactionSync(() => {
			const existing = this.sql<{ id: string; hash: string }>`
				SELECT id, hash FROM memory_note_chunks WHERE path = ${path}
			`;

			const existingMap = new Map(existing.map((r) => [r.id, r.hash]));
			const newIds = new Set<string>();

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
			}

			for (const [id] of existingMap) {
				if (!newIds.has(id)) {
					void this.sql`DELETE FROM memory_note_chunks_fts WHERE rowid IN (SELECT rowid FROM memory_note_chunks WHERE id = ${id})`;
					void this.sql`DELETE FROM memory_note_chunks WHERE id = ${id}`;
					void this.sql`DELETE FROM memory_note_vectors WHERE chunk_id = ${id}`;
				}
			}

			if (stamp === undefined) void this.sql`DELETE FROM memory_note_files WHERE path = ${path}`;
			else void this.sql`
				INSERT INTO memory_note_files (path, stamp) VALUES (${path}, ${stamp})
				ON CONFLICT(path) DO UPDATE SET stamp = excluded.stamp`;
		});
	}

	/** Up to `limit` chunks with no vector of their current text, newest first, read back from their notes. */
	async chunksOwedVectors(limit: number): Promise<IndexedChunk[]> {
		const rows = this.sql<ChunkRow>`SELECT c.id, c.path, c.start_line, c.end_line, c.hash FROM memory_note_chunks c
			LEFT JOIN memory_note_vectors v ON v.chunk_id = c.id AND v.hash = c.hash
			WHERE v.chunk_id IS NULL ORDER BY c.rowid DESC LIMIT ${limit}`;

		return this.hydrateChunks(rows);
	}

	/** Each vector kept only while its chunk still holds the text it embeds: one embedded before an edit landed is dropped. */
	putVectors(vectors: readonly { readonly id: string; readonly hash: string; readonly embedding: Float32Array }[]): void {
		this.transactionSync(() => {
			for (const { id, hash, embedding } of vectors) {
				void this.sql`INSERT OR REPLACE INTO memory_note_vectors (chunk_id, hash, embedding)
					SELECT id, hash, ${new Float32Array(embedding).buffer} FROM memory_note_chunks WHERE id = ${id} AND hash = ${hash}`;
			}
		});
	}

	/**
	 * The `limit` chunks nearest the query `embed` answers (normalized, as every kept vector is) by dot product, scanned
	 * exactly; a vector counts only where its chunk still holds the text it embeds. With none kept, the query is never
	 * embedded.
	 */
	async nearestChunks(embed: () => Promise<Float32Array>, limit: number, dated?: NoteDater): Promise<NearestChunk[]> {
		const rows = this.sql<ChunkRow & { embedding: ArrayBuffer | Uint8Array }>`
			SELECT c.id, c.path, c.start_line, c.end_line, c.hash, v.embedding FROM memory_note_vectors v
			JOIN memory_note_chunks c ON c.id = v.chunk_id AND c.hash = v.hash`;

		if (rows.length === 0) return [];
		const query = await embed();
		const top: Array<ChunkRow & { score: number }> = [];

		for (const { embedding, ...row } of rows) {
			const score = dot(query, vectorOf(embedding));

			if (top.length === limit && score <= (top.at(-1)?.score ?? -Infinity)) continue;
			const at = top.findIndex((held) => held.score < score);

			top.splice(at === -1 ? top.length : at, 0, { ...row, score });

			if (top.length > limit) top.pop();
		}

		const read = await chunkTexts(top, (path) => this.readFile(path), dated);

		return read.flatMap(({ row, text, writtenAt }) => text === null ? [] : [{ ...indexedChunk(row, text, writtenAt), score: row.score }]);
	}

	private async hydrateChunks(rows: readonly ChunkRow[], dated?: NoteDater): Promise<IndexedChunk[]> {
		return (await chunkTexts(rows, (path) => this.readFile(path), dated)).flatMap(({ row, text, writtenAt }) => text === null ? [] : [indexedChunk(row, text, writtenAt)]);
	}

	/** `dated`: dates each hit off the lines its hydration read. */
	async search(query: string, limit = 10, reindex: (path: string) => Promise<void> = async (path) => this.reindex(path), dated?: NoteDater): Promise<MemorySearchResult[]> {
		return searchMemoryChunks({ sql: this.sql, read: (path) => this.readFile(path), reindex, dated }, query, limit);
	}

	private async reindex(path: string): Promise<void> {
		const content = await this.readFile(path);

		await (content === null ? this.forgetFile(path) : this.indexFile(path, content));
	}
}

function indexedChunk(row: ChunkRow, text: string, writtenAt: number | undefined): IndexedChunk {
	return { id: row.id, path: row.path, startLine: row.start_line, endLine: row.end_line, text, hash: row.hash, ...(writtenAt !== undefined && { writtenAt }) };
}

/** Null where the note's lines no longer hash to the row. */
async function chunkTexts<Row extends ChunkRow>(
	rows: readonly Row[], read: NoteReader, dated?: NoteDater,
): Promise<Array<{ row: Row; text: string | null; writtenAt?: number }>> {
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
		const writtenAt = lines === null || dated === undefined ? undefined : await dated(row.path, lines, row.end_line);

		return { row, text: text !== null && await hashText(text) === row.hash ? text : null, ...(writtenAt !== undefined && { writtenAt }) };
	}));
}

interface NoteIndex {
	readonly sql: SqlExecutor;
	readonly read: NoteReader;
	readonly reindex?: (path: string) => Promise<void>;
	readonly dated?: NoteDater;
}

/** Strict all-term page, then partial matches up to `limit`. */
async function searchMemoryChunks({ sql, read, reindex, dated }: NoteIndex, query: string, limit = 10): Promise<MemorySearchResult[]> {
	if (!query.trim()) return [];

	const ranked = (): FtsRow[] => searchFts(query, limit, (match, capacity) => runFtsQuery(sql, match, capacity), (row) => row.id);
	let hits = await chunkTexts(ranked(), read, dated);
	const stale = [...new Set(hits.filter((hit) => hit.text === null).map((hit) => hit.row.path))];

	if (stale.length > 0 && reindex !== undefined) {
		for (const path of stale) await reindex(path);
		hits = await chunkTexts(ranked(), read, dated);
	}

	// bm25() is more negative for better matches; |rank|/(1+|rank|) keeps the score monotone with relevance.
	return hits.flatMap(({ row: r, text, writtenAt }) => (text === null ? [] : [{
		path: r.path,
		startLine: r.start_line,
		endLine: r.end_line,
		snippet: text.length > SNIPPET_MAX_CHARS ? text.slice(0, SNIPPET_MAX_CHARS) + "..." : text,
		score: Math.abs(r.rank) / (1 + Math.abs(r.rank)),
		...(writtenAt !== undefined && { writtenAt }),
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

function vectorOf(embedding: ArrayBuffer | Uint8Array): Float32Array {
	const bytes = v.parse(EmbeddingSchema, embedding);

	return new Float32Array(bytes instanceof Uint8Array ? bytes.slice().buffer : bytes);
}

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;

	for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);

	return sum;
}

function isMissingFileError<Failure>(failure: Failure): failure is Failure & Error & { code: "ENOENT" } {
	return failure instanceof Error && "code" in failure && failure.code === "ENOENT";
}
