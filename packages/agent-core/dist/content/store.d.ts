import type { ContentRef, Digest } from "../core/index.js";
import type { MediaHint } from "./media.js";
import type { ByteRange } from "./range.js";
import type { ContentStat } from "./stat.js";
export interface ContentPutResult {
    readonly ref: ContentRef;
    readonly digest: Digest;
}
export declare abstract class ContentStore {
    abstract put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult>;
    abstract get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array>;
    abstract stat(ref: ContentRef): Promise<ContentStat | undefined>;
}
