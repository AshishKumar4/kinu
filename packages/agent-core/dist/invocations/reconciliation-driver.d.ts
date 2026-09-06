import type { EffectAttemptId } from "../invocation-references/index.js";
import type { AttemptReceipt } from "./receipt.js";
/**
 * The durable schedule a reconciliation driver arms. Implementations persist
 * the next fire time in the owning Actor's storage (a Durable Object alarm, a
 * workflow timer), so an armed sweep survives restarts.
 */
export interface ReconciliationSchedulePort {
    scheduled(): Date | undefined;
    schedule(at: Date): void;
    clear(): void;
}
/**
 * The host's index of attempts whose latest Receipt is indeterminate — the
 * exact set a sweep re-queries (§7.4).
 */
export interface IndeterminateAttemptSource {
    indeterminate(limit: number): readonly EffectAttemptId[];
}
export interface ReconciliationSweepReport {
    readonly queried: number;
    readonly reconciled: number;
    readonly remaining: boolean;
}
interface DriverReconciler {
    reconcile(attemptId: EffectAttemptId): Promise<AttemptReceipt | undefined>;
}
/**
 * The named reconciliation driver (C13-EFFECT-RECONCILIATION-DRIVER): owns the
 * durable schedule that drives InvocationReconciler. A sweep re-queries the
 * indeterminate attempts, reconciles each, and re-arms the schedule while any
 * remain unresolved; direct calls to the reconciler never establish
 * scheduling — only arm() and sweep() touch the schedule.
 */
export declare class AlarmReconciliationDriver {
    private readonly reconciler;
    private readonly attempts;
    private readonly schedule;
    private readonly intervalMs;
    private readonly now;
    private readonly batchLimit;
    constructor(reconciler: DriverReconciler, attempts: IndeterminateAttemptSource, schedule: ReconciliationSchedulePort, intervalMs: number, now: () => Date, batchLimit?: number);
    /** Arm the durable schedule if it is not already armed. Idempotent. */
    arm(): Date;
    /**
     * Reconstruct the schedule from durable attempt state. A sweep interrupted by
     * eviction or a failing reconciliation leaves attempts indeterminate; call this
     * during startup so the driver resumes without waiting for new work to arm it.
     */
    repair(): Date | undefined;
    /**
     * One driver firing: re-query indeterminate attempts, reconcile each, and leave
     * the schedule armed exactly when unresolved attempts remain. An attempt whose
     * provider outcome is still unknown stays indeterminate and keeps it armed.
     *
     * The schedule is settled after the work, never before: clearing first would
     * strand every outstanding attempt if the firing is evicted or throws.
     */
    sweep(): Promise<ReconciliationSweepReport>;
    private settleSchedule;
}
export {};
