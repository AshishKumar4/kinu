import { RecordCodec, Revision } from "../core/index.js";
import { ContributionAttribution, IngressDeclaration } from "../facets/index.js";
import { ScopeRef } from "../identity/index.js";
import { IngressEndpointId } from "./id.js";
export interface IngressEndpointInit {
    readonly id: IngressEndpointId;
    readonly revision: Revision;
    /** The target Scope the endpoint binds to: accepted input mints this Scope's Events. */
    readonly scope: ScopeRef;
    readonly declared: IngressDeclaration;
    /**
     * SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): present exactly when a Facet's
     * `ingress` contribution materialized this endpoint, absent when a caller declared it
     * directly. Its presence is what puts the endpoint in that Facet's §4.1 withdrawal set.
     */
    readonly contribution?: ContributionAttribution | undefined;
    /**
     * SPEC §4.1: present only on the revision a withdrawal writes. A retired endpoint is
     * no longer exposed: it verifies no request and mints no Event.
     */
    readonly retired?: true | undefined;
}
/**
 * A trusted materializer supplies the declared endpoint and its target Scope. The store
 * derives the initial revision, authenticated contribution attribution, and live state
 * itself.
 */
export type IngressEndpointMaterializationInit = Omit<IngressEndpointInit, "contribution" | "retired" | "revision">;
export declare class IngressEndpoint {
    static get codec(): RecordCodec<IngressEndpoint>;
    static encode(endpoint: IngressEndpoint): Uint8Array;
    static decode(bytes: Uint8Array): IngressEndpoint;
    readonly id: IngressEndpointId;
    readonly revision: Revision;
    readonly scope: ScopeRef;
    readonly declared: IngressDeclaration;
    readonly contribution: ContributionAttribution | undefined;
    readonly retired: true | undefined;
    constructor(init: IngressEndpointInit);
    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the retirement revision a withdrawal writes
     * for an endpoint its Facet's `ingress` contribution materialized. The declared shape,
     * the target Scope, and the attribution are carried through unchanged.
     */
    retire(): IngressEndpoint;
}
