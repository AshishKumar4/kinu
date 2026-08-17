/**
 * A test double with the SHAPE of a real JSRPC stub, not merely its methods.
 *
 * `env.SOMETHING.get(id)` and `getAgentByName(...)` hand back an object whose
 * methods are NOT own enumerable properties. That single fact is the difference
 * between these two lines:
 *
 *   Object.assign(view, stub)   // copies NOTHING. `view.method` is undefined.
 *   const view = stub           // works.
 *
 * Four call sites in cf-backend copied a stub that way. Three were measured
 * throwing on production — `vaultView.resolveEgressInjection is not a function`,
 * `vaultView.listEgressSecrets is not a function`,
 * `agentView.acceptContainerEvent is not a function` — and the fourth
 * (`runtime.ts`'s `rootView`, the approval policy) is the same pattern. All four
 * were covered by tests that passed, because every double was an object literal
 * and copying one of those works fine. The suite was measuring a shape
 * production never produces.
 *
 * So doubles for a stub are built here: a double that cannot reproduce the
 * failure cannot govern the fix.
 */

/**
 * Build a stub-shaped double from a method table.
 *
 * The methods live on the PROTOTYPE, so the double has no own enumerable keys —
 * which is exactly what makes `Object.assign` and `{ ...stub }` come back empty
 * while ordinary property access still resolves. The real binding returns a
 * Proxy rather than a prototype chain, but this is the property that bug turned
 * on, so it is the property the double reproduces.
 */
export function jsrpcStub<T extends object>(methods: T): T {
  // `Object.create` is typed `any` by the standard library; naming the binding
  // is what re-establishes the type, with no assertion to justify.
  const stub: T = Object.create(methods);
  return stub;
}
