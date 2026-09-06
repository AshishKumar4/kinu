import type { InvocationId } from "../interaction-references/index.js";
import type { EffectAttempt } from "./attempt.js";
import { EffectAttemptId } from "./id.js";
import type { PreparedInvocation } from "./prepared.js";
export interface AdmittedInvocationItemInit {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
}
/**
 * One admitted item of one Invocation, named by exactly the four facts a later message about
 * it must match: the Invocation, the item index, that item's idempotency key, and the exact
 * EffectAttempt admission recorded (§7.3, §7.4).
 *
 * It is derived and disposable, never stored. §8.4 gives each record one owning Actor and
 * forbids a second durable copy, so this value reads the PreparedInvocation and the
 * EffectAttempt that already exist and holds nothing else. It deliberately carries no Receipt
 * and no result: it names work that has been admitted, which is the one thing a Receipt
 * cannot say, and a value that could carry an outcome would let a caller treat a finished
 * item as an admitted one.
 */
export declare class AdmittedInvocationItem {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
    /**
     * Reads the item off the two records that own its facts, refusing an attempt that does not
     * belong to exactly this prepared item. Every caller obtains the value this way, so
     * "the attempt matches the item" is established once instead of at each use.
     */
    static derive<Lease, Authority, Domain, PathEpochs, Admission>(prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, attempt: EffectAttempt<Lease, Admission>): AdmittedInvocationItem;
    constructor(init: AdmittedInvocationItemInit);
    /** True exactly when the four scalar facts a delivery carries name this item. */
    names(invocation: InvocationId, itemIndex: number, itemKey: string, attempt: EffectAttemptId): boolean;
    equals(other: AdmittedInvocationItem): boolean;
}
