/** Tool-call pairing keys, scoped to the minting response: native and positional ids
 *  repeat across a turn's responses. */

/** ASCII identifier set every provider family round-trips verbatim in its JSON id field. */
const PORTABLE_TOOL_CALL_ID = /^[A-Za-z0-9_.:-]+$/u;

export function isPortableToolCallId(id: string): boolean {
  return PORTABLE_TOOL_CALL_ID.test(id);
}

export interface ToolCallIdInput {
  /** Unique to one response. */
  readonly scope: string;
  readonly native?: string | null;
  /** Fallback discriminator when the native id is unusable. */
  readonly index: number;
}

/** Pure and total; every key is portable. */
export function toolCallIdFor({ scope, native, index }: ToolCallIdInput): string {
  const trimmed = (native ?? '').trim();
  const portable = isPortableToolCallId(trimmed);

  // Idempotent: a replayed key is a fixed point.
  if (portable && (trimmed.startsWith(`${scope}-n-`) || trimmed.startsWith(`${scope}-i-`))) return trimmed;

  // Native and positional ids occupy disjoint namespaces.
  return portable ? `${scope}-n-${trimmed}` : `${scope}-i-${index + 1}`;
}
