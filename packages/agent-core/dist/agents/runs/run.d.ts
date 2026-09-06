import { RecordCodec, Revision, type JsonValue } from "../../core/index.js";
import { RunCommitId } from "../../execution-references/index.js";
import { AgentId } from "../id.js";
import { CodecRecord } from "../record-data.js";
import { RunBranchId, RunId } from "./id.js";
import { TerminalSnapshot } from "./settlement.js";
import type { ResourceDimension } from "./ceiling.js";
import { Currency, RealizedCost } from "./cost.js";
import { RunInvocationDelivery } from "./invocation-delivery.js";
import { Digest } from "../../core/index.js";
export declare abstract class RunLifecycle {
    static get active(): RunLifecycle;
    static terminal(exhausted?: ResourceDimension): RunLifecycle;
    abstract readonly kind: "active" | "terminal";
    abstract readonly exhausted: ResourceDimension | undefined;
}
export interface RunInit {
    readonly id: RunId;
    readonly agent: AgentId;
    readonly configuration: Digest;
    readonly configurations?: readonly Digest[];
    readonly root: RunCommitId;
    readonly initialBranch: RunBranchId;
    readonly parent?: RunId | undefined;
    readonly terminal?: TerminalSnapshot | undefined;
    readonly tokensConsumed?: number;
    readonly costConsumed?: RealizedCost | undefined;
    readonly deliveries?: readonly RunInvocationDelivery[];
    readonly revision: Revision;
}
export declare class Run extends CodecRecord {
    static get codec(): RecordCodec<Run>;
    readonly id: RunId;
    readonly agent: AgentId;
    readonly configuration: Digest;
    readonly configurations: readonly Digest[];
    readonly root: RunCommitId;
    readonly initialBranch: RunBranchId;
    readonly parent: RunId | undefined;
    readonly lifecycle: RunLifecycle;
    readonly terminal: TerminalSnapshot | undefined;
    readonly tokensConsumed: number;
    readonly costConsumed: RealizedCost | undefined;
    readonly deliveries: readonly RunInvocationDelivery[];
    readonly revision: Revision;
    constructor(init: RunInit);
    /**
     * Terminalizes the Run and, in the same transition, takes on the cancellation messages
     * its still-owed published items are owed (SPEC §5.2, §5.6). The messages arrive here
     * rather than through a later call because a terminal Run admits no second
     * terminalization: a message appended afterwards could be lost by exactly the response
     * loss it exists to survive.
     */
    terminalize(snapshot: TerminalSnapshot, cancellations?: readonly RunInvocationDelivery[]): Run;
    /**
     * Takes on the message a published item's Invocation owner is owed once the Run holds
     * that item as its own obligation (SPEC §5.6). Publishing the same handle again is the
     * same message, so it changes nothing rather than owing the owner a second one.
     */
    publishDelivery(delivery: RunInvocationDelivery): Run;
    /**
     * Discharges one message its Invocation owner has acknowledged (SPEC §5.6, §6.1).
     *
     * Delivery is at-least-once, so a repeated acknowledgement is the ordinary case rather
     * than an error: the first one removed the message, and a second finds nothing to
     * remove and says so by changing nothing. A message of another Run is refused, because
     * that is a caller addressing state it does not hold rather than a duplicate.
     *
     * A terminal Run accepts this. A discharged message changes no lifecycle, and a
     * cancellation message exists only on a Run that has already ended.
     */
    acknowledgeDelivery(delivery: RunInvocationDelivery): Run;
    revise(): Run;
    recordEvidence(): Run;
    /**
     * One model call's consumption, accumulated where that call commits (SPEC §5.1, §5.2).
     * `tokens` and `costMicros` are the two ceiling dimensions with no derivation, and both
     * advance in this one transition, so a reader never sees a Run whose token total says a
     * call happened while its cost total says it did not.
     *
     * A host with no realized cost passes none, which leaves `costMicros` unbounded rather
     * than recording a zero that reads as a measured total. When a cost is present, the
     * caller supplies every currency the Run's lineage already records cost in, and this path
     * refuses to disagree with any of them: a comparison between amounts in two currencies is
     * not a comparison, and a ceiling is nothing but that comparison. The rule is about the
     * lineage and not about the order its Runs recorded in — a currency an ancestor or a
     * descendant already holds binds this cost the same way, whichever recorded first — and a
     * refusal moves neither total. A lineage that holds no currency adopts this cost's, and
     * every later cost in it answers to that.
     */
    recordModelUsage(tokens: number, cost: RealizedCost | undefined, lineageCurrencies: readonly Currency[]): Run;
    recordConfiguration(configuration: Digest): Run;
    toData(): JsonValue;
    static fromData(value: JsonValue): Run;
    private transition;
}
export declare const RunCodec: RecordCodec<Run>;
export declare class RunBranch extends CodecRecord {
    readonly id: RunBranchId;
    readonly run: RunId;
    readonly name: string;
    readonly head: RunCommitId;
    readonly revision: Revision;
    /**
     * The planned rewrite commit this branch has reserved and not yet closed. A branch
     * holds at most one, which is what makes a second rewrite attempt on it rejected
     * rather than raced (§5.2, C13-RUN-REWRITE-BRACKET).
     */
    readonly rewrite?: RunCommitId | undefined;
    static get codec(): RecordCodec<RunBranch>;
    constructor(id: RunBranchId, run: RunId, name: string, head: RunCommitId, revision: Revision, 
    /**
     * The planned rewrite commit this branch has reserved and not yet closed. A branch
     * holds at most one, which is what makes a second rewrite attempt on it rejected
     * rather than raced (§5.2, C13-RUN-REWRITE-BRACKET).
     */
    rewrite?: RunCommitId | undefined);
    /** Advancing onto the reserved rewrite closes the reservation, by identity. */
    advance(head: RunCommitId): RunBranch;
    reserveRewrite(commit: RunCommitId): RunBranch;
    toData(): JsonValue;
    static fromData(value: JsonValue): RunBranch;
}
export declare const RunBranchCodec: RecordCodec<RunBranch>;
