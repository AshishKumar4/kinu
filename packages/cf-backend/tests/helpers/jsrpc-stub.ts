import type { JsonValue } from '@kinu.run/core';
/**
 * A double with the shape of a real JSRPC stub: methods are not own enumerable properties, so
 * `Object.assign(view, stub)` copies nothing. Object-literal doubles hid that from the suite.
 */

/** Methods live on the prototype, so `Object.assign` and `{ ...stub }` come back empty. */
export function jsrpcStub<T extends object>(methods: T): T {
  // Naming the binding re-types `Object.create`'s `any` without an assertion.
  const stub: T = Object.create(methods);

  return stub;
}

/** Native RPC at compat 2026-09-28 keeps an Error's name and own fields but loses its subclass.
 * The workerd error-compatibility test exercises the real transport; this double serves bun suites. */
export function acrossRpc<Args extends readonly JsonValue[], Result>(
  method: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await method(...args);
    } catch (thrown) {
      const remote = new Error(thrown instanceof Error ? thrown.message : String(thrown));

      if (thrown instanceof Error) {
        for (const key of Object.getOwnPropertyNames(thrown)) {
          if (key === 'stack') continue;
          const descriptor = Object.getOwnPropertyDescriptor(thrown, key);

          if (descriptor !== undefined) Object.defineProperty(remote, key, descriptor);
        }

        remote.name = thrown.name;
      }

      throw Object.assign(remote, { remote: true });
    }
  };
}
