/**
 * How a Turn ended (SPEC §5.3). The three outcomes are the whole terminal vocabulary, shared
 * by Turn status, Run settlement, and every record that names an ending.
 */
export type TerminalOutcome = "succeeded" | "failed" | "cancelled";
export type TurnStatusData = TurnStatus["kind"];
/**
 * Where a Turn is in its lifecycle (SPEC §5.3). `queued` and `suspended` are the two statuses
 * a lease may be claimed from; `running` is the only status that may complete; the three
 * terminal statuses admit no further move.
 */
export declare abstract class TurnStatus {
    static get queued(): TurnStatus;
    static get running(): TurnStatus;
    static get suspended(): TurnStatus;
    static get succeeded(): TurnStatus;
    static get failed(): TurnStatus;
    static get cancelled(): TurnStatus;
    static from(kind: TurnStatus["kind"]): TurnStatus;
    static fromData(value: GeneratedData): TurnStatus;
    abstract readonly kind: "queued" | "running" | "suspended" | "succeeded" | "failed" | "cancelled";
    /**
     * The status an unheld cancellation moves this Turn to. Cancelling without a lease token is
     * admitted exactly where no token exists to be presented: a queued or suspended Turn. A
     * running Turn is held, and cancelling it requires that holder's token.
     */
    abstract cancelUnheld(): Option<TurnStatus>;
    /**
     * The status a claim moves this Turn to, and nothing when a Turn in this status cannot be
     * claimed. A queued Turn starts; a suspended Turn resumes; a running Turn is already held and
     * a terminal Turn is finished, so neither admits a claim.
     */
    abstract claim(): Option<TurnStatus>;
    /**
     * Whether this Turn may complete with an outcome. Only a running Turn may — a Turn that never
     * started, or already ended, has no attempt to record an outcome for. The status it reaches is
     * `ofTerminalOutcome` of that outcome, which is a fact about the outcome alone and so is
     * decided there; keeping the two apart is also what keeps this dispatch from carrying a
     * parameter half its cases would ignore.
     */
    abstract completes(): boolean;
    /**
     * The status a suspension moves this Turn to. Only a running Turn suspends: suspending a
     * queued Turn would invent a hold nobody took, and a terminal Turn has nothing to suspend.
     */
    abstract suspend(): Option<TurnStatus>;
    /**
     * Whether this Turn has ended (SPEC §5.3): terminalization reads exactly this.
     */
    abstract terminal(): boolean;
    toData(): TurnStatusData;
    equals(other: TurnStatus): boolean;
}
export declare class QueuedTurnStatus extends TurnStatus {
    readonly kind: "queued";
    constructor();
    cancelUnheld(): Option<TurnStatus>;
    claim(): Option<TurnStatus>;
    completes(): boolean;
    suspend(): Option<TurnStatus>;
    terminal(): boolean;
}
export declare class RunningTurnStatus extends TurnStatus {
    readonly kind: "running";
    constructor();
    cancelUnheld(): Option<TurnStatus>;
    claim(): Option<TurnStatus>;
    completes(): boolean;
    suspend(): Option<TurnStatus>;
    terminal(): boolean;
}
export declare class SuspendedTurnStatus extends TurnStatus {
    readonly kind: "suspended";
    constructor();
    cancelUnheld(): Option<TurnStatus>;
    claim(): Option<TurnStatus>;
    completes(): boolean;
    suspend(): Option<TurnStatus>;
    terminal(): boolean;
}
export declare class SucceededTurnStatus extends TurnStatus {
    readonly kind: "succeeded";
    constructor();
    cancelUnheld(): Option<TurnStatus>;
    claim(): Option<TurnStatus>;
    completes(): boolean;
    suspend(): Option<TurnStatus>;
    terminal(): boolean;
}
export declare class FailedTurnStatus extends TurnStatus {
    readonly kind: "failed";
    constructor();
    cancelUnheld(): Option<TurnStatus>;
    claim(): Option<TurnStatus>;
    completes(): boolean;
    suspend(): Option<TurnStatus>;
    terminal(): boolean;
}
export declare class CancelledTurnStatus extends TurnStatus {
    readonly kind: "cancelled";
    constructor();
    cancelUnheld(): Option<TurnStatus>;
    claim(): Option<TurnStatus>;
    completes(): boolean;
    suspend(): Option<TurnStatus>;
    terminal(): boolean;
}
/**
 * The status a Turn reaches by ending with this outcome.
 */
export declare function ofTerminalOutcome(outcome: TerminalOutcome): TurnStatus;
export declare const TerminalOutcome: Readonly<{
    fromData(value: GeneratedData): TerminalOutcome;
}>;
export type GeneratedData = boolean | bigint | number | string | null | undefined | readonly GeneratedData[] | {
    readonly [key: string]: GeneratedData;
};
export type Option<A> = {
    readonly kind: "none";
} | {
    readonly kind: "some";
    readonly value: A;
};
