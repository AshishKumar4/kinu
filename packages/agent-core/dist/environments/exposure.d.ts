import { RecordCodec, Revision } from "../core/index.js";
import { EnvironmentId, EnvironmentSessionId, PortExposureId } from "./id.js";
export type PortExposureStateName = "exposing" | "exposed" | "failed" | "revoking" | "revoked";
export declare abstract class PortExposureState {
    static get exposing(): PortExposureState;
    static get exposed(): PortExposureState;
    static get failed(): PortExposureState;
    static get revoking(): PortExposureState;
    static get revoked(): PortExposureState;
    abstract readonly name: PortExposureStateName;
    exposed(): PortExposureState;
    fail(): PortExposureState;
    beginRevoke(): PortExposureState;
    revoked(): PortExposureState;
    protected invalid(operation: string): never;
}
export declare class PortExposure {
    readonly id: PortExposureId;
    readonly environmentId: EnvironmentId;
    readonly sessionId: EnvironmentSessionId;
    readonly environmentRevision: Revision;
    readonly generation: number;
    readonly sessionEpoch: number;
    readonly port: number;
    readonly state: PortExposureState;
    readonly url: string | undefined;
    readonly recordRevision: Revision;
    static get codec(): RecordCodec<PortExposure>;
    constructor(id: PortExposureId, environmentId: EnvironmentId, sessionId: EnvironmentSessionId, environmentRevision: Revision, generation: number, sessionEpoch: number, port: number, state: PortExposureState, url: string | undefined, recordRevision: Revision);
    static encode(exposure: PortExposure): Uint8Array;
    static decode(bytes: Uint8Array): PortExposure;
    exposed(url: string): PortExposure;
    fail(): PortExposure;
    beginRevoke(): PortExposure;
    revoked(): PortExposure;
    private transition;
}
