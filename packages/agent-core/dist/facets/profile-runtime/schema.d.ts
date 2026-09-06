import { JsonSchema, type JsonSchemaDocument, type JsonValue } from "../../core/index.js";
export declare const EMPTY_OBJECT_SCHEMA: JsonSchema;
export declare const JSON_VALUE_SCHEMA: JsonSchema;
export declare function schema(document: JsonSchemaDocument): JsonSchema;
export declare function strictObjectSchema(properties: Readonly<Record<string, JsonValue>>, required?: readonly string[]): JsonSchema;
