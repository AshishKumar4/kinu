import { RecordCodec } from "../core/index.js";
import { PrincipalId } from "./id.js";
export type PrincipalKind = "user" | "service" | "agent";
export type PrincipalStatus = "active" | "disabled";
export declare class Principal {
    #private;
    readonly id: PrincipalId;
    readonly kind: PrincipalKind;
    static get codec(): RecordCodec<Principal>;
    constructor(id: PrincipalId, kind: PrincipalKind, status: PrincipalStatus);
    static encode(principal: Principal): Uint8Array;
    static decode(bytes: Uint8Array): Principal;
    get canAct(): boolean;
    get status(): PrincipalStatus;
    disable(): Principal;
}
