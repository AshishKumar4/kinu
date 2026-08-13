export type { VFS, VFSStat, VFSError } from "./types";
export { concatBuffers, rowDataToBytes, toBuffer } from "./encoding";
export { walkRecursive } from "./walk";
export type { FileEntry } from "./walk";
export { vfsAddressingHint } from "./addressing";
