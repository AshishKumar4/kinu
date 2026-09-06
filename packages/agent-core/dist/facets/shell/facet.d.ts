import { Contributions, OperationDescriptor } from "../contribution.js";
import { type FilesystemFacet } from "../filesystem/index.js";
import { ShellExecutionId } from "./id.js";
import type { FacetManifest } from "../manifest.js";
import { DetailedProfileError, InternalProfileFacetRuntime, ProfileOperationContract, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export interface ShellIo {
    readonly stdin: AsyncIterable<Uint8Array>;
    writeStdout(chunk: Uint8Array): void;
    writeStderr(chunk: Uint8Array): void;
}
export declare abstract class ShellIoBackend {
    abstract open(executionId: ShellExecutionId): ShellIo;
}
export interface ShellEnvironmentBindingPort<Receipt> {
    readonly fs: FilesystemFacet<Receipt>;
}
export interface ShellCommandContext<Receipt> {
    readonly argv: readonly string[];
    readonly filesystem: FilesystemFacet<Receipt>;
    readonly io: ShellIo;
}
export interface ShellProcessBackend {
    readonly completion: Promise<number>;
    forceTerminate(): void;
    confirmTerminated(): boolean | Promise<boolean>;
    fence(): void;
}
export declare abstract class ShellTerminationClock {
    abstract wait(milliseconds: number): Promise<void>;
}
export declare class SystemShellTerminationClock extends ShellTerminationClock {
    wait(milliseconds: number): Promise<void>;
}
export interface ShellTerminationConfig {
    readonly confirmationMilliseconds: number;
    readonly terminatedExitCode?: number;
}
export declare class ShellExecutionBoundary {
    #private;
    private readonly process;
    private readonly clock;
    private readonly confirmationMilliseconds;
    constructor(process: ShellProcessBackend, clock: ShellTerminationClock, confirmationMilliseconds: number, terminatedExitCode?: number);
    wait(): Promise<number>;
    get live(): boolean;
    terminate(): Promise<void>;
    private terminateAfterProcessSettlement;
    private confirmedTermination;
    private fenceAndSettle;
    private settle;
}
export interface ShellCommand<Receipt> {
    start(context: ShellCommandContext<Receipt>): ShellProcessBackend;
}
export interface ShellRunInput extends PublicProfileInput {
    readonly executionId: ShellExecutionId;
    readonly commandLine: string;
}
export interface ShellCancelInput extends PublicProfileInput {
    readonly executionId: ShellExecutionId;
}
export declare const SHELL_OPERATION_CONTRACTS: Readonly<{
    run: ProfileOperationContract<"run", ShellRunInput, number, "output">;
    cancel: ProfileOperationContract<"cancel", ShellCancelInput, boolean, "output">;
}>;
export declare const SHELL_OPERATIONS: readonly OperationDescriptor[];
export declare const SHELL_CONTRIBUTIONS: Contributions;
export declare class ShellCommandRegistryBackend<Receipt> {
    #private;
    register(name: string, command: ShellCommand<Receipt>): void;
    resolve(name: string): ShellCommand<Receipt> | undefined;
}
export declare class ShellBackend<Receipt> {
    #private;
    private readonly environment;
    private readonly registry;
    private readonly io;
    private readonly termination;
    private readonly clock;
    constructor(environment: ShellEnvironmentBindingPort<Receipt>, registry: ShellCommandRegistryBackend<Receipt>, io: ShellIoBackend, termination?: ShellTerminationConfig, clock?: ShellTerminationClock);
    /**
     * SPEC §4.1 (C13-FACET-CANCELLATION-REACH): this call awaits the process under the
     * invocation's own lifetime, so it passes that invocation's cancellation on to the side
     * effect it owns. Cancellation runs the same termination a §11.2 `cancel` runs — the
     * force-terminate, the confirmation bound, and the fence — because a cancelled Turn and
     * an explicit cancel end one execution the same way, and the run still returns the exit
     * code the boundary settled on rather than abandoning its own wait.
     */
    run(request: ShellRunInput, cancellation?: AbortSignal): Promise<number>;
    cancel(executionId: ShellExecutionId): Promise<boolean>;
}
export declare class ShellFacet<Receipt> {
    private readonly runtime;
    private readonly backend;
    static readonly operations: readonly OperationDescriptor[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, backend: ShellBackend<Receipt>);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    run(input: ShellRunInput): Promise<number>;
    cancel(input: ShellCancelInput): Promise<boolean>;
}
export type ShellErrorCode = "command.empty" | "command.unknown" | "command.invalid" | "command.duplicate" | "execution.invalid";
export declare class ShellError extends DetailedProfileError<ShellErrorCode> {
    constructor(detailCode: ShellErrorCode, message: string);
}
export declare function tokenizeShellCommand(commandLine: string): string[];
