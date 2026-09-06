import { Digest, SemVer } from "../../core/index.js";
import { MetadataSnapshot, PackageId, PackageLock, PackageRelease } from "../../definition/index.js";
import { TransactionalSqlite } from "./sqlite.js";
export declare class SqlitePackageStore {
    private readonly database;
    constructor(database: TransactionalSqlite);
    add(release: PackageRelease): void;
    get(id: PackageId, version: SemVer): PackageRelease | undefined;
    list(id?: PackageId): readonly PackageRelease[];
    addSnapshot(snapshot: MetadataSnapshot): void;
    getSnapshot(digest: Digest): MetadataSnapshot | undefined;
    listSnapshots(): readonly MetadataSnapshot[];
    addLock(lock: PackageLock): void;
    getLock(lockDigest: Digest): PackageLock | undefined;
    private findRelease;
    private listReleases;
    private findSnapshot;
    private findLock;
    private decodeSnapshot;
    private decodeRelease;
    private decodeLock;
}
