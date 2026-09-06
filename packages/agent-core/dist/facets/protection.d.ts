export type ProtectionDomainKind = "frontend" | "backend";
export type ProtectionDomainSecretPolicy = "no-secrets" | "may-hold-secrets";
export declare class ProtectionDomain {
    readonly kind: ProtectionDomainKind;
    readonly label: string;
    readonly secretPolicy: ProtectionDomainSecretPolicy;
    constructor(kind: ProtectionDomainKind, label: string, secretPolicy: ProtectionDomainSecretPolicy);
    get canHoldSecrets(): boolean;
    equals(other: ProtectionDomain): boolean;
}
