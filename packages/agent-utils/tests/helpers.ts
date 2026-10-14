import { createMemoryVfs, seedFiles, type TestVfs } from "@kinu.run/test-utils";

/** The memory store's plane: the shared test VFS (Nimbus's MemoryVFS) with its `memory/` folder made, as a home has it,
 *  and each of `seed` (path: text) written. */
export async function memoryPlane(seed: Record<string, string> = {}): Promise<TestVfs> {
	const { vfs } = createMemoryVfs();

	await vfs.mkdir("memory", { recursive: true });
	await seedFiles(vfs, seed);

	return vfs;
}
