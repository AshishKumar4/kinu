/**
 * The filesystem surface the stores here actually read and write.
 *
 * Narrow on purpose: MemoryStore indexes markdown out of the workspace
 * filesystem, and those three methods are all it has ever called. Asking for a
 * whole Node-shaped fs forced every caller to build an adapter over the real
 * filesystem just to satisfy methods nothing invoked.
 */
export interface ReadWriteVFS {
	readFile(path: string, options?: { encoding?: "utf8" }): Promise<Uint8Array | string>;
	writeFile(path: string, data: Uint8Array | string): Promise<void>;
	readdir(path: string): Promise<string[]>;
}
