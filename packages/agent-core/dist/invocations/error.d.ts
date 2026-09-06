import { AgentCoreError } from "../errors.js";
export type InvocationFailure = "audit.append-conflict" | "audit.cause-mismatch" | "audit.evidence-mismatch" | "audit.invalid-root" | "audit.missing-cause" | "state.invalid-transition" | "store.duplicate-record" | "store.missing-evidence";
export declare class InvocationError extends AgentCoreError {
    readonly failure: InvocationFailure;
    constructor(failure: InvocationFailure, message: string);
}
export declare function invocationError(failure: InvocationFailure, message: string): InvocationError;
