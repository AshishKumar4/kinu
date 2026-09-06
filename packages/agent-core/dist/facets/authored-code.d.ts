import { ContentRef, type JsonValue } from "../core/index.js";
import type { FacetData } from "./data.js";
/**
 * The three consumers of the one §4.7 runtime shape. The set is closed: membership in
 * it is what marks code as agent-authored, so nothing else needs a runtime flag saying
 * so. The three differ in lifetime and in nothing else — a programmatic tool call's
 * isolate is gone when the submission ends, a Slate backend's outlives its deployment,
 * an agent-authored Facet's outlives every install that references it.
 */
export type AuthoredCodeConsumer = "programmaticToolCall" | "slateBackend" | "agentAuthoredFacet";
export declare const AUTHORED_CODE_CONSUMERS: readonly AuthoredCodeConsumer[];
export declare function requireAuthoredCodeConsumer(value: JsonValue | undefined, subject: string): AuthoredCodeConsumer;
/**
 * Which caller an Operation is declared for (SPEC §4.7): `native` offers it to the model
 * as a tool call, `code` to agent-authored code, `both` to either. Availability belongs to
 * the composition rather than to a submission, so the catalog §5.6 reconstructs and the
 * passed Binding set an isolate enforces read this one declaration instead of two a host
 * keeps in agreement.
 *
 * The three cases are singletons and equality is identity, so nothing can mint a fourth
 * availability or hold two unequal copies of one meaning.
 */
export declare abstract class OperationAvailability {
    static get native(): OperationAvailability;
    static get code(): OperationAvailability;
    static get both(): OperationAvailability;
    /**
     * An absent declaration reads as `native` (SPEC §4.7), so an author who never
     * considered code mode offers it nothing.
     */
    static fromData(value: FacetData | undefined): OperationAvailability;
    /** The wire label this availability declares itself with. */
    abstract readonly label: "native" | "code" | "both";
    /** May an isolate's passed Binding set name this Operation? */
    abstract get reachableByAuthoredCode(): boolean;
    /** Is it offered to the model as a tool call? */
    abstract get offeredToModel(): boolean;
    /**
     * SPEC §4.1's presence rule: `native` is already what an absent declaration means, so
     * its canonical wire form is the absent key. Writing the label too would give one
     * meaning two `manifestDigest` values (§5.2) for the same Operation.
     */
    toData(): FacetData | undefined;
    equals(other: OperationAvailability): boolean;
}
/**
 * Agent-authored code as the submission carries it: content-addressed modules and the
 * one they enter through. Nothing here says where the code will run — that is the
 * backing's business (§10.2) — and nothing here carries authority, because a §4.7
 * isolate holds only what is separately passed to it as Bindings.
 */
export declare class AuthoredCodeSource {
    readonly entry: string;
    readonly modules: ReadonlyMap<string, ContentRef>;
    constructor(entry: string, modules: ReadonlyMap<string, ContentRef>);
    static fromData(payload: FacetData): AuthoredCodeSource;
    toData(): FacetData;
}
