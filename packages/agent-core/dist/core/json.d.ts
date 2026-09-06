export type JsonPrimitive = boolean | number | string | null;
export type JsonObject = {
    readonly [key: string]: JsonValue;
};
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
/** A JsonObject whose named fields are known to be present. */
export type JsonFields<Field extends string> = JsonObject & {
    readonly [Key in Field]: JsonValue;
};
/** Every JavaScript value admitted through an untyped object-property boundary. */
export type UntrustedProperty = boolean | number | string | null | bigint | symbol | CallableFunction | readonly UntrustedProperty[] | ObjectRecord | undefined;
/** An object arriving as `unknown`, before any of its properties are narrowed. */
export type ObjectRecord = {
    readonly [key: string]: UntrustedProperty;
};
export declare function isJsonString(value: unknown): value is string;
export declare function isJsonNumber(value: unknown): value is number;
export declare function isJsonBoolean(value: unknown): value is boolean;
export declare function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[];
export declare function isJsonValue(value: unknown): value is JsonValue;
export declare function isJsonObject(value: JsonValue | undefined): value is JsonObject;
/**
 * The `unknown` counterpart of isJsonObject. Its recursive property-value type
 * covers the JavaScript value space without falsely claiming nested JSON, so
 * every member still requires its own domain predicate before use.
 */
export declare function isObjectRecord(value: unknown): value is ObjectRecord;
/** Exact own-key-set check for any object, without narrowing its member types. */
export declare function hasExactKeys<Value extends object>(value: Value, expected: readonly string[]): boolean;
export declare function hasExactJsonKeys<Field extends string>(value: JsonObject, expected: readonly Field[]): value is JsonFields<Field>;
/**
 * The decode boundary shared by every bounded context. Each context decodes the same
 * canonical JSON vocabulary — object, exact field set, string, boolean, non-negative
 * safe integer, array — but reports a malformed record in its own terms: identity
 * raises a `codec.invalid` AgentCoreError where the rest raise TypeError, and the
 * subject wording belongs to the record being decoded. Binding the checks to a failure
 * factory keeps one implementation of what canonical data is while leaving each
 * context its own error vocabulary.
 */
export interface JsonDataParser {
    object(value: JsonValue | undefined, subject: string): JsonObject;
    /**
     * Narrows to exactly `fields` — no missing and no unknown members. `malformed`
     * overrides the wording for contexts whose records describe that failure
     * differently.
     */
    exact<Field extends string>(value: JsonObject, fields: readonly Field[], subject: string, malformed?: string): JsonObject & JsonFields<Field>;
    string(value: JsonValue | undefined, subject: string): string;
    /** A string that must also carry at least one character. */
    nonemptyString(value: JsonValue | undefined, subject: string): string;
    /** JSON null stands for an absent string; any other non-string is malformed. */
    nullableString(value: JsonValue | undefined, subject: string): string | undefined;
    boolean(value: JsonValue | undefined, subject: string): boolean;
    safeInteger(value: JsonValue | undefined, subject: string): number;
    array(value: JsonValue | undefined, subject: string): readonly JsonValue[];
}
export declare function jsonDataParser(fail: (message: string) => Error): JsonDataParser;
