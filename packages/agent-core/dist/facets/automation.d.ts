import type { FacetData } from "./data.js";
import { EventPattern } from "./event.js";
import { BindingName, OperationRef } from "./id.js";
import { PayloadMapping } from "./mapping.js";
import { BoundOperationRef } from "./operation.js";
export type DedupePolicy = "none" | "event" | "causation" | "payload";
export type AutomationAuthority = "initiator" | "delegated";
export interface AutomationInit {
    readonly source: EventPattern;
    readonly target: OperationRef;
    readonly binding: BindingName;
    readonly mapping?: PayloadMapping | undefined;
    readonly dedupe?: DedupePolicy | undefined;
    readonly authority?: AutomationAuthority | undefined;
}
export declare class Automation {
    readonly source: EventPattern;
    readonly target: OperationRef;
    readonly binding: BindingName;
    readonly mapping: PayloadMapping | undefined;
    readonly dedupe: DedupePolicy | undefined;
    readonly authority: AutomationAuthority | undefined;
    readonly operation: BoundOperationRef;
    constructor(init: AutomationInit);
    static fromData(payload: FacetData): Automation;
    static encode(automation: Automation): Uint8Array;
    static decode(bytes: Uint8Array): Automation;
    toData(): FacetData;
}
