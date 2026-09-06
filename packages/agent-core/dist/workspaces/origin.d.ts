import { ActorRef } from "../actors/index.js";
import type { LeaseToken } from "../agents/index.js";
import { ContentRef, Digest } from "../core/index.js";
import { EventKind, type EventVisibility } from "../facets/index.js";
import { type ScopeRef } from "../identity/index.js";
import { CorrelationId, EventId } from "../interaction-references/index.js";
import { ContentRetentionReference } from "./retention.js";
import { EventProvenance, type EventSource } from "./value.js";
declare const intentToken: unique symbol;
export interface EventIntentInput {
    readonly id: EventId;
    readonly scope: ScopeRef;
    readonly sourceActor: ActorRef;
    readonly source: EventSource;
    readonly kind: EventKind;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
    readonly payloadRetention: ContentRetentionReference;
    readonly idempotencyKey: string;
    readonly correlation: CorrelationId;
    readonly causation?: EventId;
    readonly provenance: EventProvenance;
    readonly visibility: EventVisibility;
    readonly lease?: LeaseToken;
}
export declare class AuthenticatedEventIntent {
    readonly intent: EventIntentInput;
    readonly digest: Digest;
    constructor(token: typeof intentToken, intent: EventIntentInput);
}
export declare abstract class EventIntentAuthenticator {
    authenticate(input: EventIntentInput, evidence: Uint8Array): AuthenticatedEventIntent;
    protected abstract verify(message: Uint8Array, evidence: Uint8Array): boolean;
}
export declare function requireAuthenticatedEventIntent(value: AuthenticatedEventIntent): asserts value is AuthenticatedEventIntent;
export declare function eventIntentBytes(intent: EventIntentInput): Uint8Array;
export {};
