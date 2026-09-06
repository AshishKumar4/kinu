import { type JsonFields, Digest, type JsonObject, type JsonValue } from "../core/index.js";
declare const structuralCodecBrand: unique symbol;
export interface StructuralCodec<Value> {
    readonly [structuralCodecBrand]: true;
    readonly encode: (value: Value) => JsonValue;
    readonly decode: (value: JsonValue) => Value;
}
/**
 * Creates a codec from trusted canonical functions. The returned operations cannot be
 * redirected; purity and determinism of supplied closures remain the SPEC section 14 trust
 * boundary.
 */
export declare function structuralCodec<Value>(encode: (value: Value) => JsonValue, decode: (value: JsonValue) => Value): StructuralCodec<Value>;
export declare function copyStructuralCodec<Value>(codec: StructuralCodec<Value>): StructuralCodec<Value>;
export declare function requireObject(value: JsonValue | undefined, subject: string): JsonObject;
export declare function requireExactObject<Field extends string>(value: JsonValue | undefined, fields: readonly Field[], subject: string): JsonFields<Field>;
export declare function requireString(object: JsonObject, key: string, subject?: string): string;
export declare function requireNullableString(object: JsonObject, key: string, subject?: string): string | undefined;
export declare function requireSafeInteger(object: JsonObject, key: string, subject?: string): number;
export declare function requireNonnegativeInteger(object: JsonObject, key: string): number;
export declare function requireDate(object: JsonObject, key: string): Date;
export declare function requireNullableDate(object: JsonObject, key: string): Date | undefined;
export declare function requireDigest(object: JsonObject, key: string): Digest;
export declare function requireArray(object: JsonObject, key: string): readonly JsonValue[];
export declare function requireCanonicalText(value: string, subject: string): void;
export declare function validDate(value: Date, subject: string): number;
export declare function sameJson(left: JsonValue, right: JsonValue): boolean;
export declare function immutableReference<Value>(value: Value): Value;
export {};
