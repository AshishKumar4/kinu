import { JsonSchema } from "../core/index.js";
import { Automation } from "./automation.js";
import type { FacetData } from "./data.js";
import { type TrustTier } from "./event.js";
import { BindingName, OperationRef, SlotName } from "./id.js";
import { FieldMapping } from "./mapping.js";
import { BoundOperationRef } from "./operation.js";
export interface CommandInit {
    readonly name: string;
    readonly title: string;
    readonly help?: string | undefined;
    readonly arguments: JsonSchema;
    readonly operation: OperationRef;
    readonly binding: BindingName;
    readonly mapping?: FieldMapping | undefined;
    readonly acceptedTrust?: readonly [TrustTier, ...TrustTier[]] | undefined;
    readonly completion?: OperationRef | undefined;
    readonly surfaces: readonly SlotName[];
}
export declare class Command {
    readonly name: string;
    readonly title: string;
    readonly help: string | undefined;
    readonly arguments: JsonSchema;
    readonly operation: OperationRef;
    readonly binding: BindingName;
    readonly mapping: FieldMapping | undefined;
    readonly acceptedTrust: readonly [TrustTier, ...TrustTier[]] | undefined;
    readonly completion: OperationRef | undefined;
    readonly surfaces: readonly SlotName[];
    readonly target: BoundOperationRef;
    constructor(init: CommandInit);
    static fromData(payload: FacetData): Command;
    static encode(command: Command): Uint8Array;
    static decode(bytes: Uint8Array): Command;
    toData(): FacetData;
}
export declare function commandInvocationSource(command: Command): string;
export declare function commandAutomation(command: Command): Automation;
