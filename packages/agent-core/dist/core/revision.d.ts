export declare class Revision {
    #private;
    constructor(value: number);
    static isExact(value: unknown): value is Revision;
    static initial(): Revision;
    get value(): number;
    next(): Revision;
    equals(other: Revision): boolean;
}
