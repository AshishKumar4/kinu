import { type JsonValue } from "../../core/index.js";
import type { PrincipalRef } from "../../identity/index.js";
import { Command } from "../command.js";
import { Contributions, OperationDescriptor, SurfaceDescriptor } from "../contribution.js";
import type { FacetDataMap } from "../data.js";
import { EventDeclaration } from "../event.js";
import { DeviceCommandId, DeviceId } from "./id.js";
import type { FacetManifest } from "../manifest.js";
import { SlotDeclaration } from "../slot.js";
import { DetailedProfileError, InternalProfileFacetRuntime, ProfileControlContract, ProfileEffectContext, ProfileEventContract, ProfileOperationContract, type EffectDispatch, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export type LiveDeviceOperation = "camera" | "location" | "sms" | "screen" | "system.run";
export declare const LIVE_DEVICE_OPERATIONS: readonly LiveDeviceOperation[];
interface DeviceOperationInput<Arguments extends FacetDataMap> extends PublicProfileInput {
    readonly deviceId: DeviceId;
    readonly arguments: Arguments;
}
export type DeviceCameraInput = DeviceOperationInput<{
    readonly facing: "front" | "rear";
}>;
export type DeviceLocationInput = DeviceOperationInput<{
    readonly accuracyMeters?: number;
}>;
export type DeviceSmsInput = DeviceOperationInput<{
    readonly to: string;
    readonly message: string;
}>;
export type DeviceScreenInput = DeviceOperationInput<{
    readonly mode: "capture" | "stream";
}>;
export type DeviceSystemRunInput = DeviceOperationInput<{
    readonly command: string;
    readonly arguments?: readonly string[];
}>;
export type DeviceLiveInput = DeviceCameraInput | DeviceLocationInput | DeviceSmsInput | DeviceScreenInput | DeviceSystemRunInput;
export interface DeviceCachedInput extends PublicProfileInput {
    readonly deviceId: DeviceId;
    readonly key: string;
}
export interface DevicePairInput extends PublicProfileInput {
    readonly deviceId: DeviceId;
    readonly publicKey: string;
    readonly operatorApproval: string;
}
export interface DeviceCommandInput extends PublicProfileInput {
    readonly commandId: DeviceCommandId;
    readonly deviceId: DeviceId;
    readonly operation: LiveDeviceOperation;
    readonly arguments: JsonValue;
}
export interface DeviceCommandInvoked extends PublicProfileInput {
    readonly kind: "command.invoked";
    readonly commandId: DeviceCommandId;
    readonly operation: LiveDeviceOperation;
    readonly deviceId: DeviceId;
    readonly arguments: JsonValue;
}
export interface DeviceCommandCompleted extends PublicProfileInput {
    readonly kind: "command.completed";
    readonly commandId: DeviceCommandId;
    readonly succeeded: boolean;
    readonly result?: JsonValue;
}
export interface DeviceTransportRequest {
    readonly deviceId: DeviceId;
    readonly agentId: PrincipalRef;
    readonly operation: LiveDeviceOperation;
    readonly arguments: JsonValue;
}
export interface DeviceAdmission {
    readonly deviceId: DeviceId;
    readonly agentId: PrincipalRef;
    readonly admittedAt: number;
    readonly sequence: number;
}
export declare abstract class DeviceAgentBinding {
    abstract agent(): PrincipalRef;
}
export declare abstract class DeviceEnvironmentSessionDependency {
    abstract assertUsable(deviceId: DeviceId): void | Promise<void>;
}
export declare abstract class DeviceConsentBackend<Transaction = unknown> {
    #private;
    admit(transaction: Transaction, deviceId: DeviceId, agentId: PrincipalRef): DeviceAdmission;
    protected abstract assertLive(transaction: Transaction, deviceId: DeviceId, agentId: PrincipalRef): number;
}
export interface ReverseDeviceTransportBackend {
    /**
     * Delivers an admitted command to the paired device carrying its canonical effect
     * identity. The provider MUST treat `dispatch.idempotencyKey` as the dedup key for
     * the command and MUST be able to answer a reconciliation query addressed by
     * `dispatch.attempt` identity, so a crash-after-send retry neither delivers twice
     * nor stays indeterminate (SPEC §7.4).
     */
    send(request: DeviceTransportRequest, admission: DeviceAdmission, dispatch: EffectDispatch): Promise<JsonValue>;
    pair(deviceId: DeviceId, publicKey: string, operatorApproval: string): Promise<void>;
}
export interface DeviceResultCacheBackend {
    read(deviceId: DeviceId, key: string): JsonValue | undefined;
}
export declare class DeviceBackend {
    private readonly environment;
    private readonly transport;
    private readonly cache;
    constructor(environment: DeviceEnvironmentSessionDependency, transport: ReverseDeviceTransportBackend, cache: DeviceResultCacheBackend);
    pair(input: DevicePairInput): Promise<void>;
    execute(operation: LiveDeviceOperation, input: DeviceLiveInput, context: ProfileEffectContext): Promise<JsonValue>;
    readCached(input: DeviceCachedInput): JsonValue | undefined;
}
export declare const DEVICE_OPERATION_CONTRACTS: Readonly<{
    camera: ProfileOperationContract<"camera", DeviceCameraInput, JsonValue, "output">;
    location: ProfileOperationContract<"location", DeviceLocationInput, JsonValue, "output">;
    sms: ProfileOperationContract<"sms", DeviceSmsInput, JsonValue, "output">;
    screen: ProfileOperationContract<"screen", DeviceScreenInput, JsonValue, "output">;
    systemRun: ProfileOperationContract<"system.run", DeviceSystemRunInput, JsonValue, "output">;
    readCached: ProfileOperationContract<"readCached", DeviceCachedInput, JsonValue | undefined, "output">;
}>;
export declare const DEVICE_OPERATIONS: readonly OperationDescriptor[];
export declare const DEVICE_PAIR_CONTROL: ProfileControlContract<"device.pair", DevicePairInput, void>;
export declare const DEVICE_COMMAND_SURFACE: SurfaceDescriptor;
export declare const DEVICE_COMMAND_SLOT: SlotDeclaration;
export declare const DEVICE_COMMANDS: readonly Command[];
export declare const DEVICE_COMMAND_EVENTS: Readonly<{
    invoked: EventDeclaration;
    completed: EventDeclaration;
}>;
export declare const DEVICE_COMMAND_EVENT_CONTRACTS: Readonly<{
    invoked: ProfileEventContract<"command.invoked", DeviceCommandInvoked>;
    completed: ProfileEventContract<"command.completed", DeviceCommandCompleted>;
}>;
export declare const DEVICE_CONTRIBUTIONS: Contributions;
export declare class DeviceFacet<Receipt> {
    private readonly runtime;
    private readonly backend;
    static readonly operations: readonly OperationDescriptor[];
    static readonly commands: readonly Command[];
    static readonly events: readonly EventDeclaration[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, backend: DeviceBackend);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    pair(input: DevicePairInput): Promise<void>;
    camera(input: DeviceCameraInput): Promise<JsonValue>;
    location(input: DeviceLocationInput): Promise<JsonValue>;
    sms(input: DeviceSmsInput): Promise<JsonValue>;
    screen(input: DeviceScreenInput): Promise<JsonValue>;
    systemRun(input: DeviceSystemRunInput): Promise<JsonValue>;
    readCached(input: DeviceCachedInput): Promise<JsonValue | undefined>;
    command(input: DeviceCommandInput): Promise<JsonValue>;
    private invokeCommand;
    private invokeLiveCommand;
}
export declare class MemoryDeviceConsentBackend<Transaction = unknown> extends DeviceConsentBackend<Transaction> {
    #private;
    private readonly now;
    constructor(now?: () => number);
    grant(deviceId: DeviceId, agentId: PrincipalRef, expiresAt: number): void;
    revoke(deviceId: DeviceId, agentId: PrincipalRef): void;
    protected assertLive(_transaction: Transaction, deviceId: DeviceId, agentId: PrincipalRef): number;
}
export type DeviceErrorCode = "consent.denied" | "consent.invalid" | "consent.exhausted" | "command.invalid";
export declare class DeviceError extends DetailedProfileError<DeviceErrorCode> {
    constructor(detailCode: DeviceErrorCode, message: string);
}
export {};
