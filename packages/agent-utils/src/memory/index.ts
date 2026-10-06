export { MemoryStore, initMemoryChunkTables, searchMemoryChunks } from "./store";

export type { IndexedChunk, MemoryIndexDelta, NoteReader } from "./store";

export { chunkMarkdown, hashText } from "./chunker";

export type { Chunk } from "./chunker";

export { searchFts, ftsQueryTerms } from "./query";

export type { MemorySearchResult } from "./query";
