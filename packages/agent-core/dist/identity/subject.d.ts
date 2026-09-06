import type { JsonValue } from "../core/index.js";
import { PrincipalId, TeamId, TenantId } from "./id.js";
import { PrincipalRef } from "./principal-ref.js";
export type GuestVerificationSchemeValue = "token" | "callback" | "handshake";
export declare class GuestVerificationScheme {
    readonly value: GuestVerificationSchemeValue;
    static readonly token: GuestVerificationScheme;
    static readonly callback: GuestVerificationScheme;
    static readonly handshake: GuestVerificationScheme;
    /** The closed vocabulary §3.3 fixes, in the order it introduces the schemes. */
    static readonly all: readonly GuestVerificationScheme[];
    private constructor();
    static from(value: GuestVerificationSchemeValue): GuestVerificationScheme;
    equals(other: GuestVerificationScheme): boolean;
    toString(): string;
}
export interface PrincipalSubjectRef {
    readonly kind: "principal";
    readonly principal: PrincipalRef;
}
export interface TeamSubjectRef {
    readonly kind: "team";
    readonly teamId: TeamId;
}
export interface ForeignPrincipalRef {
    readonly kind: "foreign";
    readonly homeTenant: TenantId;
    readonly principalId: PrincipalId;
    readonly verifiedVia: GuestVerificationScheme;
}
export type SubjectRef = PrincipalSubjectRef | TeamSubjectRef | ForeignPrincipalRef;
export declare const SubjectRef: Readonly<{
    principal(principal: PrincipalRef): PrincipalSubjectRef;
    team(teamId: TeamId): TeamSubjectRef;
    foreign(homeTenant: TenantId, principalId: PrincipalId, verifiedVia: GuestVerificationScheme): ForeignPrincipalRef;
}>;
/**
 * A Principal subject names a Principal of one Tenant, so any record that carries both a
 * subject and the Tenant that owns it rejects a foreign qualification structurally rather
 * than inheriting the Tenant from wherever the record happened to be stored. Cross-Tenant
 * subjects are `ForeignPrincipalRef` and carry their own home Tenant (§3.3).
 */
export declare function requireSubjectTenant(subject: SubjectRef, tenantId: TenantId, record: string): void;
export declare function encodeSubjectRef(subject: SubjectRef): JsonValue;
export declare function decodeSubjectRef(value: JsonValue): SubjectRef;
