import type { AdmittedInvocationItem } from "./admitted-item.js";
import type { CanonicalBatchItemResult } from "./canonical-batch.js";
import type { ReconciliationSchedulePort } from "./reconciliation-driver.js";
/**
 * The host's index of detached items released for execution and not yet answered by a Receipt
 * — the exact set a sweep re-queries (§5.6).
 *
 * It answers with admitted items rather than stored records because that is what execution
 * needs, and it is the host's query rather than the driver's so that "released and unfinished"
 * stays one predicate over the store: the released state comes from the detachment record and
 * the unfinished half from the item's current Receipt, which §7.4 owns.
 */
export interface DetachedEffectExecutionSource {
    released(limit: number): readonly AdmittedInvocationItem[];
}
export interface DetachedEffectSweepReport {
    readonly queried: number;
    readonly executed: number;
    readonly remaining: boolean;
}
/** The execution seam the driver drives, narrowed to the one call it makes. */
interface DrivenDetachedExecution {
    execute(item: AdmittedInvocationItem): Promise<CanonicalBatchItemResult>;
}
/**
 * The named driver for detached execution: it owns the durable schedule that runs released
 * items whose Turn has ended (§5.6).
 *
 * Everything it needs comes from durable records. A sweep re-queries the released items,
 * executes each through a target that rebuilds its own live request, and re-arms while any
 * remain — so a host that restarts mid-flight resumes by calling `repair` and never by holding
 * a closure from the Turn that admitted the work. Direct calls to the execution step never
 * establish scheduling; only `arm` and `sweep` touch the schedule.
 *
 * It shares `ReconciliationSchedulePort` with the reconciliation driver because a durable
 * schedule is one substrate contract, not two. Each driver arms its own schedule instance; two
 * drivers sharing one would settle each other's work.
 */
export declare class AlarmDetachedEffectDriver {
    private readonly executions;
    private readonly items;
    private readonly schedule;
    private readonly intervalMs;
    private readonly now;
    private readonly batchLimit;
    constructor(executions: DrivenDetachedExecution, items: DetachedEffectExecutionSource, schedule: ReconciliationSchedulePort, intervalMs: number, now: () => Date, batchLimit?: number);
    /** Arm the durable schedule if it is not already armed. Idempotent. */
    arm(): Date;
    /**
     * Reconstruct the schedule from durable detachment state. A release whose sweep was lost to
     * eviction, or a host that restarted between admission and execution, leaves released items
     * with no Receipt; call this during startup so the driver resumes without waiting for a new
     * delivery to arm it.
     */
    repair(): Date | undefined;
    /**
     * One driver firing: re-query released items, execute each, and leave the schedule armed
     * exactly when released work remains.
     *
     * The schedule is settled after the work, never before: clearing first would strand every
     * outstanding item if the firing is evicted or throws.
     */
    sweep(): Promise<DetachedEffectSweepReport>;
    private settleSchedule;
}
export {};
