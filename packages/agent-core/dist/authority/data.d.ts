import { type JsonFields, type JsonValue } from "../core/index.js";
export type JsonObject = {
    readonly [key: string]: JsonValue;
};
export declare function requireObject(value: JsonValue | undefined, name: string): JsonObject;
export declare function requireExact<Field extends string>(object: JsonObject, keys: readonly Field[], name: string): asserts object is JsonFields<Field>;
export declare function requireString(object: JsonObject, key: string, name?: string): string;
export declare function requireBoolean(object: JsonObject, key: string, name?: string): boolean;
export declare function requireSafeInteger(object: JsonObject, key: string, name?: string): number;
export declare function requireArray(value: JsonValue | undefined, name: string): readonly JsonValue[];
export declare function canonicalJson<Value extends JsonValue>(value: Value): Value;
export declare function bytesEqual(left: Uint8Array, right: Uint8Array): boolean;
