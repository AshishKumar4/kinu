import { Digest, Revision, type JsonFields, type JsonObject, type JsonValue, type RecordCodec } from "../core/index.js";
export { compareCanonicalText as compareText } from "../core/index.js";
export declare abstract class CodecRecord {
    static readonly encode: <Value>(this: {
        readonly codec: RecordCodec<Value>;
    }, value: Value) => Uint8Array;
    static readonly decode: <Value>(this: {
        readonly codec: RecordCodec<Value>;
    }, bytes: Uint8Array) => Value;
}
export declare function requireObject(value: JsonValue, subject: string): JsonObject;
export declare function requireExactFields<Field extends string>(value: JsonObject, required: readonly Field[], optional: readonly string[], subject: string): asserts value is JsonFields<Field>;
export declare function isString(value: JsonValue | undefined): value is string;
export declare function isNumber(value: JsonValue | undefined): value is number;
export declare function requireString(value: JsonValue | undefined, subject: string): string;
export declare function requireOptionalString(value: JsonValue | undefined, subject: string): string | undefined;
export declare function requireInteger(value: JsonValue | undefined, subject: string): number;
export declare function requireTimestamp(value: JsonValue | undefined, subject: string): Date;
export declare function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[];
export declare function revisionData(revision: Revision): number;
export declare function revisionFromData(value: JsonValue | undefined, subject: string): Revision;
export declare function digestFromData(value: JsonValue | undefined, subject: string): Digest;
export declare function bytesEqual(left: Uint8Array, right: Uint8Array): boolean;
