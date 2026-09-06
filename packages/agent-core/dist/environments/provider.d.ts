import { ContentRef, SecretRef, type Revision } from "../core/index.js";
import type { AttemptReceiptOutcome } from "../invocations/index.js";
import { ProviderId, type EnvironmentId, type EnvironmentSessionId, type EnvironmentSnapshotId, type PortExposureId } from "./id.js";
import { EnvironmentSessionCapability } from "./session.js";
export declare class ProviderDescriptor {
    readonly id: ProviderId;
    readonly version: string;
    readonly configuration: ContentRef;
    constructor(id: ProviderId, version: string, configuration: ContentRef);
    equals(other: ProviderDescriptor): boolean;
}
export type ProviderActionOutcomeName = AttemptReceiptOutcome;
export interface ProviderActionOutcome {
    readonly name: ProviderActionOutcomeName;
}
export declare const ProviderActionOutcome: Readonly<{
    succeeded: Readonly<{
        readonly name: "succeeded";
    }>;
    failed: Readonly<{
        readonly name: "failed";
    }>;
    indeterminate: Readonly<{
        readonly name: "indeterminate";
    }>;
}>;
export type ProviderResourceOutcome<Value> = {
    readonly name: "ready";
    readonly value: Value;
} | {
    readonly name: "absent";
} | {
    readonly name: "failed";
} | {
    readonly name: "indeterminate";
};
export declare const ProviderResourceOutcome: Readonly<{
    ready<Value>(value: Value): ProviderResourceOutcome<Value>;
    absent: Readonly<{
        readonly name: "absent";
    }>;
    failed: Readonly<{
        readonly name: "failed";
    }>;
    indeterminate: Readonly<{
        readonly name: "indeterminate";
    }>;
}>;
export declare function requireProviderActionOutcome(value: ProviderActionOutcome): ProviderActionOutcome;
export declare function requireProviderResourceOutcome<Value>(value: ProviderResourceOutcome<Value>, parser: ProviderReadyValueParser<Value>): ProviderResourceOutcome<Value>;
export declare abstract class ProviderReadyValueParser<Value> {
    static get contentRef(): ProviderReadyValueParser<ContentRef>;
    static get liveSession(): ProviderReadyValueParser<LiveEnvironmentSession>;
    static get exposureUrl(): ProviderReadyValueParser<string>;
    abstract parse(source: UnparsedProviderReadyValueSource): Value;
}
interface UnparsedProviderReadyValueSource {
    readonly value: unknown;
    readonly enumerable: boolean;
}
export interface EnvironmentSessionChild {
    dispose(): void | Promise<void>;
}
export interface LiveEnvironmentSession {
    readonly children: readonly EnvironmentSessionChild[];
    release(): void | Promise<void>;
}
export declare class EnvironmentCredentialProxyCapability {
    readonly session: EnvironmentSessionCapability;
    readonly generation: number;
    readonly credential: SecretRef;
    constructor(session: EnvironmentSessionCapability, generation: number, credential: SecretRef);
}
export declare abstract class EnvironmentCredentialIsolationProxy {
    abstract forward(capability: EnvironmentCredentialProxyCapability, request: ContentRef): Promise<ContentRef>;
}
interface GenerationPinnedRequest {
    readonly environmentId: EnvironmentId;
    readonly environmentRevision: Revision;
    readonly generation: number;
}
export interface OpenSessionRequest extends GenerationPinnedRequest {
    readonly sessionId: EnvironmentSessionId;
    readonly restore?: ContentRef;
}
export interface SnapshotEnvironmentRequest extends GenerationPinnedRequest {
    readonly sessionId: EnvironmentSessionId;
    readonly sessionEpoch: number;
    readonly snapshotId: EnvironmentSnapshotId;
}
export interface ExposePortRequest extends GenerationPinnedRequest {
    readonly sessionId: EnvironmentSessionId;
    readonly sessionEpoch: number;
    readonly exposureId: PortExposureId;
    readonly port: number;
}
export declare abstract class EnvironmentProvider {
    abstract readonly descriptor: ProviderDescriptor;
    abstract openSession(request: OpenSessionRequest): Promise<ProviderResourceOutcome<LiveEnvironmentSession>>;
    abstract inspectSession(request: OpenSessionRequest): Promise<ProviderResourceOutcome<LiveEnvironmentSession>>;
    abstract closeSession(request: OpenSessionRequest): Promise<ProviderActionOutcome>;
    abstract createSnapshot(request: SnapshotEnvironmentRequest): Promise<ProviderResourceOutcome<ContentRef>>;
    abstract inspectSnapshot(request: SnapshotEnvironmentRequest): Promise<ProviderResourceOutcome<ContentRef>>;
    abstract exposePort(request: ExposePortRequest): Promise<ProviderResourceOutcome<string>>;
    abstract inspectExposure(request: ExposePortRequest): Promise<ProviderResourceOutcome<string>>;
    abstract revokeExposure(request: ExposePortRequest): Promise<ProviderActionOutcome>;
}
export declare abstract class EnvironmentProviderRegistry {
    abstract resolve(descriptor: ProviderDescriptor): EnvironmentProvider | undefined;
}
export declare class MemoryEnvironmentProviderRegistry extends EnvironmentProviderRegistry {
    #private;
    constructor(providers: readonly EnvironmentProvider[]);
    resolve(descriptor: ProviderDescriptor): EnvironmentProvider | undefined;
}
export {};
