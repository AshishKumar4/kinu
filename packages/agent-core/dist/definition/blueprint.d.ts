import { RecordCodec, SemVer, type JsonValue } from "../core/index.js";
import { type FacetDataMap } from "../facets/index.js";
import { Config, type ConfigInputMap } from "./config.js";
import { PackageId } from "./id.js";
import { PackageDependency } from "./package.js";
import { PolicySet } from "./policy.js";
export interface CanonicalDeclaration {
    toData(): JsonValue;
}
export type DeclarationInput = JsonValue | CanonicalDeclaration;
export interface PackageInstallInit {
    readonly request: PackageDependency;
    readonly config?: Config | ConfigInputMap;
}
export declare class PackageInstall {
    static get codec(): RecordCodec<PackageInstall>;
    readonly request: PackageDependency;
    readonly config: Config;
    constructor(init: PackageInstallInit);
    static encode(install: PackageInstall): Uint8Array;
    static decode(bytes: Uint8Array): PackageInstall;
    static fromData(value: JsonValue): PackageInstall;
    toData(): JsonValue;
}
export interface BlueprintMetaInit {
    readonly name: string;
    readonly version: SemVer;
}
export declare class BlueprintMeta {
    readonly name: string;
    readonly version: SemVer;
    constructor(name: string, version: SemVer);
    static fromData(value: JsonValue): BlueprintMeta;
    toData(): JsonValue;
}
export interface BlueprintInit {
    readonly meta: BlueprintMeta | BlueprintMetaInit;
    readonly packages: readonly PackageInstall[];
    readonly policies: PolicySet;
    readonly scopes?: DeclarationInput;
    readonly agents: readonly DeclarationInput[];
    readonly slots?: readonly DeclarationInput[];
    readonly subscriptions?: readonly DeclarationInput[];
    readonly environments?: readonly DeclarationInput[];
    readonly surfaces?: DeclarationInput;
}
export declare class Blueprint {
    static get codec(): RecordCodec<Blueprint>;
    readonly meta: BlueprintMeta;
    readonly packages: readonly PackageInstall[];
    readonly policies: PolicySet;
    readonly scopes: FacetDataMap | undefined;
    readonly agents: readonly FacetDataMap[];
    readonly slots: readonly FacetDataMap[] | undefined;
    readonly subscriptions: readonly FacetDataMap[] | undefined;
    readonly environments: readonly FacetDataMap[] | undefined;
    readonly surfaces: FacetDataMap | undefined;
    constructor(init: BlueprintInit);
    static encode(blueprint: Blueprint): Uint8Array;
    static decode(bytes: Uint8Array): Blueprint;
    static fromData(value: JsonValue): Blueprint;
    root(id: PackageId | string): PackageInstall | undefined;
    toData(): JsonValue;
}
