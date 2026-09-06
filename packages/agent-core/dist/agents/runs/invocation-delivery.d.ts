import { Digest, RecordCodec, type JsonValue } from "../../core/index.js";
import { RunCommitId } from "../../execution-references/index.js";
import { InvocationId } from "../../interaction-references/index.js";
import { EffectAttemptId } from "../../invocation-references/index.js";
import { CodecRecord } from "../record-data.js";
import { RunId } from "./id.js";
/**
 * Why the Run addresses the Invocation owner about one published item (SPEC §5.6).
 *
 * The two cases are separate classes because they carry different facts, not because a
 * reader has to remember what a label means. An admission names nothing else: the Run has
 * taken the item into its own obligation and the Invocation owner may start the work.
 * A cancellation names the terminal commit the Run ended on, so the owner can read the
 * exact terminalization the request came from rather than trust that one happened.
 *
 * Neither case carries a failure kind, and there is no field one could travel in. §7.4
 * builds `aborted` only from cancellation that reached the attempt, and the Run is not the
 * party that observes that: it observes its own end. A request from here is therefore a
 * request, and the Invocation owner's own target observation is what classifies the
 * attempt. A Run that shipped a verdict would be asserting a fact about a live controller
 * it cannot see, including after a restart that left no controller at all.
 */
export declare abstract class RunInvocationDeliveryCause {
    /** The Run took the published item into its own obligation. */
    static get admission(): RunInvocationDeliveryCause;
    /** The Run ended at this exact terminal commit while the item was still owed. */
    static cancellation(terminalCommit: RunCommitId): RunInvocationDeliveryCause;
    abstract readonly kind: "admission" | "cancellation";
    /** The terminal commit a cancellation names; an admission names none. */
    abstract readonly terminalCommit: RunCommitId | undefined;
    abstract toData(): JsonValue;
    equals(other: RunInvocationDeliveryCause): boolean;
    static fromData(value: JsonValue): RunInvocationDeliveryCause;
}
/**
 * Exported for one reason: a codec that embeds a delivery seals every class its encoded graph
 * reaches, and the project's codec rule admits only explicitly named classes. Nothing
 * constructs these directly — the factories on the base class are the way in.
 */
export declare class AdmissionCause extends RunInvocationDeliveryCause {
    readonly kind: "admission";
    readonly terminalCommit: undefined;
    toData(): JsonValue;
}
export declare class CancellationCause extends RunInvocationDeliveryCause {
    readonly terminalCommit: RunCommitId;
    readonly kind: "cancellation";
    constructor(terminalCommit: RunCommitId);
    toData(): JsonValue;
}
export interface RunInvocationDeliveryInit {
    readonly run: RunId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
    readonly cause: RunInvocationDeliveryCause;
}
/**
 * One message the Run owes the Invocation owner about one published item (SPEC §5.6, §6.1).
 *
 * There is no cross-Actor transaction, so a message that existed only in the response to
 * the Run transaction would be lost by a lost response: terminalization cannot run twice on
 * a terminal Run, and publication cannot be replayed from a Turn that has ended. The
 * message is therefore a durable record the Run keeps until the owner acknowledges it, and
 * delivery is at-least-once with the record as the replay source.
 *
 * The identity is derived from every field, so the same publication or the same
 * terminalization produces the same message rather than a second one, and a forged
 * acknowledgement cannot discharge a message the Run never wrote. It names the exact
 * `EffectAttempt` because that is what the owner re-reads its own state against: an item
 * whose attempt has moved on is a different attempt, and this message says nothing about it.
 */
export declare class RunInvocationDelivery extends CodecRecord {
    static get codec(): RecordCodec<RunInvocationDelivery>;
    readonly id: Digest;
    readonly run: RunId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
    readonly cause: RunInvocationDeliveryCause;
    constructor(init: RunInvocationDeliveryInit);
    /** Every field decides the identity, so equal identity is equal content. */
    equals(other: RunInvocationDelivery): boolean;
    toData(): JsonValue;
    static fromData(value: JsonValue): RunInvocationDelivery;
}
export declare const RunInvocationDeliveryCodec: RecordCodec<RunInvocationDelivery>;
/**
 * The Run's pending messages in one canonical order, with no message twice.
 *
 * The order is by derived identity rather than by arrival, because arrival order is not a
 * fact the record keeps and two hosts replaying the same outbox must read the same
 * sequence. Acknowledged messages are removed instead of marked: the message is a command,
 * and what durably records that the command existed is the Run's own admission obligation
 * and terminal snapshot, plus the Invocation owner's Receipt. Keeping discharged commands
 * would grow the Run record without bound and add a second place to ask whether an item
 * was addressed.
 */
export declare function canonicalDeliveries(deliveries: readonly RunInvocationDelivery[]): readonly RunInvocationDelivery[];
