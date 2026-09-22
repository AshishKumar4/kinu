/** Tri-state fetch: a failed fetch must never render as an empty answer or an endless spinner. */
import { useCallback, useEffect, useRef, useState } from "react";
import * as v from "valibot";

export type AsyncResource<T> =
  | { status: "loading" }
  | { status: "error"; message: string;  last: T | null }
  | { status: "ready"; value: T };

/** A value already on screen stays while it revalidates. */
export function beginLoad<T>(previous: AsyncResource<T>): AsyncResource<T> {
  if (previous.status === "ready") return previous;

  if (previous.status === "error" && previous.last !== null) return previous;

  return { status: "loading" };
}

export function loadSucceeded<T>(value: T): AsyncResource<T> {
  return { status: "ready", value };
}

export function loadFailed<T>(previous: AsyncResource<T>, thrown: { cause: unknown }): AsyncResource<T> {
  return { status: "error", message: describeError(thrown), last: lastValue(previous) };
}

export function lastValue<T>(resource: AsyncResource<T>): T | null {
  if (resource.status === "ready") return resource.value;

  if (resource.status === "error") return resource.last;

  return null;
}

/** Maps only the `ready` value; loading and failure pass through. */
export function mapResource<T, U>(resource: AsyncResource<T>, map: (value: T) => U): AsyncResource<U> {
  if (resource.status === "ready") return { status: "ready", value: map(resource.value) };

  if (resource.status === "error") {
    const last = resource.last === null ? null : map(resource.last);

    return { ...resource, last };
  }

  return resource;
}

/** Wrapped so the value crosses as a thrown thing, the shape `renderThrownChain` and `toKinuError` take. */
export function describeError({ cause }: { cause: unknown }): string {
  if (cause instanceof Error && cause.message) return cause.message;

  if (v.is(v.string(), cause) && cause.trim()) return cause;

  return "request failed";
}

/** Reload delay after a load, or null once nothing is left to watch. */
export type Revalidate<T> = (value: T | null) => number | null;

export interface AsyncResourceControl<T> {
  resource: AsyncResource<T>;
  reload: () => void;
  /** Publish a value already held so a dependent read never sees a stale copy while the reload is in flight. */
  set: (value: T) => void;
}

/** `load` and `revalidate` must be stable (useCallback): they are the effect keys. */
export function useAsyncResource<T>(
  load: () => Promise<T>,
  revalidate?: Revalidate<T>,
  identity?: string,
): AsyncResourceControl<T> {
  const [state, setState] = useState<{
    identity: string | undefined;
    resource: AsyncResource<T>;
  }>({ identity, resource: { status: "loading" } });

  const resource: AsyncResource<T> = state.identity === identity
    ? state.resource
    : { status: "loading" };

  // Only the newest run may write; a slow failing load must not overwrite its retry.
  const runId = useRef(0);
  // Reloads overlap; every task is retained until it settles, and the run id decides which publishes.
  const activeRuns = useRef(new Map<number, Promise<void>>());

  // A task that settles after unmount must not publish into a retired resource.
  useEffect(() => () => {
    runId.current += 1;
  }, []);

  const run = useCallback((): void => {
    const id = ++runId.current;
    setState((previous) => ({
      identity,
      resource: beginLoad(previous.identity === identity ? previous.resource : { status: "loading" }),
    }));
    let task: Promise<void> | null = null;
    task = (async () => {
      // Held until the newest-run check below, so a superseded load publishes nothing.
      let thrown: { cause: unknown } | null = null;

      try {
        const value = await load();

        if (id === runId.current) setState({ identity, resource: loadSucceeded(value) });
      } catch (error) {
        thrown = { cause: error };
      } finally {
        activeRuns.current.delete(id);
      }

      if (thrown === null || id !== runId.current) return;
      const failure = thrown;
      setState((previous) => ({
        identity,
        resource: loadFailed(previous.identity === identity ? previous.resource : { status: "loading" }, failure),
      }));
    })();
    activeRuns.current.set(id, task);
  }, [identity, load]);

  useEffect(() => { run(); }, [run]);

  // Revalidating a ready resource keeps its identity, so this arms one timer per load, not per render.
  useEffect(() => {
    if (!revalidate || resource.status === "loading") return;
    const delay = revalidate(lastValue(resource));

    if (delay === null) return;
    const timer = setTimeout(run, delay);

    return () => clearTimeout(timer);
  }, [resource, revalidate, run]);

  const set = useCallback((value: T): void => {
    runId.current += 1;
    setState({ identity, resource: loadSucceeded(value) });
  }, [identity]);

  return { resource, reload: run, set };
}
