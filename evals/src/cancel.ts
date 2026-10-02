// The run's cancel, as its trials hear it. vitest's own cancel rejects a running test the moment its signal aborts
// (@vitest/runner `withCancel`), before the trial could say what held it, so the run's reporter keeps vitest from
// exiting on SIGTERM or SIGINT (`reporter.ts`) and each worker hears the signal itself: an open trial reads what holds
// its workspace, records it and ends, and a worker with no trial open ends on the signal as it always did.
//
// The listeners a worker already has would end it first: the test preload's scratch release removes every listener and
// raises the signal again (`releaseOnSignals` in test-utils), which on 2026-10-01 killed a live trial 15 ms after the
// deploy's SIGTERM. They are set aside when the first trial opens, and a worker with none open hands them the signal.

/** The signals that cancel an eval run: the deploy watchdog's SIGTERM, a terminal's SIGINT, a person's either. */
export const CANCEL_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export type CancelSignal = (typeof CANCEL_SIGNALS)[number];

const cancelling = new AbortController();

let open = 0;

let listening = false;

const listeners = { SIGTERM: () => { hear('SIGTERM'); }, SIGINT: () => { hear('SIGINT'); } } as const;

/** The listeners each signal had before the run's cancel took it. */
const before = new Map<CancelSignal, ReturnType<typeof process.listeners<CancelSignal>>>();

function hear(signal: CancelSignal): void {
  // The same cancel, heard again: the run's group and vitest's own process both pass it on. A worker that has begun it
  // stays until vitest has its trials' records, then the pool's stop ends it with a SIGKILL 500 ms after its SIGTERM.
  if (cancelling.signal.aborted) return;

  if (open > 0) {
    cancelling.abort(signal);

    return;
  }

  // The pool's own stop at the end of every run is a SIGTERM, and a worker between trials ends on it as it always did.
  for (const each of CANCEL_SIGNALS) {
    process.removeListener(each, listeners[each]);

    for (const listener of before.get(each) ?? []) process.on(each, listener);
  }

  process.kill(process.pid, signal);
}

function listen(): void {
  if (listening) return;
  listening = true;

  for (const signal of CANCEL_SIGNALS) {
    before.set(signal, process.listeners(signal));
    process.removeAllListeners(signal);
    process.on(signal, listeners[signal]);
  }
}

/** Aborted, its reason the signal's name, once this process hears the run's cancel while a trial is open. */
export function runCancelled(): AbortSignal {
  listen();

  return cancelling.signal;
}

/** A trial's cancel: the run's, or vitest's own for the test (`signal`), whichever comes first. */
export function trialCancel(signal: AbortSignal | undefined): AbortSignal {
  return signal === undefined ? runCancelled() : AbortSignal.any([runCancelled(), signal]);
}

/** Run one trial: while it runs, the run's cancel ends it rather than this process. */
export async function duringTrial<T>(trial: () => Promise<T>): Promise<T> {
  listen();
  open += 1;

  try {
    return await trial();
  } finally {
    open -= 1;
  }
}
