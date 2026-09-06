import { Digest } from "../../core/index.js";
import { Contributions, OperationDescriptor } from "../contribution.js";
import type { FacetData } from "../data.js";
import type { FacetManifest } from "../manifest.js";
import { InternalProfileFacetRuntime, ProfileOperationContract, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export type FilesystemEntryKind = "file" | "directory";
/**
 * What the store found at the write target when it reached its atomic step. `absent` and
 * `present` are separate shapes rather than a nullable content field, so a backing store
 * cannot report a present target without naming the content it holds: the state that would
 * let a guarded write pass against content nobody looked at is unconstructable rather than
 * checked. `fold` is total, so every consumer answers both cases or does not compile.
 */
export declare abstract class FilesystemTargetState {
    static get absent(): FilesystemTargetState;
    static present(content: Uint8Array): FilesystemTargetState;
    abstract fold<Result>(cases: FilesystemTargetCases<Result>): Result;
}
export interface FilesystemTargetCases<Result> {
    readonly absent: () => Result;
    readonly present: (content: Uint8Array) => Result;
}
/**
 * A write mode owns the precondition that makes it distinct: `create` requires the target
 * absent, `replace` requires it present and holding the content the request names, `upsert`
 * requires nothing. The precondition is a per-case method rather than a caller-side branch,
 * so no write path can reach the store without discharging it.
 *
 * `replace` is the one parameterized case, and it is a factory taking its guard rather than a
 * singleton: a `replace` that names no content is unconstructable, which is what makes the
 * request carry its own proof of observation instead of the profile keeping a per-session
 * observed-state ledger. `create` and `upsert` carry no guard and stay argument-less getters,
 * so the illegal pairings — a guarded `create`, an unguarded `replace` — are unrepresentable.
 */
export declare abstract class FilesystemWriteMode {
    static get create(): FilesystemWriteMode;
    static replace(expected: Digest): FilesystemWriteMode;
    static get upsert(): FilesystemWriteMode;
    /** The wire label this mode serializes to. */
    abstract readonly name: string;
    /** Rejects the write when the target's state contradicts this mode's precondition. */
    abstract requireWritable(path: string, target: FilesystemTargetState): void;
    /** The wire form: the label, plus the guard for the one case that carries one. */
    abstract toData(): FacetData;
}
export interface FilesystemStat {
    readonly path: string;
    readonly kind: FilesystemEntryKind;
    readonly size: number;
    readonly modifiedAt: number;
}
export interface FilesystemReadRange {
    readonly offset?: number;
    readonly length?: number;
}
export interface FilesystemPage {
    readonly entries: readonly FilesystemStat[];
    readonly cursor?: string;
}
export interface FilesystemReadInput extends PublicProfileInput {
    readonly path: string;
    readonly range?: FilesystemReadRange;
}
export interface FilesystemStatInput extends PublicProfileInput {
    readonly path: string;
}
export interface FilesystemListInput extends PublicProfileInput {
    readonly path: string;
    readonly cursor?: string;
    readonly limit?: number;
}
/**
 * The mode is required rather than optional, and that requirement is what
 * `P11-FILESYSTEM-WRITE-UNOBSERVED` turns on: `upsert` is the profile's one write over
 * content the caller never read, so it has to be a declared intent a Workspace policy can
 * refuse. A declaration a caller may decline to make is not a declaration, so an omitted
 * mode is inadmissible here and at the backend seam, and no layer mints a default for it.
 */
export interface FilesystemWriteInput extends PublicProfileInput {
    readonly path: string;
    readonly content: Uint8Array;
    readonly mode: FilesystemWriteMode;
}
export interface FilesystemRemoveInput extends PublicProfileInput {
    readonly path: string;
}
export interface FilesystemMoveInput extends PublicProfileInput {
    readonly source: string;
    readonly destination: string;
}
export interface FilesystemMkdirInput extends PublicProfileInput {
    readonly path: string;
    readonly recursive?: boolean;
}
export declare const FILESYSTEM_OPERATION_CONTRACTS: Readonly<{
    read: ProfileOperationContract<"read", FilesystemReadInput, Uint8Array<ArrayBufferLike>, "output">;
    stat: ProfileOperationContract<"stat", FilesystemStatInput, FilesystemStat, "output">;
    list: ProfileOperationContract<"list", FilesystemListInput, FilesystemPage, "output">;
    write: ProfileOperationContract<"write", FilesystemWriteInput, void, "receipt">;
    remove: ProfileOperationContract<"remove", FilesystemRemoveInput, void, "receipt">;
    move: ProfileOperationContract<"move", FilesystemMoveInput, void, "receipt">;
    mkdir: ProfileOperationContract<"mkdir", FilesystemMkdirInput, void, "receipt">;
}>;
export declare const FILESYSTEM_OPERATIONS: readonly OperationDescriptor[];
export declare const FILESYSTEM_CONTRIBUTIONS: Contributions;
/**
 * The mutating seam. `write` takes the mode value object always: an omitted mode is
 * inadmissible here, so no backing store has an absent-mode branch to give a meaning to and
 * none of them mints `upsert` as a default. The unobserved overwrite
 * `P11-FILESYSTEM-WRITE-UNOBSERVED` permits stays reachable only by naming it.
 */
export declare abstract class FilesystemBackend {
    abstract read(path: string, range?: FilesystemReadRange): Uint8Array;
    abstract stat(path: string): FilesystemStat;
    abstract list(path: string, cursor?: string, limit?: number): FilesystemPage;
    abstract write(path: string, content: Uint8Array, mode: FilesystemWriteMode): void;
    abstract remove(path: string): void;
    abstract move(source: string, destination: string): void;
    abstract mkdir(path: string, recursive?: boolean): void;
}
export declare abstract class FilesystemReaderBackend {
    abstract read(path: string, range?: FilesystemReadRange): Uint8Array;
    abstract stat(path: string): FilesystemStat;
    abstract list(path: string, cursor?: string, limit?: number): FilesystemPage;
}
export declare class FilesystemFacet<Receipt> {
    private readonly runtime;
    private readonly backend;
    static readonly operations: readonly OperationDescriptor[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, backend: FilesystemBackend);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    read(input: FilesystemReadInput): Promise<Uint8Array>;
    stat(input: FilesystemStatInput): Promise<FilesystemStat>;
    list(input: FilesystemListInput): Promise<FilesystemPage>;
    write(input: FilesystemWriteInput): Promise<Receipt>;
    remove(input: FilesystemRemoveInput): Promise<Receipt>;
    move(input: FilesystemMoveInput): Promise<Receipt>;
    mkdir(input: FilesystemMkdirInput): Promise<Receipt>;
}
