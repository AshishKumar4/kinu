/**
 * The correction a model needs when it addressed the agent's file plane as if
 * it were the machine's.
 *
 * Models routinely read `workspace.*`, the `file` tool and the emulated shell
 * as the container's filesystem, and a bare `ENOENT: … '/app'` neither says
 * otherwise nor points anywhere useful — under a benchmark that mistake ended
 * two whole trials, and in production it made a fork conclude a repository did
 * not exist when it was one mount away.
 *
 * It lives here, in the lowest layer, because both consumers need it and only
 * one of them can import the other: core's file surfaces (`vfs/errno.ts`
 * re-exports it) and this package's shell emulator.
 *
 * The roots are read live from the filesystem itself, so the hint can never
 * drift from the runtime it describes.
 */

export async function vfsAddressingHint(
	vfs: { readdir(path: string): Promise<string[]> },
	/** How the caller's surface names itself, so the correction reads as being
	 *  about the thing the model just called. */
	subject: string,
): Promise<string> {
	let roots = "";
	try { roots = (await vfs.readdir("/")).join(", "); } catch { /* the hint stands without it */ }
	return (
		`${subject} is the agent's own virtual filesystem, NOT the machine or container this agent `
		+ "runs on: a path here is not the machine path of the same name"
		+ (roots ? `, and this filesystem's roots are: ${roots}` : "")
		+ ". To reach files that live on a real machine or container, run a shell command there with the "
		+ "`run` tool (choosing the runtime that owns them), or address them through the root that maps to it."
	);
}
