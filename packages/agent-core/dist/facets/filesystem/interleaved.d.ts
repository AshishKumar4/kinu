import { FilesystemBackend, type FilesystemPage, type FilesystemReadRange, type FilesystemStat, type FilesystemWriteMode } from "./facet.js";
/**
 * The seam that makes a guarded write's interleave expressible.
 *
 * `P11-FILESYSTEM-WRITE-GUARD-ATOMIC` is a claim about a window: the comparison and the
 * replacement occupy the single atomic step `P11-FILESYSTEM-ATOMIC-WRITE` already requires,
 * so no write lands between them. A synchronous backing store cannot exhibit that window at
 * all — nothing runs between its comparison and its set — so a test driving one directly can
 * only show the sequential case, which a host that reads, compares, and then writes through a
 * second store call passes just as easily. This wrapper splits the write at exactly the seam
 * the rule is about and hands the window to its caller: it discharges the mode's precondition
 * against the target state it observes, runs the landing armed for that crossing, and only
 * then reaches the wrapped store's atomic step with the mode still in hand.
 *
 * Carrying the mode into the store step is the point of the composition. The store discharges
 * the guard again, against the content it actually replaces, so a write that landed inside the
 * window surfaces as a rejection rather than as a replacement authorized by a comparison
 * against content it did not replace. A host that instead trusted the comparison this wrapper
 * already made — a precondition evaluated during §7.3 preparation and believed at effect time
 * — would apply that replacement, which is the time-of-check-to-time-of-use hole the rule
 * closes and what the conformance test for it has to be able to fail.
 */
export declare class InterleavedFilesystemBackend extends FilesystemBackend {
    #private;
    private readonly store;
    constructor(store: FilesystemBackend);
    /**
     * Arms the window fired between the next write's comparison and its replacement. One
     * shot, because a landing write is an event rather than a mode: a crossing that wants one
     * arms it again, and an unarmed seam is an ordinary pass-through to the store.
     */
    landBeforeReplacement(landing: () => void): void;
    read(path: string, range?: FilesystemReadRange): Uint8Array;
    stat(path: string): FilesystemStat;
    list(path: string, cursor?: string, limit?: number): FilesystemPage;
    write(path: string, content: Uint8Array, mode: FilesystemWriteMode): void;
    remove(path: string): void;
    move(source: string, destination: string): void;
    mkdir(path: string, recursive?: boolean): void;
    /**
     * What the store holds at the target, as the two-case value a precondition consumes.
     * `not-found` is the one rejection that means an absent target; every other code — a
     * directory at the target, a path that does not normalize — is the store's answer about
     * this write and reaches the caller unchanged rather than being retold as absence.
     */
    private target;
}
