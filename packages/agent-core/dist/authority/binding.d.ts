import { RecordCodec, Revision, SecretRef, type JsonValue } from "../core/index.js";
import { BindingName, FacetRef, ProtectionDomain } from "../facets/index.js";
import { ScopeRef, type SubjectRef } from "../identity/index.js";
import { type JsonObject } from "./data.js";
import { GrantId } from "./id.js";
export type BindingStateName = "active" | "inactive";
export declare class BindingCredentialCustody {
    readonly secret: SecretRef;
    readonly endpoint: string;
    constructor(secret: SecretRef, endpoint: string);
    matches(secret: SecretRef, endpoint: string): boolean;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): BindingCredentialCustody;
}
export declare abstract class BindingLifecycle {
    abstract readonly name: BindingStateName;
    abstract activate(): BindingLifecycle;
    abstract deactivate(): BindingLifecycle;
    static from(state: BindingStateName): BindingLifecycle;
}
export declare class Binding {
    #private;
    readonly scope: ScopeRef;
    readonly name: BindingName;
    readonly grantId: GrantId;
    readonly facet: FacetRef;
    readonly generation: number;
    readonly revision: Revision;
    static get codec(): RecordCodec<Binding>;
    readonly domain: ProtectionDomain;
    readonly subject: SubjectRef;
    readonly credentialCustody: readonly BindingCredentialCustody[];
    constructor(scope: ScopeRef, subject: SubjectRef, domain: ProtectionDomain, name: BindingName, grantId: GrantId, facet: FacetRef, generation: number, state: BindingStateName, revision: Revision, credentialCustody?: readonly BindingCredentialCustody[]);
    static active(scope: ScopeRef, subject: SubjectRef, domain: ProtectionDomain, name: BindingName, grantId: GrantId, facet: FacetRef, credentialCustody?: readonly BindingCredentialCustody[]): Binding;
    static encode(record: Binding): Uint8Array;
    static decode(bytes: Uint8Array): Binding;
    /**
     * Binding identity is exactly its addressing coordinates, so a caller holding those
     * can look one up without first fabricating a record around a Grant and Facet it
     * does not yet know.
     */
    static keyFor(scope: ScopeRef, subject: SubjectRef, domain: ProtectionDomain, name: BindingName): string;
    get key(): string;
    get resolves(): boolean;
    get state(): BindingStateName;
    replace(grantId: GrantId, facet: FacetRef, credentialCustody?: readonly BindingCredentialCustody[]): Binding;
    deactivate(): Binding;
    hasCredentialCustody(secret: SecretRef, endpoint: string): boolean;
    assertCanReplace(next: Binding): void;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): Binding;
    private transition;
}
export declare function encodeDomain(domain: ProtectionDomain): JsonObject;
export declare function domainKey(domain: ProtectionDomain): string;
export declare function decodeDomain(value: JsonValue | undefined): ProtectionDomain;
