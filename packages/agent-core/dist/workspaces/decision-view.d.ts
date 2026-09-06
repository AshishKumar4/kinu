import { Digest, type JsonValue, type Revision } from "../core/index.js";
import { type FacetData, type SurfaceId, type TrustTier } from "../facets/index.js";
import { Event } from "./event.js";
import { type EventCursor } from "./id.js";
import type { SurfaceEpoch } from "./surface-epoch.js";
import { ActionDescriptor, View } from "./view.js";
/**
 * SPEC §6.3: the position a Surface renders one value in. Rendering as **data** is a
 * position and treatment a reasonable viewer reads as showing someone else's input — a
 * quoted or clearly labeled field. **Platform voice** is any position a viewer would
 * attribute to the platform itself: unquoted body copy, a headline, a button label
 * synthesized from the value. A value the host did not originate is admitted at the first
 * and refused at the second, and that refusal is the whole of the rendering conjunct: a
 * codec that preserved marks would still let a Surface put a marked value in a headline.
 */
export declare abstract class ViewPosition {
    static get data(): ViewPosition;
    static get platformVoice(): ViewPosition;
    /** Whether a value carrying provenance may be rendered here. */
    abstract admitsAttributed(): boolean;
    /** The wire label, which survives only inside this module's decoder. */
    abstract get label(): string;
    equals(other: ViewPosition): boolean;
}
export interface DecisionPlacementInit {
    /** JSON Pointer into the rendered View body, in §6.2's pointer vocabulary. */
    readonly path: string;
    readonly position: ViewPosition;
    /**
     * JSON Pointer into the decided input, present exactly when this position renders a
     * value the host did not originate. Absent means host-authored prose, so a Surface can
     * neither claim provenance for a value it invented nor omit it for one it copied.
     */
    readonly source?: string | undefined;
}
/** One rendered position of a decision View, and where its value came from. */
export declare class DecisionPlacement {
    readonly path: string;
    readonly position: ViewPosition;
    readonly source: string | undefined;
    constructor(init: DecisionPlacementInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): DecisionPlacement;
}
export interface DecisionRenderingInit {
    readonly body: JsonValue;
    readonly actions: readonly ActionDescriptor[];
    readonly placements: readonly DecisionPlacement[];
}
/**
 * What a Surface answers when it renders a decision (SPEC §6.3). `Surface.render` returns
 * generic `FacetData`, so this is the shape that answer must decode to before any of it
 * can become a durable decision View: every rendered position is declared exactly once,
 * and the ones carrying someone else's input say which input.
 */
export declare class DecisionRendering {
    readonly body: JsonValue;
    readonly actions: readonly ActionDescriptor[];
    readonly placements: readonly DecisionPlacement[];
    constructor(init: DecisionRenderingInit);
    static fromData(value: FacetData): DecisionRendering;
}
/**
 * The input one decision is about, carrying the tier the host derived for it (§6.1). The
 * tier is read off a record the host owns rather than supplied beside the value, because
 * C13-TRUST-HOST-DERIVED forbids a Facet asserting its own tier and the Surface that
 * renders the decision is exactly such a Facet.
 */
export declare abstract class DecidedInput {
    /** Arguments that reached this decision on one delivered Event: the Event's own tier. */
    static delivered(event: Event, value: JsonValue): DecidedInput;
    /**
     * Arguments a Turn executor assembled under its own valid lease. §6.1 assigns `self` to
     * exactly that emission and only the host may assign it, so there is no tier argument
     * here for a caller to choose.
     */
    static emitted(value: JsonValue): DecidedInput;
    abstract get tier(): TrustTier;
    abstract get value(): JsonValue;
}
export interface DecisionViewCompositionInit {
    readonly surface: SurfaceId;
    readonly epoch: SurfaceEpoch;
    readonly revision: Revision;
    readonly cursor: EventCursor;
    /** SPEC §7.3: the exact prepared intent this decision authorizes. */
    readonly intentDigest: Digest;
    readonly decided: DecidedInput;
    readonly rendering: DecisionRendering;
}
/**
 * SPEC §6.3: one decision View, composed rather than accepted. The marks are derived from
 * the decided input and its host-derived tier, so "every value the host did not originate
 * is marked" holds by construction rather than by a caller remembering to say so; the
 * intent digest is the prepared intent's own; and a rendering that puts an attributed
 * value in platform voice, that attributes a value the intent does not hold, that
 * attributes one it altered, that repeats the input's own text as host prose, or that
 * leaves a rendered position undeclared is refused before any of it becomes durable.
 */
export declare function composeDecisionView(init: DecisionViewCompositionInit): View;
/**
 * The patch a decision View's next revision states, member by member. A ViewDelta carries
 * an RFC 6902 patch against `viewDocument`, and what a new decision replaces is exactly
 * the rendered members plus the provenance, so the patch is written from the composed
 * View's own document rather than diffed out of it.
 */
export declare function decisionViewPatch(composed: View, previous: View): readonly JsonValue[];
