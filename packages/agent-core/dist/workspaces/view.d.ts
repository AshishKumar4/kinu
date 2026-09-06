import { Digest, JsonSchema, RecordCodec, Revision, type JsonValue } from "../core/index.js";
import { EventKind, SurfaceId, type TrustTier } from "../facets/index.js";
import { ActionId, EventCursor } from "./id.js";
import { SurfaceEpoch } from "./surface-epoch.js";
export interface ActionDescriptorInit {
    readonly id: ActionId;
    readonly label: string;
    readonly emits: EventKind;
    readonly arguments?: JsonSchema;
}
export declare class ActionDescriptor {
    static get codec(): RecordCodec<ActionDescriptor>;
    readonly id: ActionId;
    readonly label: string;
    readonly emits: EventKind;
    readonly arguments: JsonSchema | undefined;
    constructor(init: ActionDescriptorInit);
    static encode(action: ActionDescriptor): Uint8Array;
    static decode(bytes: Uint8Array): ActionDescriptor;
}
interface ViewBaseInit {
    readonly surface: SurfaceId;
    readonly epoch: SurfaceEpoch;
    readonly revision: Revision;
    readonly body: JsonValue;
    readonly actions: readonly ActionDescriptor[];
    readonly cursor: EventCursor;
    /**
     * SPEC §6.3: present exactly on the last View of a retired Surface, absent everywhere
     * else. Presence is the discriminator, exactly as `intentDigest` discriminates a
     * decision View, and a decision View may also be terminal.
     */
    readonly terminal?: true;
}
interface OrdinaryViewInit {
    readonly intentDigest?: never;
    readonly marks?: never;
}
interface DecisionViewInit {
    readonly intentDigest: Digest;
    readonly marks: readonly ViewMark[];
}
export type ViewInit = ViewBaseInit & (OrdinaryViewInit | DecisionViewInit);
export declare class ViewMark {
    static get codec(): RecordCodec<ViewMark>;
    readonly path: string;
    readonly tier: TrustTier;
    constructor(path: string, tier: TrustTier);
    static encode(mark: ViewMark): Uint8Array;
    static decode(bytes: Uint8Array): ViewMark;
}
export declare class View {
    static get codec(): RecordCodec<View>;
    static encode(view: View): Uint8Array;
    static decode(bytes: Uint8Array): View;
    readonly surface: SurfaceId;
    readonly epoch: SurfaceEpoch;
    readonly revision: Revision;
    readonly body: JsonValue;
    readonly actions: readonly ActionDescriptor[];
    readonly cursor: EventCursor;
    readonly intentDigest?: Digest;
    readonly marks?: readonly ViewMark[];
    readonly terminal?: true;
    constructor(init: ViewInit);
}
export interface ViewDeltaInit {
    readonly surface: SurfaceId;
    readonly epoch: SurfaceEpoch;
    readonly baseRevision: Revision;
    readonly revision: Revision;
    readonly patch: readonly JsonValue[];
    readonly cursor: EventCursor;
}
export declare class ViewDelta {
    static get codec(): RecordCodec<ViewDelta>;
    static encode(delta: ViewDelta): Uint8Array;
    static decode(bytes: Uint8Array): ViewDelta;
    readonly surface: SurfaceId;
    readonly epoch: SurfaceEpoch;
    readonly baseRevision: Revision;
    readonly revision: Revision;
    readonly patch: readonly JsonValue[];
    readonly cursor: EventCursor;
    constructor(init: ViewDeltaInit);
}
export interface JsonPatchEngine {
    apply(document: JsonValue, patch: readonly JsonValue[]): JsonValue;
}
/**
 * The RFC 6902 target of a ViewDelta: the parts of a View a patch may change. `surface`,
 * `epoch`, `revision`, and `cursor` are stream identity and position rather than body, so
 * they are absent here and no patch can reach them.
 */
export declare function viewDocument(view: View): JsonValue;
/**
 * SPEC §6.3: a retired Surface emits one final ViewDelta, the patch that adds `terminal`.
 * This is that patch, and `terminalViewDocument` is the document it produces, so the
 * durable delta states exactly the change the durable View records.
 */
export declare const TERMINAL_VIEW_PATCH: readonly JsonValue[];
export declare function terminalViewDocument(view: View): JsonValue;
/** The durable key of one View revision, and of the ViewDelta that produced it. */
export declare function viewRecordKey(view: View): string;
export declare function viewDeltaRecordKey(delta: ViewDelta): string;
export declare function viewFromDocument(previous: View, delta: ViewDelta, document: JsonValue): View;
export {};
