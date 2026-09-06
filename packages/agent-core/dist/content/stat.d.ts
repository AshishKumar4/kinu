import { ContentRef, Digest, RecordCodec } from "../core/index.js";
import { MediaHint } from "./media.js";
export declare class ContentStat {
    readonly ref: ContentRef;
    readonly digest: Digest;
    readonly size: number;
    static get codec(): RecordCodec<ContentStat>;
    readonly hint: MediaHint | undefined;
    constructor(ref: ContentRef, digest: Digest, size: number, hint?: MediaHint);
    static encode(stat: ContentStat): Uint8Array;
    static decode(bytes: Uint8Array): ContentStat;
}
