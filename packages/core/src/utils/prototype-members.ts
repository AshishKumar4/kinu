export interface RpcSurfaceSubject {
  readonly constructor: Function;
}

export function inheritedDescriptor(instance: RpcSurfaceSubject, name: string): PropertyDescriptor | undefined {
  for (let proto: object | null = Object.getPrototypeOf(instance);
       proto !== null && proto !== Object.prototype;
       proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);

    if (descriptor) return descriptor;
  }

  return undefined;
}
