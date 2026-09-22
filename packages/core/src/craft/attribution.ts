// A backend that skips this wrapper under-counts failures silently: unstamped throws blame nobody.

import { craftInvocationError } from './in-episode';

/** Only the crafted body is wrapped; host plumbing failures must not be stamped. */
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
