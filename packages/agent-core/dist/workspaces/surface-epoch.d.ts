import { type JsonValue, type Revision } from "../core/index.js";
/**
 * SPEC §6.3: one registration generation of a static `SurfaceId`. A Surface keeps its id
 * across releases, so the id alone cannot tell one registration's View stream from the
 * stream of a later registration that reuses the id. The epoch does. The first stream of a
 * Surface is epoch 1, and the stream that opens after a retirement is the next ordinal, so
 * a retired stream stays readable at its own key forever while a new stream starts empty.
 */
export declare class SurfaceEpoch {
    #private;
    constructor(value: number);
    static isExact(value: unknown): value is SurfaceEpoch;
    static first(): SurfaceEpoch;
    get value(): number;
    /** The canonical text form composite stream keys and error messages are built from. */
    get text(): string;
    next(): SurfaceEpoch;
    equals(other: SurfaceEpoch): boolean;
}
export declare function decodeSurfaceEpoch(value: JsonValue | undefined, subject: string): SurfaceEpoch;
/**
 * The key of one View stream. Every View and ViewDelta storage path is keyed on this pair,
 * so a revision of one epoch can never answer a read of another. Canonical JSON keeps the
 * two components apart even when a Surface ID contains the delimiter.
 */
export declare function surfaceStreamKey(surface: string, epoch: SurfaceEpoch): string;
/**
 * The key of one revision within one View stream. The three components go into one canonical
 * tuple rather than being joined onto the stream key, because a delimiter join is not
 * injective: a Surface ID is unconstrained text, so appending a separator and a revision to
 * it lets two different revisions of two different Surfaces produce one key.
 */
export declare function surfaceRevisionKey(surface: string, epoch: SurfaceEpoch, revision: Revision): string;
