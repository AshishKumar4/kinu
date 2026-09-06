import { PackageInstallationProvenancePort, type LoadedBlueprint, type PreparedPackageContribution } from "../definition/index.js";
import { ContributionAttribution, type WorkspaceSlotStore } from "../facets/index.js";
import type { ScopeRef } from "../identity/index.js";
import { type ValidatedFacetRuntime } from "../operations/index.js";
import { WorkspacePersistence } from "../workspaces/index.js";
import type { ControlTransaction } from "./facet-withdrawal.js";
type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];
export interface WorkspaceFacetMaterializationResult {
    readonly attribution: ContributionAttribution;
    readonly catalogEntries: number;
    readonly eventProducers: number;
    readonly ingressEndpoints: number;
    readonly interceptorEntries: number;
    readonly promptSections: number;
    readonly settingsLayers: number;
    readonly slotDeclarations: number;
    readonly slotEntries: number;
    readonly subscriptions: number;
    readonly surfaces: number;
}
/**
 * Materializes one started Facet's complete manifest through the Workspace Actor's real
 * primitive stores. Installation provenance is rechecked and consumed inside the caller's
 * synchronous transaction; every record either commits together or the transaction rolls
 * them all back.
 */
export declare class WorkspacePackageFacetMaterialization<Transaction, Read, Context, Loaded> {
    private readonly facetMaterializer;
    private readonly transaction;
    private readonly read;
    private readonly contextFor;
    constructor(facetMaterializer: WorkspaceFacetMaterializer<Transaction, Read, Context>, transaction: ControlTransaction<Transaction>, read: Read, contextFor: (facet: CorrespondentFacet) => Context);
    materialize(_loaded: LoadedBlueprint<Loaded>, facets: readonly CorrespondentFacet[]): void;
}
export declare class WorkspaceFacetMaterializer<Transaction, Read, Context> {
    private readonly persistence;
    private readonly slots;
    private readonly provenance;
    private readonly scope;
    constructor(persistence: WorkspacePersistence<Transaction>, slots: WorkspaceSlotStore<Transaction>, provenance: PackageInstallationProvenancePort<Read | Transaction, Context>, scope: ScopeRef);
    prepareContribution(read: Read, context: Context): PreparedPackageContribution | undefined;
    materialize(transaction: Transaction, context: Context, prepared: PreparedPackageContribution, facet: CorrespondentFacet): WorkspaceFacetMaterializationResult;
    discard(prepared: PreparedPackageContribution): void;
    private requireExactInstallation;
    private reconcile;
}
export {};
