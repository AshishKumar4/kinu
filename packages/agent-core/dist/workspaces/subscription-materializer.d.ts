import { PackageInstallationProvenancePort, type PreparedPackageContribution } from "../definition/index.js";
import { WorkspacePersistence, type SubscriptionMaterializationInit } from "./persistence.js";
import { Subscription } from "./subscription.js";
/**
 * Materializes a Facet-contributed Subscription only while the authenticated package
 * installation provenance is current. It never accepts caller-supplied attribution.
 */
export declare class WorkspaceSubscriptionMaterializer<Read, Transaction, Context> {
    private readonly persistence;
    private readonly provenance;
    constructor(persistence: WorkspacePersistence<Transaction>, provenance: PackageInstallationProvenancePort<Read | Transaction, Context>);
    prepareContribution(read: Read, context: Context): PreparedPackageContribution | undefined;
    materialize(transaction: Transaction, context: Context, prepared: PreparedPackageContribution, init: SubscriptionMaterializationInit): Subscription;
}
