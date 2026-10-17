/** Tri-state fetch: a failed fetch must never render as an empty answer or an endless spinner. */
import { useCallback, useEffect, useRef, useState } from "react";
import { readFailureText } from "@kinu.run/core";
import { Cause, Effect } from "effect";
import { detach } from "@kinu.run/core/obs";

export type AsyncResource<T> =
  | { status: "loading" }
  | { status: "error"; message: string;  last: T | null }
  | { status: "ready"; value: T };

/** A value already on screen stays while it revalidates. */
function beginLoad<T>(previous: AsyncResource<T>): AsyncResource<T> {
  if (previous.status === "ready") return previous;

  if (previous.status === "error" && previous.last !== null) return previous;

  return { status: "loading" };
}

export function loadSucceeded<T>(value: T): AsyncResource<T> {
  return { status: "ready", value };
}

export function loadFailed<T>(previous: AsyncResource<T>, thrown: { cause: unknown }): AsyncResource<T> {
  return { status: "error", message: readFailureText(thrown), last: lastValue(previous) };
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

/** Reload delay after a load, or null once nothing is left to watch. */
export type Revalidate<T> = (value: T | null) => number | null;

export interface AsyncResourceControl<T> {
  resource: AsyncResource<T>;
  reload: () => void;
  /** Publish a value already held so a dependent read never sees a stale copy while the reload is in flight. */
  set: (value: T) => void;
}

/** Reloads each time `moved` changes after the first render: the server said the read moved (`reads_changed`). */
export function useReloadWhenMoved(moved: number, reload: () => void): void {
  const seen = useRef(moved);

  useEffect(() => {
    if (seen.current === moved) return;
    seen.current = moved;
    reload();
  }, [moved, reload]);
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

  // Runs are numbered as they are asked. `shown` is the run whose answer is on screen.
  const runId = useRef(0);
  const shown = useRef(0);
  // What the newest run asked: an answer to another load or identity is another subject's, never this one's.
  const asking = useRef<{ load: () => Promise<T>; identity: string | undefined } | null>(null);

  // A task that settles after unmount must not publish into a retired resource.
  useEffect(() => () => {
    runId.current += 1;
    shown.current = runId.current;
  }, []);

  const run = useCallback((): void => {
    const id = ++runId.current;
    const subject = { load, identity };

    asking.current = subject;
    setState((previous) => ({
      identity,
      resource: beginLoad(previous.identity === identity ? previous.resource : { status: "loading" }),
    }));

    // An answer is shown if it was asked after the one on screen, though a newer run is still out: reloads asked
    // faster than they answer (a read the server says moved, through a running turn) would otherwise drop every answer
    // and hold the screen on its first (live-app-plans, rc15). A failure is shown only for the newest run, so a slow
    // failing load never overwrites its retry, and no older answer then covers it.
    detach(Effect.gen(function* () {
      const thrown = yield* Effect.catchCause(Effect.gen(function* () {
        const value = yield* Effect.promise(load);

        if (id > shown.current && asking.current?.load === subject.load && asking.current.identity === subject.identity) {
          shown.current = id;
          setState({ identity, resource: loadSucceeded(value) });
        }

        return null;
      }), (failed) => Effect.succeed({ cause: Cause.squash(failed) }));

      if (thrown === null || id !== runId.current) return;
      shown.current = id;
      setState((previous) => ({
        identity,
        resource: loadFailed(previous.identity === identity ? previous.resource : { status: "loading" }, thrown),
      }));
    }));
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
    shown.current = runId.current;
    setState({ identity, resource: loadSucceeded(value) });
  }, [identity]);

  return { resource, reload: run, set };
}
