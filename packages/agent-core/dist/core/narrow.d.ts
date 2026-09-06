/**
 * Narrowing primitives shared by every bounded context. Decoders reach the same
 * three questions everywhere — is this string one of a closed vocabulary, does this
 * sequence carry at least one entry, and is this sequence made only of strings — and
 * every answer is reachable through a predicate, never through an assertion on the
 * value itself.
 */
import type { JsonValue } from "./json.js";
export type Nonempty<Value> = readonly [Value, ...Value[]];
export declare function isMember<Value extends string>(vocabulary: readonly Value[], candidate: unknown): candidate is Value;
export declare function isNonempty<Value>(values: readonly Value[]): values is Nonempty<Value>;
/**
 * Array.isArray narrows a JsonValue to any[], so a decoder that checks its members
 * inline keeps no record of what it proved and has to assert each one back to string.
 * Asking this instead carries the answer into the type.
 */
export declare function isStringArray(candidate: JsonValue | undefined): candidate is readonly string[];
export declare function requireNonempty<Value>(values: readonly Value[], subject: string): Nonempty<Value>;
