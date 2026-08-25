/**
 * Crafted-tool failure attribution, in the two substrates that need it.
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
 * Two forms, because the substrates differ and only the substrates differ:
 *
 *   - {@link attributeCraftedFailure} wraps a compiled function. Node/Bun
 *     compiles stored source in-process, so the host holds a callable.
 *   - {@link wrapCraftedBodyWithAttribution} wraps SOURCE TEXT. V8 isolates
 *     forbid runtime string compilation, so the CF path splices bodies into a
 *     preamble the workerd loader compiles — there is no callable to wrap on
 *     the host side, only text.
 */

import { craftFailureMarker, craftInvocationError } from './in-episode';

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

/**
 * Wrap crafted SOURCE TEXT so a throw out of the sandbox carries the marker.
 *
 * An IIFE, so the body keeps the lexical scope of the sandbox arrow it is
 * spliced into (`workspace.*`, the `tools` literal itself) exactly as an
 * unwrapped body did.
 *
 * The stored body sits alone between parentheses on its own lines. It is
 * model-authored and routinely ends in a `//` comment, which on one line would
 * swallow the rest of the wrapper and make the whole preamble — spliced into
 * EVERY execute — a syntax error that no crafted tool could survive.
 *
 * The marker is JSON-stringified rather than interpolated: the tool name
 * reaches this function off a durable row, and a name carrying a quote would
 * otherwise close the literal and rewrite the wrapper.
 */
export function wrapCraftedBodyWithAttribution(name: string, code: string): string {
  const marker = JSON.stringify(`${craftFailureMarker(name)} `);
  return `(() => { const __impl = (\n${code}\n); return async (...__a) => { try { return await __impl(...__a); } ` +
    `catch (__e) { throw new Error(${marker} + (__e && __e.message ? __e.message : String(__e)), { cause: __e }); } }; })()`;
}
