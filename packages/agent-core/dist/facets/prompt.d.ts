import type { FacetData } from "./data.js";
export declare class Prompt {
    readonly title: string;
    readonly body: string;
    readonly priority: number;
    constructor(title: string, body: string, priority: number);
    static fromData(payload: FacetData): Prompt;
    static encode(prompt: Prompt): Uint8Array;
    static decode(bytes: Uint8Array): Prompt;
    toData(): FacetData;
}
export declare class PromptContribution {
    readonly sections: readonly Prompt[];
    constructor(sections: readonly Prompt[]);
    static empty(): PromptContribution;
    static fromData(payload: FacetData): PromptContribution;
    static encode(contribution: PromptContribution): Uint8Array;
    static decode(bytes: Uint8Array): PromptContribution;
    toData(): FacetData;
}
