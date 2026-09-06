import { type JsonValue } from "../core/index.js";
import { EventPattern, PayloadMapping, type DedupePolicy, type TrustTier } from "../facets/index.js";
import type { PrincipalRef } from "../identity/index.js";
import { Event } from "./event.js";
import { type DerivedEventTrust } from "./value.js";
export interface TrustDerivationFacts {
    readonly authenticatedPrincipal?: PrincipalRef;
    readonly principalOwnsScope: boolean;
    readonly validTurnLease: boolean;
    readonly hostEmission: boolean;
}
export declare function deriveEventTrust(facts: TrustDerivationFacts): DerivedEventTrust;
export declare function eventMatches(pattern: EventPattern, event: Event): boolean;
export declare function applyPayloadMapping(mapping: PayloadMapping, source: JsonValue): JsonValue;
export declare function routeDedupeKey(policy: DedupePolicy, event: Event, logicalDeliveryKey?: string): string;
export declare function trustAccepted(accepted: readonly TrustTier[], tier: TrustTier): boolean;
export declare function validatePayloadMapping(mapping: PayloadMapping): void;
