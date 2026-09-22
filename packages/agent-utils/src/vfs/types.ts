/** The narrow filesystem surface the stores here read and write. */
export interface ReadWriteVFS {
	readFile(path: string, options?: { encoding?: "utf8" }): Promise<Uint8Array | string>;
	writeFile(path: string, data: Uint8Array | string): Promise<void>;
	readdir(path: string): Promise<string[]>;
}
