/** Correction for a model that addressed the agent file plane as the machine filesystem; roots are read live. */

export async function vfsAddressingHint(
	vfs: { readdir(path: string): Promise<string[]> },
	subject: string,
): Promise<string> {
	let roots = "";

	try {
		roots = (await vfs.readdir("/")).join(", ");
	} catch (error) {
		// Built while reporting a failed lookup, so it must not throw; an unlistable root is stated.
		roots = `unlistable (${error instanceof Error ? error.message : String(error)})`;
	}

	return (
		`${subject} is the agent's own virtual filesystem, NOT the machine or container this agent `
		+ "runs on: a path here is not the machine path of the same name"
		+ (roots ? `, and this filesystem's roots are: ${roots}` : "")
		+ ". To reach files that live on a real machine or container, run a shell command there with the "
		+ "`shell` tool (choosing the runtime that owns them), or address them through the root that maps to it."
	);
}
