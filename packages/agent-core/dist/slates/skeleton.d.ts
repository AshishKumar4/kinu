import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import { BindingRequirement } from "../facets/index.js";
/**
 * The credential-free export of a published Slate: the shape a forker receives and the
 * capabilities that shape needs, and nothing else (SPEC §4.6).
 *
 * The two admissible field types are what makes the absence structural rather than
 * reviewed. `sourceDigest` is a `Digest` and not a `ContentRef` on purpose: a record that
 * named a `ContentRef` would be a retainer of that content in whichever Tenant's
 * ContentStore read it (§8.2), so a skeleton admitted into a Scope that does not hold the
 * bytes would name content nothing there retains. A digest is inert identity — it lets an
 * importer prove the bytes they were handed are the ones the publisher declared, and
 * resolves to nothing on its own. `bindings` are `BindingRequirement`s, which are
 * declarations of a needed capability and never grants of one.
 */
export declare class SlateSkeleton {
    static get codec(): RecordCodec<SlateSkeleton>;
    readonly sourceDigest: Digest;
    readonly bindings: readonly BindingRequirement[];
    constructor(sourceDigest: Digest, bindings: readonly BindingRequirement[]);
    static encode(skeleton: SlateSkeleton): Uint8Array;
    static decode(bytes: Uint8Array): SlateSkeleton;
    toData(): JsonValue;
    static fromData(payload: JsonValue): SlateSkeleton;
}
