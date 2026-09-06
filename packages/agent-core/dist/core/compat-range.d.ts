export declare class CompatRange {
    readonly spec: string;
    readonly host: string;
    constructor(spec: string, host: string);
    static any(): CompatRange;
    static encode(range: CompatRange): Uint8Array;
    static decode(bytes: Uint8Array): CompatRange;
    equals(other: CompatRange): boolean;
}
