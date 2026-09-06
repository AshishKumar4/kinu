import { type JsonValue } from "./json.js";
export type JsonSchemaDocument = boolean | {
    readonly [key: string]: JsonValue;
};
export interface JsonSchemaValidator {
    validate(schema: JsonSchemaDocument, value: JsonValue): boolean;
}
export declare class StrictJsonSchemaValidator implements JsonSchemaValidator {
    #private;
    assertSchema(schema: JsonSchemaDocument): void;
    assertSupportedSchema(schema: JsonSchemaDocument): void;
    validate(schema: JsonSchemaDocument, value: JsonValue): boolean;
    private validateAndCompile;
}
export declare const strictJsonSchemaValidator: StrictJsonSchemaValidator;
export declare class JsonSchema {
    readonly document: JsonSchemaDocument;
    constructor(document: JsonSchemaDocument);
    static any(): JsonSchema;
    static encode(schema: JsonSchema): Uint8Array;
    static decode(bytes: Uint8Array): JsonSchema;
    accepts(value: unknown, validator?: JsonSchemaValidator): value is JsonValue;
    assertValid(): void;
    /**
     * The structural subset of assertValid: rejects unsupported dialects, references,
     * and formats without compiling. Declaration-time checks on first-party schemas
     * use this so module initialization stays within substrate startup CPU limits;
     * compilation still asserts the full schema on first validation.
     */
    assertSupported(): void;
}
