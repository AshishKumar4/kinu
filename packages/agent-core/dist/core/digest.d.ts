import { TextId } from "./id.js";
export type DigestAlgorithm = "sha256";
export declare class Digest extends TextId {
    readonly algorithm: DigestAlgorithm;
    constructor(value: string, algorithm?: DigestAlgorithm);
    static sha256(bytes: Uint8Array): Digest;
}
