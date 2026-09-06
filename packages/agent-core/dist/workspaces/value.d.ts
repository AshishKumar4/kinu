import type { ActorRef } from "../actors/index.js";
import { RecordCodec, type JsonValue } from "../core/index.js";
import { type BindingName, type FacetPackageId, type TrustTier } from "../facets/index.js";
import { PrincipalRef, TenantId } from "../identity/index.js";
export type EventSource = {
    readonly kind: "facet";
    readonly facet: FacetPackageId;
} | {
    readonly kind: "actor";
    readonly actor: ActorRef;
};
export declare abstract class EventVerification {
    static verified(): EventVerification;
    static host(): EventVerification;
    abstract readonly kind: "verified" | "host";
    equals(other: EventVerification): boolean;
}
export interface EventProvenanceInit {
    readonly verification: EventVerification;
    readonly principal?: PrincipalRef;
    readonly channel?: string;
    readonly group?: string;
    readonly claims?: JsonValue;
}
export declare class EventProvenance {
    static get codec(): RecordCodec<EventProvenance>;
    readonly verification: EventVerification;
    readonly principal: PrincipalRef | undefined;
    readonly channel: string | undefined;
    readonly group: string | undefined;
    readonly claims: JsonValue;
    constructor(init: EventProvenanceInit);
    static encode(provenance: EventProvenance): Uint8Array;
    static decode(bytes: Uint8Array): EventProvenance;
    static fromData(value: JsonValue): EventProvenance;
    toData(): JsonValue;
}
export type RouteAuthority = {
    readonly kind: "initiator";
    readonly binding: BindingName;
} | {
    readonly kind: "delegated";
    readonly binding: BindingName;
};
export type TenantRelation = {
    readonly kind: "same";
    readonly tenant: TenantId;
} | {
    readonly kind: "cross";
    readonly source: TenantId;
    readonly target: TenantId;
    readonly authority: BindingName;
};
export interface DerivedEventTrust {
    readonly tier: TrustTier;
    readonly initiator?: PrincipalRef;
}
export declare function canonicalJson(value: JsonValue): JsonValue;
/**
 * The value one RFC 6901 pointer names inside a document, or nothing when the document
 * does not hold that position. Absence is the return rather than a throw because the two
 * callers owe different refusals for it — a View mark that resolves nowhere is a malformed
 * record, a decision placement that resolves nowhere is a rejected rendering — while the
 * traversal itself is one fact about pointers. A JSON `null` the document does hold is a
 * value and answers as one.
 */
export declare function readJsonPointer(document: JsonValue, pointer: string): JsonValue | undefined;
