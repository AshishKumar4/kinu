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

/**
 * A method as a caller in another object sees it: a thrown error arrives as a plain `Error` with `remote`, its class
 * named in the message and nothing else kept. Measured in workerd at compat 2025-12-01 (kinu-logs/effect-plan
 * do-probe-result.json, 2026-09-23): a `KinuError('denied', 'refused by gate')` arrived as `KinuError: refused by gate`.
 */
export function acrossRpc<Args extends readonly JsonValue[], Result>(
  method: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await method(...args);
    } catch (thrown) {
      const named = thrown instanceof Error && thrown.name !== 'Error' ? `${thrown.name}: ` : '';

      throw Object.assign(new Error(`${named}${thrown instanceof Error ? thrown.message : String(thrown)}`), { remote: true });
    }
  };
}
