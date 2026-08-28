/**
 * The pairing key one tool call carries, minted at a provider boundary.
 *
 * A tool call and its result travel as separate messages joined by nothing but
 * this string: the durable transcript pairs them by it, the surface renders a
 * row by it, and a replayed transcript hands it back to the provider unchanged.
 * So the key has to be unique across every response of a turn, not just within
 * one response. A per-response POSITION is not — a turn whose second step also
 * opens with an unnamed tool call produces a second `…-1`, and the result of
 * the second step then pairs with the call of the first.
 *
 * A native id does not fix that on its own. An id a provider mints per RESPONSE
 * ("0", "1") repeats verbatim on the next response of the same turn, and an
 * empty id is a key that matches every other empty key, so both reproduce the
 * collision the position had. Scoping every id — native or not — to the
 * response that minted it is what makes the key unique, and keeping a usable
 * native id INSIDE the key means nothing readable is invented or discarded.
 */

/**
 * Characters a tool-call id may carry.
 *
 * The AI SDK provider adapters place this string verbatim into a JSON id field
 * — `tool_use.id` for Anthropic, `tool_call.id` / `tool_call_id` for the
 * OpenAI-compatible wire — with no encoding step of their own, so the ASCII
 * identifier set (letters, digits, `_`, `-`, `.`, `:`) is what every family
 * round-trips unchanged. Whitespace and non-ASCII are the classes a boundary
 * can normalize, truncate or reject on the way, and an empty string is not an
 * identifier at all.
 */
const PORTABLE_TOOL_CALL_ID = /^[A-Za-z0-9_.:-]+$/u;

export function isPortableToolCallId(id: string): boolean {
  return PORTABLE_TOOL_CALL_ID.test(id);
}

export interface ToolCallIdInput {
  /** Unique to ONE response — the half that makes the key collision-free. */
  readonly scope: string;
  /** What the provider called this call, if it named it at all. */
  readonly native?: string | null;
  /** Position in the response: the discriminator an unusable native id falls
   *  back to. */
  readonly index: number;
}

/** The pairing key for one tool call, scoped to the response that minted it.
 *  Pure and total: one input is one key, and every key is portable. */
export function toolCallIdFor({ scope, native, index }: ToolCallIdInput): string {
  const trimmed = (native ?? '').trim();
  const portable = isPortableToolCallId(trimmed);
  // Reuse and idempotence are the same rule: an id already scoped to this
  // response IS the key, so feeding an output back in as `native` — which is
  // what a replayed transcript does — is a fixed point, not a second scoping.
  if (portable && (trimmed.startsWith(`${scope}-n-`) || trimmed.startsWith(`${scope}-i-`))) return trimmed;
  // Native provider ids and positional fallbacks occupy disjoint namespaces:
  // native "1" can coexist with the first unnamed call in one response.
  return portable ? `${scope}-n-${trimmed}` : `${scope}-i-${index + 1}`;
}
