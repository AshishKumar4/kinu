import { Digest, RecordCodec, type JsonValue } from "../../core/index.js";
import { FacetRef, type IsolationMode } from "../../facets/index.js";
import { TurnId } from "../../execution-references/index.js";
import { CodecRecord } from "../record-data.js";
import { RunPins } from "./pins.js";
export interface PlacementPinInit {
    readonly facet: FacetRef;
    readonly manifest: readonly IsolationMode[];
    readonly policy: readonly IsolationMode[];
    readonly substrate: readonly IsolationMode[];
    readonly trust: readonly IsolationMode[];
    readonly selected: IsolationMode;
}
export declare class PlacementPin {
    readonly facet: FacetRef;
    readonly manifest: readonly IsolationMode[];
    readonly policy: readonly IsolationMode[];
    readonly substrate: readonly IsolationMode[];
    readonly trust: readonly IsolationMode[];
    readonly selected: IsolationMode;
    constructor(init: PlacementPinInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): PlacementPin;
}
export declare class TurnPlacementSnapshot extends CodecRecord {
    static get codec(): RecordCodec<TurnPlacementSnapshot>;
    readonly turn: TurnId;
    readonly pins: RunPins;
    readonly placements: readonly PlacementPin[];
    readonly digest: Digest;
    constructor(turn: TurnId, pins: RunPins, placements: readonly PlacementPin[]);
    /**
     * The Turn's FacetSet (SPEC §4.1, §5.3): the canonical-ordered, unique FacetRef
     * membership of the Turn's one composition view. The constructor already canonicalizes
     * and deduplicates `placements`, so this reads the captured record rather than holding a
     * second membership list beside it. A second list is what would make the Turn compose
     * two views, and §5.3 fixes it to one, which is why this is a derivation and never a
     * stored field.
     */
    get facetSet(): readonly FacetRef[];
    /**
     * Whether the Turn composes this Facet, answered from the captured set. Every membership
     * question goes through here, so no caller can answer one from the Scope's current
     * install records and get a different answer for the same Turn.
     */
    composes(facet: FacetRef): boolean;
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnPlacementSnapshot;
}
export declare const TurnPlacementSnapshotCodec: RecordCodec<TurnPlacementSnapshot>;
