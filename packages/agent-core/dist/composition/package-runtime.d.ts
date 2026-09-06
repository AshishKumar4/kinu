import type { Revision } from "../core/index.js";
import { BlueprintLoader, PackageInstallationProvenancePort, type Blueprint, type LoadedBlueprint, type LoadedPackageModule, type PreparedPackageContribution } from "../definition/index.js";
import { InstalledSlot, SlotEntry, type ContributionAttribution, type Facet, type SlotName, type SlotWithdrawalSet, type WorkspaceSlotStore } from "../facets/index.js";
import { FacetRuntimeHost } from "../operations/internal.js";
import type { ValidatedFacetRuntime } from "../operations/index.js";
import type { CommandEnvelope, FacetSlotCommandBackend } from "../protocol/index.js";
type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];
export interface PackageFacetRoots<Loaded> {
    roots(modules: readonly LoadedPackageModule<Loaded>[]): readonly Facet[];
}
export interface PackageFacetMaterializationPort<Loaded> {
    materialize(loaded: LoadedBlueprint<Loaded>, facets: readonly CorrespondentFacet[]): void;
}
export declare class PackageFacetRuntime<Loaded> implements AsyncDisposable {
    #private;
    private readonly loader;
    private readonly facets;
    private readonly materialization;
    constructor(loader: BlueprintLoader<Loaded>, facets: PackageFacetRoots<Loaded>, materialization: PackageFacetMaterializationPort<Loaded>);
    get host(): FacetRuntimeHost | undefined;
    activate(blueprint: Blueprint): Promise<FacetRuntimeHost>;
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}
export interface FacetSlotAuthorityPort<Read, Transaction = Read> {
    permitsInstall(state: Read | Transaction, slot: InstalledSlot): boolean;
    permitsContribution(state: Read | Transaction, entry: SlotEntry): boolean;
    permitsWithdrawal(state: Read | Transaction, attribution: ContributionAttribution): boolean;
}
export interface FacetSlotReadPort<Read> {
    revision(read: Read): Revision;
    slot(read: Read, name: SlotName): InstalledSlot | undefined;
}
export declare class ProvenanceFacetSlotBackend<Transaction, Read> implements FacetSlotCommandBackend<Transaction, Read> {
    private readonly slots;
    private readonly provenance;
    private readonly authority;
    private readonly reads;
    constructor(slots: WorkspaceSlotStore<Transaction>, provenance: PackageInstallationProvenancePort<Read | Transaction, CommandEnvelope>, authority: FacetSlotAuthorityPort<Read, Transaction>, reads: FacetSlotReadPort<Read>);
    currentRevision(read: Read): Revision;
    permitsInstall(read: Read, slot: InstalledSlot): boolean;
    prepareContribution(read: Read, envelope: CommandEnvelope): PreparedPackageContribution | undefined;
    applyContribution(transaction: Transaction, envelope: CommandEnvelope, stamp: Parameters<PackageInstallationProvenancePort<Read | Transaction, CommandEnvelope>["resolveContributionForApply"]>[2], entry: SlotEntry): boolean;
    permitsContribution(read: Read, entry: SlotEntry): boolean;
    slot(read: Read, name: SlotName): InstalledSlot | undefined;
    applyInstall(transaction: Transaction, envelope: CommandEnvelope, stamp: Parameters<PackageInstallationProvenancePort<Read | Transaction, CommandEnvelope>["resolveContributionForApply"]>[2], slot: InstalledSlot): boolean;
    permitsWithdrawal(read: Read, attribution: ContributionAttribution): boolean;
    withdrawalSet(_read: Read, attribution: ContributionAttribution): SlotWithdrawalSet;
    applyWithdrawal(transaction: Transaction, attribution: ContributionAttribution): boolean;
    contribute(transaction: Transaction, entry: SlotEntry): boolean;
    advanceRevision(transaction: Transaction, expected: Revision): Revision;
}
export {};
