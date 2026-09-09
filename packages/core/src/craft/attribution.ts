/**
 * Crafted-tool failure attribution for compiled callables.
 *
 * `craftFailureMarker` (in-episode.ts) is the stamp that lets the host tell
 * "this artifact raised" from "the code around it did". Only a stamped failure
 * is blamed on a tool — `craftFailureBlame` matches on the marker and nothing
 * else — so an unstamped failure scores nobody. That is deliberate, and it is
 * also why a substrate that forgets to stamp does not fail loudly: it silently
 * under-counts, and the same crafted tool then earns a different fitness
 * depending on which backend ran it.
 *
 * The divergence is one line of carelessness apart: wrap each injected body and
 * a throw carries its tool's name, compile the stored source bare and it
 * rethrows unstamped. The wrapper belongs here, beside the marker it
 * applies, because the ONE thing that must not vary between backends is the
 * format.
 *
 * One form: {@link attributeCraftedFailure} wraps a compiled function. Every
 * backend holds a callable — a module per tool, not source text spliced into a
 * preamble the workerd loader compiles — so one wrapper is the whole story and
 * there is no second, text-level format to keep in step.
 */

import { craftInvocationError } from './in-episode';

/**
 * Wrap a compiled crafted tool so a failure names the artifact that raised.
 *
 * The original error rides as `cause`, so nothing about the diagnosis is lost.
 * Only the crafted body is inside the wrap: a failure in the host plumbing
 * around it is not the tool's fault and must not be stamped as if it were.
 */
export function attributeCraftedFailure<A extends readonly unknown[], R>(
  name: string,
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      throw craftInvocationError(name, err instanceof Error ? err : String(err));
    }
  };
}
