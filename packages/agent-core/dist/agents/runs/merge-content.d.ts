import { type ContentRef } from "../../core/index.js";
import type { ContentStore } from "../../content/index.js";
/**
 * The content a merge reads — the trees it resolves and the PolicySet its pins name — read
 * from a ContentStore before the merge's synchronous span. The store is asynchronous and the
 * span may not await (§8.5, §10.3), and a ContentRef is a content address, so bytes fetched
 * earlier are exactly the bytes the span would have fetched. Only bytes whose SHA-256 is the
 * address they were fetched under are ever held, so nothing downstream decodes a byte its ref
 * does not prove.
 */
export declare class MergeContent {
    #private;
    private constructor();
    /** Nothing prefetched: a merge that reads no content needs no more. */
    static get empty(): MergeContent;
    static load(store: ContentStore, refs: readonly ContentRef[]): Promise<MergeContent>;
    /**
     * The prefetched bytes at `ref`. A ref nobody prefetched is refused rather than fetched:
     * a fetch here would be an `await` inside the span this value exists to keep synchronous.
     */
    bytes(ref: ContentRef): Uint8Array;
}
