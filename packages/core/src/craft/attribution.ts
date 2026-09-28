// A backend that skips this wrapper under-counts failures silently: unstamped throws blame nobody.

import { Effect } from 'effect';
import { settle } from '../obs/index';
import { craftInvocationError } from './in-episode';

/** Only the crafted body is wrapped; host plumbing failures must not be stamped. */
export function attributeCraftedFailure<A extends readonly unknown[], R>(
  name: string,
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A): Promise<R> => settle(Effect.tryPromise({ try: () => Promise.resolve(fn(...args)), catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => Effect.die(craftInvocationError(name, failed.cause instanceof Error ? failed.cause : String(failed.cause)))),
  ));
}
