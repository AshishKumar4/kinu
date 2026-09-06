export declare class SecretRef {
    readonly source: string;
    readonly provider: string;
    readonly id: string;
    constructor(source: string, provider: string, id: string);
    equals(other: SecretRef): boolean;
}
