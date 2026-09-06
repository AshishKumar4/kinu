import type { SynchronousResultGuard, TransactionOperation } from "../actors/index.js";
import { Revision } from "../core/index.js";
import type { WorkspaceId } from "../identity/index.js";
import { ContributionAttribution } from "./attribution.js";
import { InstalledSlot } from "./slot.js";
import { SlotEntry, type SlotContributionOrigin } from "./slot-entry.js";
import type { SlotEntryId, SlotName } from "./id.js";
/**
 * The records one Workspace Slot Actor retires for one withdrawing contribution (SPEC
 * §4.1, C13-FACET-WITHDRAWAL-EXACT). It is produced by querying the whole attribution —
 * the exact FacetRef and PackagePin pair — and never by running an inverse the Facet
 * supplied, so it names exactly that release's own records and a record it does not name
 * is unchanged by the withdrawal. Another release of the same Facet is a different
 * contribution with a different set.
 */
export declare class SlotWithdrawalSet {
    readonly attribution: ContributionAttribution;
    readonly slots: readonly SlotName[];
    readonly entries: readonly SlotEntryId[];
    constructor(attribution: ContributionAttribution, slots: readonly SlotName[], entries: readonly SlotEntryId[]);
}
export declare abstract class WorkspaceSlotStore<Transaction> {
    readonly owner: WorkspaceId;
    constructor(owner: WorkspaceId);
    abstract transaction<Result>(operation: TransactionOperation<Transaction, Result>, ...guard: SynchronousResultGuard<Result>): Result;
    abstract loadRevision(transaction: Transaction): Revision;
    abstract saveRevision(transaction: Transaction, revision: Revision): void;
    abstract loadSlot(transaction: Transaction, name: SlotName): InstalledSlot | undefined;
    abstract insertSlot(transaction: Transaction, slot: InstalledSlot): void;
    abstract retireSlot(transaction: Transaction, name: SlotName): void;
    abstract listSlots(transaction: Transaction): readonly InstalledSlot[];
    abstract loadEntry(transaction: Transaction, id: SlotEntryId): SlotEntry | undefined;
    /**
     * The entry occupying a contribution's §4.2 position, or none. It is a separate lookup
     * from `loadEntry` because the two answer different questions: an id answers whether a
     * particular record is stored, an origin answers what a new contribution supersedes.
     */
    abstract loadEntryAt(transaction: Transaction, origin: SlotContributionOrigin): SlotEntry | undefined;
    abstract listEntries(transaction: Transaction, slot: SlotName): readonly SlotEntry[];
    abstract listAllEntries(transaction: Transaction): readonly SlotEntry[];
    abstract insertEntry(transaction: Transaction, entry: SlotEntry): void;
    abstract retireEntry(transaction: Transaction, id: SlotEntryId): void;
    revision(): Revision;
    slot(name: SlotName): InstalledSlot | undefined;
    entries(name: SlotName): readonly SlotEntry[];
    install(slot: InstalledSlot): Revision;
    /**
     * SPEC §4.2: a slot holds at most one entry per contributor per ordinal. Because the
     * entry id digests exactly the declared fields, re-materializing the same contribution
     * from the same release is the same record and changes nothing, while a contribution
     * whose value or source release changed supersedes its predecessor inside this one
     * transaction rather than accreting beside it.
     */
    contribute(entry: SlotEntry): Revision;
    /**
     * The origin exclusivity §4.2 requires, enforced where both implementations share it. A
     * storage primitive that admitted a second entry at one origin would make supersession
     * unobservable, so the refusal belongs to the seam rather than to each store.
     */
    protected requireFreeOrigin(transaction: Transaction, entry: SlotEntry): void;
    /**
     * Computes the withdrawal set by querying attribution. Decoding every stored record is
     * the query: a record whose attribution the store cannot read makes the set
     * incomputable, and the caller refuses the withdrawal rather than performing a partial
     * one.
     */
    withdrawalSet(transaction: Transaction, attribution: ContributionAttribution): SlotWithdrawalSet;
    /**
     * Refuses a set that holds a Slot declaration still carrying an entry attributed to a
     * Facet the same reconciliation retains. That is a refusal and never a deferral: the
     * retained contribution would name a Slot the resulting composition does not declare,
     * and that obligation has no discharging condition.
     */
    requireWithdrawable(transaction: Transaction, set: SlotWithdrawalSet): void;
    /**
     * Retires the named contribution's records inside the caller's control transaction and
     * reports whether any record changed.
     */
    retireWithdrawalSet(transaction: Transaction, attribution: ContributionAttribution): boolean;
    withdraw(attribution: ContributionAttribution): Revision;
}
export interface SlotQueryAuthorityPort<Viewer> {
    workspace(viewer: Viewer): WorkspaceId | undefined;
    canViewSlot(viewer: Viewer, slot: InstalledSlot): Promise<boolean>;
    canViewEntry(viewer: Viewer, slot: InstalledSlot, entry: SlotEntry): Promise<boolean>;
}
export declare abstract class SlotCatalog {
    abstract query(slot: SlotName): Promise<readonly SlotEntry[]>;
}
export declare class WorkspaceSlotCatalog<Viewer, Transaction> extends SlotCatalog {
    private readonly store;
    private readonly viewer;
    private readonly authority;
    constructor(store: WorkspaceSlotStore<Transaction>, viewer: Viewer, authority: SlotQueryAuthorityPort<Viewer>);
    query(slot: SlotName): Promise<readonly SlotEntry[]>;
}
