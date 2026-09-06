import { FacetCorrespondenceValidator, type ValidatedFacet } from "./correspondence.js";
import type { Facet } from "./runtime.js";
import type { BindingRequirement, FacetManifest, FacetRef } from "../facets/index.js";
export interface FacetRuntimeLease {
    readonly facet: ValidatedFacet;
    release(): void;
}
/**
 * The seam to §3.4 Binding resolution. A declared `BindingRequirement` resolves through the
 * Grant plane to an exact `FacetRef` in an exact protection domain and never to a name, so
 * this answers with that ref and nothing else: the authority plane stays outside
 * `src/operations`, and reliance keys on what the dependent actually reached.
 */
export declare abstract class FacetRequirementResolver {
    /** The exact live provider a declared requirement resolves to (SPEC §3.4), or nothing. */
    abstract resolve(dependent: FacetRef, requirement: BindingRequirement): FacetRef | undefined;
}
/**
 * Resolves nothing, so a host assembled without a Grant plane refuses every manifest that
 * declares a `BindingRequirement` rather than starting it degraded (SPEC §4.1). A manifest
 * declaring none activates unchanged.
 */
export declare class FailClosedFacetRequirementResolver extends FacetRequirementResolver {
    resolve(): undefined;
}
export declare class FacetRuntimeHost implements AsyncDisposable {
    #private;
    constructor(expected: readonly FacetManifest[], roots: readonly Facet[], validator?: FacetCorrespondenceValidator, requirements?: FacetRequirementResolver);
    get active(): boolean;
    activate(): Promise<void>;
    facet(ref: FacetRef): ValidatedFacet | undefined;
    facets(): readonly ValidatedFacet[];
    /**
     * The exact provider `FacetRef` this Facet's declared requirements resolved to, one entry
     * per distinct provider in manifest binding order (SPEC §4.1). Empty for a Facet that
     * declares no requirement, and for one whose own `stop` has returned.
     */
    relianceOf(dependent: FacetRef): readonly FacetRef[];
    /**
     * Every Facet still holding this exact provider through a resolved requirement. A Facet
     * answering the same Binding name from another `FacetRef` is not among them, and a Facet's
     * position in the child tree never puts it here (SPEC §4.1).
     */
    reliedUponBy(provider: FacetRef): readonly FacetRef[];
    acquire(ref: FacetRef, expected: ValidatedFacet): FacetRuntimeLease | undefined;
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
    private start;
    /**
     * SPEC §4.1: `start` is not called until every declared `BindingRequirement` resolves to a
     * live provider. The pass covers the whole activation before any Facet starts, so an
     * unresolvable requirement is a rejected install rather than a runtime failure found after
     * a partial start, and no Facet in the activation starts degraded.
     */
    private resolveRequirements;
    private stop;
    private context;
    private waitForDrain;
}
