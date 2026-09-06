import { JsonSchema, SecretRef } from "../core/index.js";
import type { FacetData } from "./data.js";
import { EventKind } from "./id.js";
import { ProvenanceMapping } from "./mapping.js";
export type TrustTier = "owner" | "authenticated" | "external" | "self";
export type EventVisibility = "workspace" | "private";
export type VerificationScheme = "hmac" | "signature" | "oauth" | "mtls";
export declare class EventPattern {
    readonly kind: string;
    readonly source: string | undefined;
    readonly acceptedTrust: readonly [TrustTier, ...TrustTier[]];
    constructor(kind: string, acceptedTrust: readonly [TrustTier, ...TrustTier[]], source?: string);
    static fromData(payload: FacetData): EventPattern;
    static encode(pattern: EventPattern): Uint8Array;
    static decode(bytes: Uint8Array): EventPattern;
    toData(): FacetData;
}
export declare class EventDeclaration {
    readonly kind: EventKind;
    readonly description: string;
    readonly payload: JsonSchema;
    readonly visibility: EventVisibility;
    constructor(kind: EventKind, description: string, payload: JsonSchema, visibility: EventVisibility);
    static fromData(payload: FacetData): EventDeclaration;
    static encode(event: EventDeclaration): Uint8Array;
    static decode(bytes: Uint8Array): EventDeclaration;
    toData(): FacetData;
}
export declare class IngressVerification {
    readonly scheme: VerificationScheme;
    readonly secret: SecretRef;
    constructor(scheme: VerificationScheme, secret: SecretRef);
    static fromData(payload: FacetData): IngressVerification;
    static encode(verification: IngressVerification): Uint8Array;
    static decode(bytes: Uint8Array): IngressVerification;
    toData(): FacetData;
}
export declare class IngressDeclaration {
    readonly path: string;
    readonly verification: IngressVerification;
    readonly provenance: ProvenanceMapping;
    constructor(path: string, verification: IngressVerification, provenance: ProvenanceMapping);
    static fromData(payload: FacetData): IngressDeclaration;
    static encode(ingress: IngressDeclaration): Uint8Array;
    static decode(bytes: Uint8Array): IngressDeclaration;
    toData(): FacetData;
}
export declare function canonicalTrustTiers(values: readonly [TrustTier, ...TrustTier[]]): readonly [TrustTier, ...TrustTier[]];
