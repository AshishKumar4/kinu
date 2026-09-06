import type { Receipt } from "./receipt.js";
export type BatchOutcome = "succeeded" | "partiallySucceeded" | "failed" | "denied" | "cancelled" | "indeterminate";
export type TerminalBatchOutcome = Exclude<BatchOutcome, "indeterminate">;
export declare function deriveBatchOutcome(itemCount: number, receipts: readonly (Receipt | undefined)[]): BatchOutcome | undefined;
export declare function terminalBatchOutcome(outcome: BatchOutcome | undefined): TerminalBatchOutcome | undefined;
