import { ContentRef, type JsonValue } from "../../core/index.js";
import { Contributions, OperationDescriptor } from "../contribution.js";
import type { FacetManifest } from "../manifest.js";
import { PromptContribution } from "../prompt.js";
import { DetailedProfileError, InternalProfileFacetRuntime, ProfileControlContract, ProfileOperationContract, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export interface MemoryAccessBackend {
    authorityForRemember(): string;
    canRead(authority: string): boolean;
    canForget(authority: string): boolean;
}
export interface MemoryIndexBackend {
    search(query: string): readonly string[];
    replace(entries: readonly MemoryEntry[], content: MemoryContentBackend): MemoryIndexBackend;
}
export interface MemoryContentBackend {
    resolve(content: ContentRef): JsonValue;
}
export interface RememberInput extends PublicProfileInput {
    readonly id: string;
    readonly content: ContentRef;
    readonly createdAt: number;
    readonly retainUntil?: number;
}
export interface RecallInput extends PublicProfileInput {
    readonly query: string;
    readonly limit?: number;
}
export interface ForgetInput extends PublicProfileInput {
    readonly id: string;
}
export interface MemoryPromptInput extends PublicProfileInput {
    readonly query: string;
    readonly limit?: number;
}
export interface MemoryPromptBounds {
    readonly maximumEntries: number;
    readonly maximumCharacters: number;
    readonly priority: number;
}
export declare class MemoryEntry {
    readonly id: string;
    readonly content: ContentRef;
    readonly authority: string;
    readonly createdAt: number;
    readonly retainUntil?: number | undefined;
    constructor(id: string, content: ContentRef, authority: string, createdAt: number, retainUntil?: number | undefined);
}
export declare const MEMORY_OPERATION_CONTRACTS: Readonly<{
    remember: ProfileOperationContract<"remember", RememberInput, MemoryEntry, "output">;
    recall: ProfileOperationContract<"recall", RecallInput, readonly MemoryEntry[], "output">;
    forget: ProfileOperationContract<"forget", ForgetInput, boolean, "output">;
}>;
export declare const MEMORY_OPERATIONS: readonly OperationDescriptor[];
export declare const MEMORY_PROMPT_CONTRIBUTION_DESCRIPTOR: PromptContribution;
export declare const MEMORY_PROMPT_CONTROL: ProfileControlContract<"memory.prompt", MemoryPromptInput, PromptContribution>;
export declare const MEMORY_CONTRIBUTIONS: Contributions;
export declare class MemoryBackend {
    #private;
    private readonly access;
    private readonly content;
    constructor(index: MemoryIndexBackend, access: MemoryAccessBackend, content: MemoryContentBackend);
    remember(input: RememberInput): MemoryEntry;
    recall(input: RecallInput): readonly MemoryEntry[];
    forget(input: ForgetInput): boolean;
    prune(now: number): readonly string[];
    rebuildIndex(): void;
    resolve(entry: MemoryEntry): JsonValue;
    private commit;
}
export declare class MemoryFacet<Receipt> {
    private readonly runtime;
    private readonly backend;
    private readonly promptBounds;
    static readonly operations: readonly OperationDescriptor[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, backend: MemoryBackend, promptBounds: MemoryPromptBounds);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    remember(input: RememberInput): Promise<MemoryEntry>;
    recall(input: RecallInput): Promise<readonly MemoryEntry[]>;
    forget(input: ForgetInput): Promise<boolean>;
    prompt(input: MemoryPromptInput): Promise<PromptContribution>;
}
export declare class InMemoryMemoryIndexBackend implements MemoryIndexBackend {
    #private;
    constructor(terms?: ReadonlyMap<string, ReadonlySet<string>>, all?: ReadonlySet<string>);
    search(query: string): readonly string[];
    replace(entries: readonly MemoryEntry[], content: MemoryContentBackend): MemoryIndexBackend;
}
export type MemoryErrorCode = "memory.exists" | "memory.limit" | "memory.time";
export declare class MemoryError extends DetailedProfileError<MemoryErrorCode> {
    constructor(detailCode: MemoryErrorCode, message: string);
}
