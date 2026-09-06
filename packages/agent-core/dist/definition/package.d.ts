import { CompatRange, type ContentRetentionField, Digest, JsonSchema, type JsonValue, RecordCodec, Revision, SemVer } from "../core/index.js";
import { FacetManifest, type FacetDataMap } from "../facets/index.js";
import { PackageId } from "./id.js";
import { PackageCodeManifest } from "./code-manifest.js";
export type PackageProvenance = FacetDataMap;
export declare class PackageDependency {
    readonly id: PackageId;
    readonly range: string;
    constructor(id: PackageId, range: string);
    static fromData(value: JsonValue): PackageDependency;
    toData(): JsonValue;
}
export interface PackageReleaseInit {
    readonly id: PackageId;
    readonly version: SemVer;
    readonly compatibility: CompatRange;
    readonly dependencies: readonly PackageDependency[];
    readonly manifests: readonly [FacetManifest, ...FacetManifest[]];
    readonly codeManifest: PackageCodeManifest;
    readonly manifestDigest?: Digest;
    readonly codeDigest?: Digest;
    readonly provenance: PackageProvenance;
    readonly configSchema?: JsonSchema;
}
export declare class PackageRelease {
    static get codec(): RecordCodec<PackageRelease>;
    readonly id: PackageId;
    readonly version: SemVer;
    readonly compatibility: CompatRange;
    readonly dependencies: readonly PackageDependency[];
    readonly manifests: readonly [FacetManifest, ...FacetManifest[]];
    readonly manifestDigest: Digest;
    readonly codeDigest: Digest;
    readonly codeManifest: PackageCodeManifest;
    readonly provenance: PackageProvenance;
    readonly configSchema: JsonSchema | undefined;
    constructor(init: PackageReleaseInit);
    static encode(release: PackageRelease): Uint8Array;
    static decode(bytes: Uint8Array): PackageRelease;
    static fromData(payload: JsonValue): PackageRelease;
    toData(): JsonValue;
}
export interface MetadataSnapshotInit {
    readonly revision: Revision;
    readonly releases: readonly PackageRelease[];
    readonly digest?: Digest;
}
export declare class MetadataSnapshot {
    static get codec(): RecordCodec<MetadataSnapshot>;
    readonly revision: Revision;
    readonly digest: Digest;
    readonly releases: readonly PackageRelease[];
    constructor(init: MetadataSnapshotInit);
    static encode(snapshot: MetadataSnapshot): Uint8Array;
    static decode(bytes: Uint8Array): MetadataSnapshot;
    static fromData(payload: JsonValue): MetadataSnapshot;
    releasesFor(id: PackageId): readonly PackageRelease[];
    toData(): JsonValue;
}
export declare function canonicalPackageRange(value: string): string;
/**
 * The module bytes one immutable release names (§8.4). The declared field path walks the
 * release's own code manifest, so the projection and the record registry read the same
 * shape: one entry per module, in the manifest's canonical specifier order.
 */
export declare function packageReleaseContentRetention(release: PackageRelease): readonly ContentRetentionField[];
/**
 * Every module byte range a metadata snapshot reaches through its releases (§8.4). A
 * snapshot is immutable and Tenant-owned, so it retains on write and releases only when the
 * Tenant's package plane drops the snapshot itself.
 */
export declare function metadataSnapshotContentRetention(snapshot: MetadataSnapshot): readonly ContentRetentionField[];
