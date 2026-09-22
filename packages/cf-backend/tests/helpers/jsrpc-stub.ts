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
