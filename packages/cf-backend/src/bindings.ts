/**
 * The shape Worker code uses a Durable Object namespace through.
 *
 * Generic in the id for the same reason core's `PcUserNamespace` is: nothing
 * here reads the id beyond handing it straight back to `get`, so a caller that
 * mints its own names satisfies the port, while the deployment's binding —
 * which mints a `DurableObjectId` — satisfies it too.
 *
 * `Stub` is named by each port as a `Pick` of the object class, so a module
 * states the methods it reaches instead of the whole object.
 */
export interface ObjectNamespace<Id, Stub> {
  idFromName(name: string): Id;
  get(id: Id): Stub;
}
