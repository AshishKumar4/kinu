import { type JsonValue } from "../core/index.js";
export type BlueprintDeclarationField = "scopes" | "agents" | "slots" | "subscriptions" | "environments" | "surfaces";
export interface BlueprintDeclarationCodec {
    readonly field: BlueprintDeclarationField;
    canonicalize(value: JsonValue): JsonValue;
}
export declare class BlueprintDeclarationCodecPort {
    #private;
    constructor(codecs: readonly BlueprintDeclarationCodec[]);
    canonicalize(field: BlueprintDeclarationField, value: JsonValue): JsonValue;
}
