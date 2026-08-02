/**
 * The one tri-state fetch primitive for the web UI.
 *
 * A failed fetch is not an empty answer. Nearly every surface here reads an
 * RPC that can fail, and collapsing that failure into `[]` renders a lie —
 * "No triggers registered", "no rewrites yet", "not connected" — while a
 * swallowed rejection leaves an eternal spinner. This owns the three states
 * those call sites actually have (loading / failed-and-retryable / loaded) so
 * they cannot be conflated again. ConnectedModelPicker's inline
 * `T[] | null | "error"` is the original of this pattern.
 *
 * The transitions are pure and separately tested; the hook is the thin React
 * binding over them.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncResource<T> =
  | { status: "loading" }
  | { status: "error"; message: string; /** The last value that did load, if any. */ last: T | null }
  | { status: "ready"; value: T };

/** Starting a (re)load — a value already on screen stays there while it
 *  revalidates, so a background refresh never blanks a working view. */
export function beginLoad<T>(previous: AsyncResource<T>): AsyncResource<T> {
  return previous.status === "ready" ? previous : { status: "loading" };
}

export function loadSucceeded<T>(value: T): AsyncResource<T> {
  return { status: "ready", value };
}

export function loadFailed<T>(previous: AsyncResource<T>, error: unknown): AsyncResource<T> {
  return { status: "error", message: describeError(error), last: lastValue(previous) };
}

/** The most recent successfully-loaded value, carried across a failure. */
export function lastValue<T>(resource: AsyncResource<T>): T | null {
  if (resource.status === "ready") return resource.value;
  if (resource.status === "error") return resource.last;
  return null;
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "request failed";
}

/**
 * Fetch `load` on mount and whenever its identity changes, exposing the
 * tri-state plus the retry every failed fetch needs. `load` must be stable
 * (useCallback) — it is the effect key.
 */
export function useAsyncResource<T>(load: () => Promise<T>): {
  resource: AsyncResource<T>;
  reload: () => void;
} {
  const [resource, setResource] = useState<AsyncResource<T>>({ status: "loading" });
  // Only the newest run may write: a slow failing load must not overwrite the
  // result of the retry that superseded it.
  const runId = useRef(0);

  const run = useCallback(() => {
    const id = ++runId.current;
    setResource(beginLoad);
    load().then(
      (value) => { if (id === runId.current) setResource(loadSucceeded(value)); },
      (error) => { if (id === runId.current) setResource((previous) => loadFailed(previous, error)); },
    );
  }, [load]);

  useEffect(() => { run(); }, [run]);

  return { resource, reload: run };
}
