/** The offset and length one `ByteRange` names inside content of a known size. */
export interface ByteRangeWindow {
    readonly offset: number;
    readonly length: number;
}
export declare class ByteRange {
    #private;
    private readonly offset;
    private readonly length;
    private constructor();
    static all(): ByteRange;
    static from(offset: number): ByteRange;
    static slice(offset: number, length: number): ByteRange;
    /**
     * The exact window this range names inside content of `size` bytes, refused rather
     * than clamped when it reaches past them. A store that carries its content in memory
     * has no use for this beyond `read`, but one that pushes a range down to a platform
     * that answers ranges itself — an R2 ranged `get`, an HTTP `Range` — needs the window
     * as data before it asks, and taking it from here is what keeps one refusal rule for
     * every substrate: the platform is only ever asked for bytes this range has already
     * proved are inside the content, so a platform that clamps an over-long range never
     * gets the chance to answer with fewer bytes than the caller asked for.
     */
    resolve(size: number): ByteRangeWindow;
    read(bytes: Uint8Array): Uint8Array;
}
