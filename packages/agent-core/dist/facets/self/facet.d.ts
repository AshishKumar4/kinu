import type { JsonValue } from "../../core/index.js";
import { Contributions, OperationDescriptor } from "../contribution.js";
import type { FacetManifest } from "../manifest.js";
import { ProfileOperationContract, InternalProfileFacetRuntime, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export interface SelfCheckpointInput extends PublicProfileInput {
    readonly checkpoint: JsonValue;
}
export interface SelfCommitMessageInput extends PublicProfileInput {
    readonly message: JsonValue;
}
export interface SelfSpawnInput extends PublicProfileInput {
    readonly child: JsonValue;
}
export interface SelfFinishInput extends PublicProfileInput {
    readonly result: JsonValue;
}
export interface SelfMigrationInput extends PublicProfileInput {
    readonly migration: JsonValue;
}
export declare abstract class SelfRunDependency {
    abstract checkpoint(input: SelfCheckpointInput): Promise<JsonValue>;
    abstract commitMessage(input: SelfCommitMessageInput): Promise<JsonValue>;
    abstract spawn(input: SelfSpawnInput): Promise<JsonValue>;
    abstract finish(input: SelfFinishInput): Promise<JsonValue>;
    abstract proposeMigration(input: SelfMigrationInput): Promise<JsonValue>;
}
export declare const SELF_OPERATION_CONTRACTS: Readonly<{
    checkpoint: ProfileOperationContract<"checkpoint", SelfCheckpointInput, JsonValue, "output">;
    commitMessage: ProfileOperationContract<"commitMessage", SelfCommitMessageInput, JsonValue, "output">;
    spawn: ProfileOperationContract<"spawn", SelfSpawnInput, JsonValue, "output">;
    finish: ProfileOperationContract<"finish", SelfFinishInput, JsonValue, "output">;
    proposeMigration: ProfileOperationContract<"proposeMigration", SelfMigrationInput, JsonValue, "output">;
}>;
export declare const SELF_OPERATIONS: readonly OperationDescriptor[];
export declare const SELF_CONTRIBUTIONS: Contributions;
export declare class SelfFacet<Receipt> {
    private readonly runtime;
    private readonly run;
    static readonly operations: readonly OperationDescriptor[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, run: SelfRunDependency);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    checkpoint(input: SelfCheckpointInput): Promise<JsonValue>;
    commitMessage(input: SelfCommitMessageInput): Promise<JsonValue>;
    spawn(input: SelfSpawnInput): Promise<JsonValue>;
    finish(input: SelfFinishInput): Promise<JsonValue>;
    proposeMigration(input: SelfMigrationInput): Promise<JsonValue>;
}
