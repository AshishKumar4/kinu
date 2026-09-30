

export function isAbortError<Failure>(err: Failure): err is Failure & Error {
	return err instanceof Error && err.name === "AbortError";
}

/** Each op after the last has ended; a failure is its caller's and never stops the next. */
export function serialQueue(): <T>(op: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();

	return (op) => {
		const run = tail.then(op);
		tail = Promise.allSettled([run]);

		return run;
	};
}

/**
 * Run `work` but stop waiting when `signal` aborts. An already-aborted signal rejects with `message`
 * without starting work; a later abort rejects with what `terminate` resolves. Without `terminate`
 * only the wait is cancelled, and `message` must say so. `terminate` must resolve, not throw.
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
			const failure = new Error(`${message}: stopping the work failed`, { cause });
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

