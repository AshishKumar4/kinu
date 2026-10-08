/** Byte views cannot be frozen and are skipped. */
export function freezeTree(node: { readonly value: unknown }): void {
  const { value } = node;

  // A leaf is skipped by its type, not by a failed schema check: a message tree holds far more leaves than objects.
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof URL) return;

  for (const item of Array.isArray(value) ? value : Object.values(value)) freezeTree({ value: item });

  Object.freeze(value);
}
