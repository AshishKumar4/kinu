import * as v from 'valibot';

const ObjectTreeSchema = v.record(v.string(), v.unknown());

/** Every object `freezeTree` froze, each a tree frozen to its leaves: a shallow `Object.freeze` is not one. */
const frozenTrees = new WeakSet<object>();

export function isFrozenTree(node: { readonly value: unknown }): boolean {
  const { value } = node;

  return typeof value === 'object' && value !== null && frozenTrees.has(value);
}

/** Byte views cannot be frozen and are skipped. */
export function freezeTree(node: { readonly value: unknown }): void {
  const { value } = node;

  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof URL) return;

  if (Array.isArray(value)) {
    for (const item of value) freezeTree({ value: item });
  } else if (v.is(ObjectTreeSchema, value)) {
    for (const item of Object.values(value)) freezeTree({ value: item });
  } else {
    return;
  }

  Object.freeze(value);
  frozenTrees.add(value);
}
