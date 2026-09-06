import { ContentRef, Digest, RecordCodec, SemVer, type JsonValue } from "../core/index.js";
import type { MediaHint } from "../content/index.js";
import { FacetPackageId } from "../facets/index.js";
export interface PackageCodeModuleInit {
    readonly specifier: string;
    readonly content: ContentRef;
    readonly media: MediaHint;
    readonly imports?: readonly string[];
}
export declare class PackageCodeModule {
    readonly specifier: string;
    readonly content: ContentRef;
    readonly media: MediaHint;
    readonly imports: readonly string[];
    constructor(init: PackageCodeModuleInit);
    static fromData(value: JsonValue): PackageCodeModule;
    toData(): JsonValue;
}
export interface PackageCodeEntrypointInit {
    readonly facet: FacetPackageId;
    readonly version: SemVer;
    readonly module: string;
    readonly exportName?: string;
}
export declare class PackageCodeEntrypoint {
    readonly facet: FacetPackageId;
    readonly version: SemVer;
    readonly module: string;
    readonly exportName: string;
    constructor(init: PackageCodeEntrypointInit);
    static fromData(value: JsonValue): PackageCodeEntrypoint;
    toData(): JsonValue;
}
export interface PackageCodeManifestInit {
    readonly modules: readonly [PackageCodeModule, ...PackageCodeModule[]];
    readonly entrypoints: readonly [PackageCodeEntrypoint, ...PackageCodeEntrypoint[]];
    readonly compatibilityDate: string;
    readonly digest?: Digest;
}
export declare class PackageCodeManifest {
    static get codec(): RecordCodec<PackageCodeManifest>;
    readonly modules: readonly [PackageCodeModule, ...PackageCodeModule[]];
    readonly entrypoints: readonly [PackageCodeEntrypoint, ...PackageCodeEntrypoint[]];
    readonly compatibilityDate: string;
    readonly digest: Digest;
    constructor(init: PackageCodeManifestInit);
    static encode(manifest: PackageCodeManifest): Uint8Array;
    static decode(bytes: Uint8Array): PackageCodeManifest;
    static fromData(value: JsonValue): PackageCodeManifest;
    module(specifier: string): PackageCodeModule | undefined;
    toData(): JsonValue;
}
