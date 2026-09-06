import { RecordCodec, type JsonValue } from "../core/index.js";
import type { Impact } from "./contribution.js";
import { type FacetData, type FacetDataMap } from "./data.js";
export type CapabilityEffect = "allow" | "deny";
export declare function isCapabilityEffect(value: FacetData | undefined): value is CapabilityEffect;
export interface CapabilitySpecInit {
    readonly facetPattern: string;
    readonly operations?: readonly string[];
    readonly impacts: readonly [Impact, ...Impact[]];
    readonly argumentConstraints?: Readonly<Record<string, JsonValue>>;
}
export interface CapabilityIntent {
    readonly facet: string;
    readonly operation: string;
    readonly impact: Impact;
    readonly arguments: Readonly<Record<string, JsonValue>>;
}
export declare class CapabilitySpec {
    static get codec(): RecordCodec<CapabilitySpec>;
    readonly facetPattern: string;
    readonly operations: readonly string[];
    readonly impacts: readonly [Impact, ...Impact[]];
    readonly argumentConstraints: Readonly<Record<string, JsonValue>>;
    constructor(init: CapabilitySpecInit);
    static encode(spec: CapabilitySpec): Uint8Array;
    static decode(bytes: Uint8Array): CapabilitySpec;
    matches(intent: CapabilityIntent): boolean;
    /**
     * SPEC §3.4 rule 2: the candidate admits no Invocation this capability would refuse.
     *
     * A pattern covers another exactly when it matches the other pattern's own text —
     * `'*'` is the only metacharacter and a validated pattern never contains one as a
     * literal, so a parent literal can never absorb a child wildcard. That equivalence
     * with glob language containment is proved in both directions by the formal model
     * (`AgentCore.glob_covering_iff_containment`).
     */
    covers(candidate: CapabilitySpec): boolean;
    grantsElevation(): boolean;
    /**
     * SPEC §4.1: true exactly when every Facet this capability reaches is the one named, so
     * a withdrawal can retire it as one of the withdrawing Facet's own solely-naming Grants.
     * `'*'` is the only metacharacter and a validated pattern never carries one literally, so
     * a pattern reaches only the named Facet exactly when it is that Facet's own text; any
     * wildcard would also reach whatever else the Scope installs.
     */
    namesOnly(facet: string): boolean;
    equals(other: CapabilitySpec): boolean;
    toData(): FacetDataMap;
    static fromData(value: JsonValue | undefined): CapabilitySpec;
}
