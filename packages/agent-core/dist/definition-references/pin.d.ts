import { Digest, SemVer, type JsonValue } from "../core/index.js";
import { PackageId } from "./id.js";
export declare class PackagePin {
    readonly id: PackageId;
    readonly version: SemVer;
    readonly manifestDigest: Digest;
    readonly codeDigest: Digest;
    constructor(id: PackageId, version: SemVer, manifestDigest: Digest, codeDigest: Digest);
    static fromData(value: JsonValue): PackagePin;
    equals(other: PackagePin): boolean;
    toData(): JsonValue;
}
