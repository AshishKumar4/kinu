import { Revision } from "../core/index.js";
import { type SynchronousResultGuard, type TransactionOperation } from "../actors/index.js";
import type { WorkspaceId } from "../identity/index.js";
import { SlotName, type SlotEntryId } from "./id.js";
import { InstalledSlot } from "./slot.js";
import { SlotEntry, type SlotContributionOrigin } from "./slot-entry.js";
import { WorkspaceSlotStore } from "./slot-store.js";
import { type RecordMap } from "./record-map.js";
interface MemorySlotState {
    revision: number;
    slots: RecordMap;
    entries: RecordMap;
}
export interface MemoryWorkspaceSlotSnapshot {
    readonly version: 1;
    readonly owner: string;
    readonly revision: number;
    readonly slots: readonly Uint8Array[];
    readonly entries: readonly Uint8Array[];
}
export declare class MemoryWorkspaceSlotStore extends WorkspaceSlotStore<MemorySlotState> {
    #private;
    constructor(owner: WorkspaceId);
    static restore(owner: WorkspaceId, snapshot: MemoryWorkspaceSlotSnapshot): MemoryWorkspaceSlotStore;
    transaction<Result>(operation: TransactionOperation<MemorySlotState, Result>, ..._guard: SynchronousResultGuard<Result>): Result;
    loadRevision(transaction: MemorySlotState): Revision;
    saveRevision(transaction: MemorySlotState, revision: Revision): void;
    loadSlot(transaction: MemorySlotState, name: SlotName): InstalledSlot | undefined;
    insertSlot(transaction: MemorySlotState, slot: InstalledSlot): void;
    retireSlot(transaction: MemorySlotState, name: SlotName): void;
    listSlots(transaction: MemorySlotState): readonly InstalledSlot[];
    loadEntry(transaction: MemorySlotState, id: SlotEntryId): SlotEntry | undefined;
    /**
     * A position lookup, not an assertion about the store's key discipline: `validateState`
     * owns that at every commit, so decoding here does not restate it.
     */
    loadEntryAt(transaction: MemorySlotState, origin: SlotContributionOrigin): SlotEntry | undefined;
    listEntries(transaction: MemorySlotState, slot: SlotName): readonly SlotEntry[];
    listAllEntries(transaction: MemorySlotState): readonly SlotEntry[];
    insertEntry(transaction: MemorySlotState, entry: SlotEntry): void;
    retireEntry(transaction: MemorySlotState, id: SlotEntryId): void;
    snapshot(): MemoryWorkspaceSlotSnapshot;
    private requireActive;
}
export {};
