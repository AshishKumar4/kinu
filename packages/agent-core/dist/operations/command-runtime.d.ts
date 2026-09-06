import { Command, type Automation, type FacetData, type FacetPackageId, type FacetRef, type OperationDescriptor, type SurfaceId } from "../facets/index.js";
export interface CommandInstallationTarget {
    readonly package: FacetPackageId;
    readonly descriptor: OperationDescriptor;
}
export interface CommandInstallation {
    readonly contributor: FacetRef;
    readonly command: Command;
    readonly target: CommandInstallationTarget;
    readonly completion?: CommandInstallationTarget;
}
export interface InstalledCommand {
    readonly id: string;
    readonly scope: string;
    readonly contributor: FacetRef;
    readonly command: Command;
    readonly target: OperationDescriptor;
    readonly subscription: Automation;
}
export interface CommandInvocationOrigin {
    readonly surface: SurfaceId;
    readonly run?: Readonly<{
        readonly run: string;
        readonly branch: string;
    }>;
}
export interface CommandInvocationEvent {
    readonly id: string;
}
export interface CommandEventPort {
    invoked(installed: InstalledCommand, origin: CommandInvocationOrigin, input: FacetData): Promise<CommandInvocationEvent>;
}
export declare class CommandRuntime {
    #private;
    install(installation: CommandInstallation): InstalledCommand;
    /**
     * A Command invocation only emits `command.invoked` with the §4.3 step-4 correlation
     * (its Surface, and the Run when invoked from a conversation). Execution happens solely
     * through the derived Subscription and the workspace routing pipeline, which evaluates the
     * subscription's accepted trust, event dedupe, and initiator authority; no direct gateway
     * dispatch is permitted, as that would be an alternate authority source (§4.3). The returned
     * Event identity lets the Surface correlate the eventual `command.completed` (step 5).
     */
    invoke(installed: InstalledCommand, argumentsValue: FacetData, origin: CommandInvocationOrigin, events: CommandEventPort): Promise<CommandInvocationEvent>;
    bind(command: Command, argumentsValue: FacetData): FacetData;
    private requireInstalled;
}
