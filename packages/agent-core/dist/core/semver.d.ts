export declare class SemVer {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly prerelease: readonly string[];
    readonly build: readonly string[];
    constructor(...args: [value: string] | [
        major: number,
        minor: number,
        patch: number,
        prerelease?: readonly string[],
        build?: readonly string[]
    ]);
    static parse(value: string): SemVer;
    static encode(version: SemVer): Uint8Array;
    static decode(bytes: Uint8Array): SemVer;
    compare(other: SemVer): number;
    equals(other: SemVer): boolean;
    toString(): string;
}
