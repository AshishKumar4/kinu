import { type JsonObject, type JsonValue } from "./json.js";
export interface RecordVersion {
    readonly major: number;
    readonly minor: number;
}
export interface RecordEnvelope {
    readonly kind: string;
    readonly version: RecordVersion;
    readonly payload: JsonValue;
}
export interface RecordClass<Record = object> {
    readonly prototype: Record;
}
export type RecordClasses<Record> = readonly [RecordClass<Record>, ...RecordClass[]];
export declare abstract class RecordCodec<Record> {
    #private;
    readonly kind: string;
    readonly version: RecordVersion;
    protected constructor(recordClasses: RecordClasses<Record>, kind: string, version: RecordVersion);
    encode(record: Record): Uint8Array;
    decode(bytes: Uint8Array): Record;
    protected abstract encodePayload(record: Record): JsonValue;
    protected abstract decodePayload(payload: JsonValue, version: RecordVersion): Record;
}
/**
 * The single §8.3 compatibility decision. Every reader — one record's codec and a whole
 * record set's declaration alike — asks this one predicate, so a record and the set that
 * holds it can never disagree about whether a stored version is readable.
 * Both components must already be non-negative safe integers.
 */
export declare function supportsRecordVersion(declared: RecordVersion, supported: RecordVersion): boolean;
/**
 * Names the refusal `supportsRecordVersion` earned: an unknown major fails as
 * codec.unknown-major and an unsupported newer minor fails as codec.invalid, while an
 * older minor tolerates read within the major.
 */
export declare function assertCompatibleRecordVersion(subject: string, declared: RecordVersion, supported: RecordVersion): void;
/**
 * One record kind and the codec version the records of that kind were written under.
 * A `RecordCodec` satisfies this shape, so a reader declares itself from its own codecs.
 */
export interface DeclaredCodecVersion {
    readonly kind: string;
    readonly version: RecordVersion;
}
/**
 * The §8.3 verdict a reader reaches from a record set's declaration before it decodes any
 * record of the set. The decision is total over declarations: the stored set is compatible,
 * or it names a kind this reader does not declare, or it names a version this reader's codec
 * refuses. There is no fourth answer and no undecided input.
 */
export declare abstract class CodecCompatibility {
    static get compatible(): CodecCompatibility;
    /**
     * Serves the reader only where the declaration is compatible. An incompatible set is
     * left exactly as stored — no repair, no downgrade, no partial rewrite — and no record
     * of it is decoded, so a derivation can never answer from the part that still reads.
     */
    abstract admit(serve: () => void): void;
    /** The refusal every operation over an incompatible record set owes its caller. */
    abstract requireCompatible(): void;
}
/**
 * The codec versions the records one Actor owns were written under (§8.3). It is
 * constituent data of the durable state a store already holds about its Actor, so a reader
 * reaches it before it decodes any record of the set, and never a durable plane of its own.
 */
export declare class CodecDeclaration {
    static get empty(): CodecDeclaration;
    /** The declaration a reader makes of itself, from the codecs it holds. */
    static of(codecs: Iterable<DeclaredCodecVersion>): CodecDeclaration;
    /**
     * One declaration over every reader that shares a record set (§8.3). A dispatcher's own
     * records and the records its registered commands write belong to one Actor, so the
     * declaration a reader compares against is their union. Two declarations naming one kind
     * at the same version are the same claim made twice and merge to one entry; naming it at
     * two versions is a wiring fault, because §8.4 rule 1 gives each record type exactly one
     * owning Actor and therefore exactly one writer's version.
     */
    static merge(declarations: Iterable<CodecDeclaration>): CodecDeclaration;
    readonly declared: readonly DeclaredCodecVersion[];
    constructor(declared: readonly DeclaredCodecVersion[]);
    static fromData(value: JsonValue | undefined): CodecDeclaration;
    /**
     * The stable raw form an Actor store carries before it decodes the Actor's record set.
     * It is deliberately NOT `encode`/`decode`: those names mean "through this record's own
     * RecordCodec" everywhere else, and this carrier has no codec on purpose, because a
     * future record codec is exactly what the reader is refusing to understand. Pairs with
     * `toData`/`fromData` on the same value.
     */
    static toBytes(declaration: CodecDeclaration): Uint8Array;
    static fromBytes(bytes: Uint8Array): CodecDeclaration;
    toData(): readonly JsonObject[];
    versionOf(kind: string): RecordVersion | undefined;
    /**
     * Whether a reader declaring `reader` may serve this stored set. The version question is
     * the one `supportsRecordVersion` already answers, so a record set and a single record
     * never disagree about whether a stored version is readable.
     */
    compatibilityWith(reader: CodecDeclaration): CodecCompatibility;
    equals(other: CodecDeclaration): boolean;
}
