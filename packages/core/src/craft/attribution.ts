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
 * Which is what happened. CF wrapped every injected body so a throw carried
 * its tool's name; the CLI compiled the stored source bare and rethrew
 * unstamped. Both wrappers belong here, beside the marker they apply, because
 * the ONE thing that must not vary between them is the format.
 *
 * One form: {@link attributeCraftedFailure} wraps a compiled function. The CF
 * path used to splice source text into a preamble the workerd loader compiled,
 * which needed its own text wrapper; the module-per-tool rebuild removed that
 * path, so every backend holds a callable and one wrapper is the whole story.
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
