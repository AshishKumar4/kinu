import { RecordCodec, type JsonSchemaDocument, type JsonValue, type Nonempty, type RecordVersion } from "../core/index.js";
export { compareCanonicalText as compareText } from "../core/index.js";
export type FacetData = JsonValue;
export type FacetDataMap = {
    readonly [name: string]: FacetData;
};
export declare function isFacetData(value: unknown): value is FacetData;
export declare function isFacetDataMap(value: unknown): value is FacetDataMap;
export declare function canonicalFacetData(value: FacetData): FacetData;
export declare function canonicalFacetDataMap(value: FacetDataMap): FacetDataMap;
export declare class DataRecordCodec<Record> extends RecordCodec<Record> {
    #private;
    constructor(recordClasses: readonly [
        {
            readonly prototype: Record;
        },
        ...{
            readonly prototype: object;
        }[]
    ], kind: string, encodeRecord: (record: Record) => FacetData, decodeRecord: (payload: FacetData, version: RecordVersion) => Record, version?: RecordVersion);
    protected encodePayload(record: Record): FacetData;
    protected decodePayload(payload: FacetData, version: RecordVersion): Record;
}
export declare function requireDataObject(value: FacetData | undefined, subject: string): FacetDataMap;
/**
 * A declaration's schema field, which JSON Schema states either as a document or as the
 * boolean that admits or rejects everything.
 */
export declare function requireSchemaDocument(value: FacetData | undefined, subject: string): JsonSchemaDocument;
/**
 * Builds a data record from named fields, dropping every field whose value is absent. An
 * optional field has to be missing rather than null: `requireExactFields` admits only the
 * fields a declaration names, and canonical JSON distinguishes an omitted key from an
 * explicit null, so encoding an absent field as null would change the record's identity.
 */
export declare function dataRecord(fields: {
    readonly [name: string]: FacetData | undefined;
}): FacetDataMap;
export declare function requireExactFields(value: FacetDataMap, required: readonly string[], optional?: readonly string[]): void;
export declare function isString(value: FacetData | undefined): value is string;
export declare function requireString(value: FacetData | undefined, subject: string): string;
export declare function requireOptionalString(value: FacetData | undefined, subject: string): string | undefined;
export declare function requireBoolean(value: FacetData | undefined, subject: string): boolean;
/**
 * SPEC §4.1 (C13-FACET-CAPABILITY-ABSENCE): a declared field that carries a capability
 * rather than a datum is present exactly when the capability is offered, absent otherwise,
 * and a present negative form is refused rather than read as absence. The returned
 * `true | undefined` is what keeps the two encodings from collapsing: a reader asking this
 * field whether the capability is offered cannot get the same answer for a host that never
 * declared it and for one that declared a refusal, and there is no second value a later
 * edit could flip. Every reader and every writer of such a field goes through this one
 * function, so no path exists on which the negative form survives.
 */
export declare function requireOfferedCapability(value: FacetData | undefined, subject: string): true | undefined;
/**
 * SPEC §4.1 (C13-FACET-CANCELLATION-REACH): refuses a declared schema that offers a
 * cancellation-carrying field, at any depth. A nested object is the same authored surface
 * one level down, so screening only the top level would leave the claim expressible. A
 * schema requires a name it never declares is screened as well, because a name required
 * where additional properties are admitted is still offered.
 */
export declare function requireCancellationFreeSchema(document: JsonSchemaDocument, subject: string): JsonSchemaDocument;
export declare function requireSafeInteger(value: FacetData | undefined, subject: string): number;
export declare function requireArray(value: FacetData | undefined, subject: string): readonly FacetData[];
/**
 * Reads the array of numbers that carries binary content through canonical JSON. The
 * caller supplies the whole message because the profile owning the field names it, not
 * this parser.
 */
export declare function requireBytes(value: FacetData | undefined, message: string): Uint8Array;
/**
 * Restates a chosen set of vocabulary values in the vocabulary's own canonical order, so
 * that two declarations naming the same values encode identically. Unknown, repeated, and
 * empty selections are rejected here rather than reaching a comparison downstream.
 */
export declare function canonicalOrder<Value extends string>(values: readonly Value[], order: readonly Value[], subject: string): Nonempty<Value>;
export declare function requireNonblank(value: string, subject: string): void;
/** Freezes a data value and everything beneath it in place, keeping the caller's type. */
export declare function freezeFacetData<Value extends FacetData>(value: Value): Value;
export declare function isNumber(value: FacetData | undefined): value is number;
