import { type JsonValue } from "./json.js";
export declare function encodeCanonicalJson(value: JsonValue): Uint8Array;
/**
 * An injective textual key for a typed tuple. Canonical JSON preserves component
 * boundaries even when a component contains a delimiter or control character.
 */
export declare function canonicalTupleKey(namespace: string, components: readonly JsonValue[]): string;
export declare function decodeCanonicalJson(bytes: Uint8Array): JsonValue;
/**
 * A detached copy of a canonical JSON value, taken by re-encoding and decoding it.
 * Callers use this to own data that reached them from somewhere else, so that later
 * writes through the original cannot reach the copy.
 */
export declare function canonicalJsonCopy<Value extends JsonValue>(value: Value): Value;
/** A canonicalJsonCopy that accepts no further writes, at any depth. */
export declare function frozenCanonicalJson<Value extends JsonValue>(value: Value): Value;
/** Orders text by ECMAScript UTF-16 code units, independent of host locale and ICU data. */
export declare function compareCanonicalText(left: string, right: string): number;
/** Equality by canonical bytes: the only sound way to compare two JSON values. */
export declare function canonicalJsonEqual(left: JsonValue, right: JsonValue): boolean;
