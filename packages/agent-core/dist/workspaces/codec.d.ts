import { ActorRef } from "../actors/index.js";
import { type JsonFields, ContentRef, Digest, Revision, type JsonValue } from "../core/index.js";
import { PrincipalRef, ScopeRef, TenantId } from "../identity/index.js";
export type JsonObject = {
    readonly [key: string]: JsonValue;
};
export declare function requireObject(value: JsonValue, subject: string): JsonObject;
export declare function requireFields<Field extends string>(value: JsonObject, fields: readonly Field[], subject: string): asserts value is JsonFields<Field>;
/**
 * The same exactness as `requireFields` for records whose optional fields are encoded by
 * presence: every required key must appear, and no key outside the two lists may.
 */
export declare function requireOptionalFields<Field extends string>(value: JsonObject, required: readonly Field[], optional: readonly string[], subject: string): asserts value is JsonFields<Field>;
export declare function requireString(value: JsonValue | undefined, subject: string): string;
export declare function requireNullableString(value: JsonValue | undefined, subject: string): string | undefined;
export declare function requireBoolean(value: JsonValue | undefined, subject: string): boolean;
export declare function requireInteger(value: JsonValue | undefined, subject: string): number;
export declare function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[];
export declare function encodeActor(actor: ActorRef): JsonValue;
export declare function decodeActor(value: JsonValue, subject: string): ActorRef;
export declare function encodeContent(ref: ContentRef, digest: Digest): JsonValue;
/**
 * A stored payload named by its content address, together with the digest that
 * address resolves to. decodeContent proves the two agree before returning one.
 */
export interface AddressedContent {
    readonly ref: ContentRef;
    readonly digest: Digest;
}
export declare function decodeContent(value: JsonValue, subject: string): AddressedContent;
export declare function encodeRevision(revision: Revision): JsonValue;
export declare function decodeRevision(value: JsonValue | undefined, subject: string): Revision;
export declare function encodeOptionalPrincipalRef(principal: PrincipalRef | undefined): JsonValue;
export declare function decodeOptionalPrincipalRef(value: JsonValue | undefined, subject: string): PrincipalRef | undefined;
export declare function encodeScope(scope: ScopeRef): JsonValue;
export declare function decodeScope(value: JsonValue): ScopeRef;
export declare function requireTenant(value: JsonValue | undefined, subject: string): TenantId;
