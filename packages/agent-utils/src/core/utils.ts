import type { ReadWriteVFS } from "../vfs/types";

export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
	const live = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (live.length === 1) return live[0];
	const controller = new AbortController();
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) controller.abort(signal.reason);
	};
	for (const signal of live) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		signal.addEventListener("abort", () => abort(signal), { once: true });
	}
	return controller.signal;
}

export function isAbortError<Failure>(err: Failure): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/**
 * Run `work` but stop waiting when `signal` aborts, rejecting with an
 * AbortError.
 *
 * Two abort cases, and they are not the same claim. A signal that is ALREADY
 * aborted rejects with `message` without starting the work at all — nothing
 * ran, so there is nothing to stop. A signal that aborts while the work is
 * running rejects with whatever `terminate` resolves, which is where a caller
 * that can actually kill its work says what killing achieved; the wait ends
 * only once that answer is in. A caller with no `terminate` cancels only the
 * WAIT, and its `message` must say so.
 *
 * `terminate` is expected to resolve, including on failure: "the work is gone"
 * and "nobody could stop it" are both answers, and only a thrown rejection
 * would leave the caller with neither.
 */
export async function raceAbort<T>(
	work: () => Promise<T>,
	signal: AbortSignal | undefined,
	message: string,
	terminate?: () => Promise<string>,
): Promise<T> {
	if (!signal) return work();
	const abortError = (text: string) => new DOMException(text, "AbortError");
	if (signal.aborted) throw abortError(message);

	let aborting = false;
	let resolveAbort: (value: void | PromiseLike<void>) => void;
	function onAbort(): void {
		aborting = true;
		resolveAbort();
	}
	const abortRequested = new Promise<void>((resolve) => {
		resolveAbort = resolve;
	});
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		const pendingWork = work();
		let workWon = false;
		const workFinished = (async () => {
			try {
				await pendingWork;
				workWon = !aborting;
			} catch (cause) {
				if (!aborting) throw cause;
			}
		})();

		await Promise.race([workFinished, abortRequested]);
		if (workWon) return await pendingWork;
		if (!terminate) throw abortError(message);

		let text: string;
		try {
			text = await terminate();
		} catch (cause) {
			const failure = new Error(`${message} — stopping the work failed`, { cause });
			failure.name = "AbortError";
			throw failure;
		}
		throw abortError(text);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Resolves `.`/`..` segments and prevents directory traversal above root. */
export function normalizePath(path: string): string {
	const stripped = path.replace(/^\/+/, "");
	if (stripped === "." || stripped === "./" || stripped === "") return "";

	const segments = stripped.split("/");
	const resolved: string[] = [];
	for (const seg of segments) {
		if (seg === "." || seg === "") continue;
		if (seg === "..") {
			resolved.pop();
		} else {
			resolved.push(seg);
		}
	}
	return resolved.join("/");
}

// ---------------------------------------------------------------------------
// VFS helpers
// ---------------------------------------------------------------------------

export async function readVfsText(vfs: ReadWriteVFS, path: string): Promise<string> {
	const result = await vfs.readFile(path, { encoding: "utf8" });
	if (result instanceof Uint8Array) throw new Error(`Expected text content for ${path}, got binary data`);
	return result;
}
