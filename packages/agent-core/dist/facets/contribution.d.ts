import { JsonSchema } from "../core/index.js";
import { OperationAvailability } from "./authored-code.js";
import type { FacetData } from "./data.js";
import { OperationName, SlotName, SurfaceId } from "./id.js";
import type { Impact } from "./generated/enforcement/AgentCore/Facets/Enforcement.js";
export { claimHonorsEnforcementFloor, enforcementFloor } from "./generated/enforcement/AgentCore/Facets/Enforcement.js";
export type { EnforcementTier, Impact } from "./generated/enforcement/AgentCore/Facets/Enforcement.js";
export declare class OperationDescriptor {
    readonly name: OperationName;
    readonly impact: Impact;
    readonly input: JsonSchema;
    readonly output: JsonSchema;
    readonly help: string | undefined;
    /**
     * SPEC §4.1 (C13-FACET-CAPABILITY-ABSENCE): §4.4's target consent is a capability the
     * manifest offers by declaring it, so `true` and absence are the only two forms. A
     * mandatory boolean would answer "did the author consider interception" with the same
     * value it answers "did the author refuse it", give one meaning two `manifestDigest`
     * values under §5.2, and leave a field a later edit could flip.
     */
    readonly interceptable: true | undefined;
    /**
     * SPEC §4.7 (C13-FACET-CODE-AVAILABILITY): which caller this Operation is declared
     * for. Always present in memory and absent on the wire for `native`, so the offered
     * catalog and the set an isolate can reach are one declared fact.
     */
    readonly availability: OperationAvailability;
    constructor(name: OperationName, impact: Impact, input: JsonSchema, output: JsonSchema, help?: string, interceptable?: true, availability?: OperationAvailability);
    static fromData(payload: FacetData): OperationDescriptor;
    static encode(descriptor: OperationDescriptor): Uint8Array;
    static decode(bytes: Uint8Array): OperationDescriptor;
    toData(): FacetData;
}
export declare class SurfaceDescriptor {
    readonly id: SurfaceId;
    readonly title: string;
    readonly help: string | undefined;
    constructor(id: SurfaceId, title: string, help?: string);
    static fromData(payload: FacetData): SurfaceDescriptor;
    static encode(descriptor: SurfaceDescriptor): Uint8Array;
    static decode(bytes: Uint8Array): SurfaceDescriptor;
    toData(): FacetData;
}
export declare class Contribution {
    readonly slot: SlotName;
    readonly entries: readonly FacetData[];
    constructor(slot: SlotName, entries: readonly FacetData[]);
    static fromData(payload: FacetData): Contribution;
    static encode(contribution: Contribution): Uint8Array;
    static decode(bytes: Uint8Array): Contribution;
    toData(): FacetData;
}
export declare class Contributions {
    readonly entries: readonly Contribution[];
    constructor(entries: readonly Contribution[]);
    static empty(): Contributions;
    static encode(contributions: Contributions): Uint8Array;
    static decode(bytes: Uint8Array): Contributions;
    static fromMap(entries: Readonly<Record<string, readonly FacetData[]>>): Contributions;
    get(slot: SlotName): readonly FacetData[] | undefined;
    toData(): FacetData;
}
