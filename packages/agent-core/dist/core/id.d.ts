export declare abstract class TextId {
    #private;
    protected constructor(value: string, name: string);
    get value(): string;
    equals(other: TextId): boolean;
    toString(): string;
}
