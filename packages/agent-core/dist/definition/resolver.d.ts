import { PackageLock } from "./package-lock.js";
import { MetadataSnapshot, PackageDependency } from "./package.js";
import { PlatformCompatibility } from "./compatibility.js";
export declare class PackageResolver {
    resolve(snapshot: MetadataSnapshot, roots: readonly PackageDependency[], target: PlatformCompatibility): PackageLock;
}
export declare function resolvePackageLock(snapshot: MetadataSnapshot, roots: readonly PackageDependency[], target: PlatformCompatibility): PackageLock;
