import { JsonSchema, RecordCodec, SecretRef, type JsonValue } from "../core/index.js";
import type { PackageRelease } from "./package.js";
export type ConfigInput = null | boolean | number | string | SecretRef | readonly ConfigInput[] | {
    readonly [name: string]: ConfigInput;
};
export type ConfigInputMap = {
    readonly [name: string]: ConfigInput;
};
export type ConfigData = {
    readonly [name: string]: JsonValue;
};
export type SecretRefData = {
    readonly $secret: {
        readonly source: string;
        readonly provider: string;
        readonly id: string;
    };
};
export declare class Config {
    static get codec(): RecordCodec<Config>;
    readonly value: ConfigData;
    constructor(value: ConfigInputMap);
    static empty(): Config;
    static encode(config: Config): Uint8Array;
    static decode(bytes: Uint8Array): Config;
    static fromData(value: ConfigData): Config;
    toData(): ConfigData;
}
export declare const SECRET_REF_SCHEMA: JsonSchema;
export declare const BASE_CONFIG_SCHEMA: JsonSchema;
export declare function encodeSecretRef(reference: SecretRef): SecretRefData;
export declare function decodeSecretRef(value: JsonValue): SecretRef;
export declare function isSecretRefData(value: JsonValue): value is JsonValue & SecretRefData;
export declare function canonicalConfig(value: ConfigInputMap): ConfigData;
export declare function composeConfigSchema(base: JsonSchema, releases: readonly PackageRelease[]): JsonSchema;
