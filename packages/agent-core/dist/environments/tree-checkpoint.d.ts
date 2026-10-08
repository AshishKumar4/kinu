import { ContentRef, RecordCodec, type JsonValue } from "../core/index.js";
/**
 * One file of a tree checkpoint: the canonical relative path it stands at and the content
 * address of its bytes. A path is the one spelling of its location — nonempty `/`-separated
 * segments with no `.` or `..` — because a tree merge compares paths by value (§5.2.1), and
 * two spellings of one location would let a change on each side escape as two unrelated paths.
 */
export declare class TreeCheckpointEntry {
    readonly path: string;
    readonly content: ContentRef;
    constructor(path: string, content: ContentRef);
    toData(): JsonValue;
    static fromData(value: JsonValue): TreeCheckpointEntry;
}
/**
 * A tree checkpoint (§5.4): the filesystem state of an Environment as a content-addressed
 * snapshot, one entry per file in canonical path order. It is the record the bytes a
 * RunCommit's `treeCheckpoint` names decode to, so a merge reads which content stands at which
 * path off the snapshot itself rather than off a host's description of it.
 */
export declare class TreeCheckpoint {
    static get codec(): RecordCodec<TreeCheckpoint>;
    readonly entries: readonly TreeCheckpointEntry[];
    constructor(entries: readonly TreeCheckpointEntry[]);
    static encode(checkpoint: TreeCheckpoint): Uint8Array;
    static decode(bytes: Uint8Array): TreeCheckpoint;
    /** The content standing at `path`, or nothing where the tree has no file there. */
    content(path: string): ContentRef | undefined;
    equals(other: TreeCheckpoint): boolean;
    toData(): JsonValue;
    static fromData(value: JsonValue): TreeCheckpoint;
}
