import { Digest, RecordCodec, Revision, type JsonValue } from "../core/index.js";
import { PackagePin } from "../definition-references/index.js";
import { PlatformCompatibility } from "./compatibility.js";
import { PackageDependency } from "./package.js";
export { PackagePin };
export interface PackageLockInit {
    readonly target: PlatformCompatibility;
    readonly roots: readonly PackageDependency[];
    readonly snapshotRevision: Revision;
    readonly snapshotDigest: Digest;
    readonly packages: readonly PackagePin[];
}
export declare class PackageLock {
    static get codec(): RecordCodec<PackageLock>;
    readonly snapshotRevision: Revision;
    readonly snapshotDigest: Digest;
    readonly target: PlatformCompatibility;
    readonly roots: readonly PackageDependency[];
    readonly packages: readonly PackagePin[];
    readonly digest: Digest;
    constructor(init: PackageLockInit);
    static encode(lock: PackageLock): Uint8Array;
    static decode(bytes: Uint8Array): PackageLock;
    static fromData(payload: JsonValue): PackageLock;
    toData(): JsonValue;
}
