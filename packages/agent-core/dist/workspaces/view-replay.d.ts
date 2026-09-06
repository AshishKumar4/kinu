import { Revision } from "../core/index.js";
import type { ActorRef } from "../actors/index.js";
import type { SurfaceId } from "../facets/index.js";
import type { TenantId } from "../identity/index.js";
import type { EventCursor } from "./id.js";
import { WorkspacePersistence } from "./persistence.js";
import { type ContentRetentionReference } from "./retention.js";
import type { SurfaceEpoch } from "./surface-epoch.js";
import { type JsonPatchEngine, View, ViewDelta } from "./view.js";
export type ViewReplayResult = {
    readonly kind: "snapshot";
    readonly view: View;
} | {
    readonly kind: "deltas";
    readonly base: Revision;
    readonly deltas: readonly ViewDelta[];
    readonly view: View;
};
export declare class ViewReplayProtocol<Transaction> {
    private readonly persistence;
    private readonly patches;
    private readonly actor;
    private readonly tenant;
    constructor(persistence: WorkspacePersistence<Transaction>, patches: JsonPatchEngine, actor: ActorRef, tenant: TenantId);
    publishSnapshot(transaction: Transaction, view: View, retentions: readonly ContentRetentionReference[]): void;
    publish(transaction: Transaction, delta: ViewDelta, viewRetentions: readonly ContentRetentionReference[], deltaRetentions: readonly ContentRetentionReference[]): View;
    /**
     * SPEC §6.3: resume from a client's cursor. The client presents the `cursor` of the last
     * View it holds, and this reader resolves that opaque position against the durable
     * records of the `(surface, epoch)` stream. A cursor this stream never carried is
     * refused, so a stale position and a foreign one are told rather than answered from the
     * beginning. A cursor presented for a retired epoch resolves against that epoch's own
     * records and returns its terminal revision through this one reader rather than an error
     * or another epoch's live View. The returned View carries `terminal`, so a client holding
     * no live handle can tell a stream that ended from one it may keep following.
     */
    replay(transaction: Transaction, surface: SurfaceId, epoch: SurfaceEpoch, after: EventCursor): ViewReplayResult;
    /**
     * A compaction floor is the host's own administrative choice over its own storage, not a
     * client resume position, so it stays a `Revision` rather than an opaque cursor.
     */
    compact(transaction: Transaction, surface: SurfaceId, epoch: SurfaceEpoch, retainFrom: Revision): void;
}
