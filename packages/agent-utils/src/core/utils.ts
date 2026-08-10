import type { VFS } from "../vfs/types";

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

export function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/**
 * Run `work` but stop waiting when `signal` aborts, rejecting with an
 * AbortError carrying `message`. A pre-aborted signal rejects without
 * starting the work at all. This cancels only the WAIT — callers whose
 * underlying work cannot be killed remotely must say so in `message`.
 */
export function raceAbort<T>(
	work: () => Promise<T>,
	signal: AbortSignal | undefined,
	message: string,
): Promise<T> {
	if (!signal) return work();
	if (signal.aborted) return Promise.reject(new DOMException(message, "AbortError"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new DOMException(message, "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		work().then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(err) => { signal.removeEventListener("abort", onAbort); reject(err); },
		);
	});
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

export async function readVfsText(vfs: VFS, path: string): Promise<string> {
	const result = await vfs.readFile(path, { encoding: "utf8" });
	if (typeof result !== "string") {
		throw new Error(`Expected text content for ${path}, got ${typeof result}`);
	}
	return result;
}
