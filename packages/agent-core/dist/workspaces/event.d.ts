import { ContentRef, Digest, RecordCodec } from "../core/index.js";
import { EventKind, type EventVisibility, type TrustTier } from "../facets/index.js";
import { PrincipalRef, ScopeRef } from "../identity/index.js";
import { CorrelationId, EventId } from "../interaction-references/index.js";
import { EventProvenance, type EventSource } from "./value.js";
export interface EventInit {
    readonly id: EventId;
    readonly scope: ScopeRef;
    readonly source: EventSource;
    readonly kind: EventKind;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
    readonly idempotencyKey: string;
    readonly correlation: CorrelationId;
    readonly causation?: EventId;
    readonly provenance: EventProvenance;
    readonly trust: TrustTier;
    readonly visibility: EventVisibility;
    readonly initiator?: PrincipalRef;
}
export declare class Event {
    static get codec(): RecordCodec<Event>;
    static encode(event: Event): Uint8Array;
    static decode(bytes: Uint8Array): Event;
    readonly id: EventId;
    readonly scope: ScopeRef;
    readonly source: EventSource;
    readonly kind: EventKind;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
    readonly idempotencyKey: string;
    readonly correlation: CorrelationId;
    readonly causation: EventId | undefined;
    readonly provenance: EventProvenance;
    readonly trust: TrustTier;
    readonly visibility: EventVisibility;
    readonly initiator: PrincipalRef | undefined;
    constructor(init: EventInit);
}
