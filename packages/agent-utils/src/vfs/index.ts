export type { VFS, VFSStat, VFSError } from "./types";
export { makeError, makeStat } from "./types";
export { SqliteFS, VFS_SCHEMA_DDL, ensureVfsSchema, writeVfsFileSync } from "./sqlite";
export { concatBuffers, rowDataToBytes, toBuffer } from "./encoding";
export { walkRecursive } from "./walk";
export type { FileEntry } from "./walk";
