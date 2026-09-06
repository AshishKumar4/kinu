import { ContentRef, type ContentRetentionField, JsonSchema, type JsonValue, RecordCodec } from "../core/index.js";
import { EffectAttemptId, ReceiptId } from "./id.js";
import { InvocationId } from "../interaction-references/index.js";
export type PreEffectReceiptOutcome = "deniedPreEffect" | "cancelledPreEffect";
declare const ATTEMPT_RECEIPT_OUTCOMES: readonly ["succeeded", "failed", "indeterminate"];
export type AttemptReceiptOutcome = (typeof ATTEMPT_RECEIPT_OUTCOMES)[number];
declare const ATTEMPT_FAILURE_KINDS: readonly ["raised", "deadline", "aborted", "domainLost", "outputInvalid"];
export type AttemptFailureKindName = (typeof ATTEMPT_FAILURE_KINDS)[number];
type ReceiptProperties = PreEffectReceiptProperties | AttemptReceiptProperties;
/**
 * The protection domain (§1.5) hosting an attempt's target, asked whether it still answers.
 * Liveness is a live substrate fact, so it reaches the seam through a port rather than
 * through the durable Domain reference on the PreparedInvocation header, which §8.3 forbids
 * from owning live resources.
 */
export interface AttemptTargetDomain {
    answering(): boolean;
}
/**
 * The facts a host holds when an attempt ended without a usable result. §7.4 lets the host
 * derive four kinds from boundaries it owns and lets the invoked handler originate only
 * `raised`, so the callee's contribution arrives as a verdict the seam already narrowed to
 * rather than as anything the callee said about itself: labelling a rejection `domainLost`
 * cannot reach `domainLost`, because that kind is read off the domain and not off the error.
 *
 * `target` is required and has no default. It carries the entire content of `domainLost`, so
 * an observation without one is not classifiable rather than classifiable as answering — a
 * default would let that kind be ruled out by nothing having been asked.
 */
export interface AttemptFailureObservation {
    /** True exactly when the handler signalled failure itself (§4.1 `execute`). */
    readonly confirmed: boolean;
    /** The host's own bound on this attempt, present only when it is what ended the wait. */
    readonly elapsedBound: Date | undefined;
    /** Cancellation of the Turn or Run that owns the item. */
    readonly cancellation: AbortSignal;
    /** The protection domain hosting the target. */
    readonly target: AttemptTargetDomain;
    readonly observedAt: Date;
}
/**
 * §7.4's closed failure taxonomy for an attempted `failed` Receipt.
 *
 * Each case is reachable only through the fact that distinguishes it, so a host cannot
 * record a kind it has not observed, and no call accepts two facts. `raised` is the one kind
 * the invoked handler may author and it must present the handler's own confirmation; the
 * host derives `deadline` from the bound it set, `aborted` from the cancellation it owns,
 * `domainLost` from the domain hosting the target, and `outputInvalid` from the output shape
 * the Operation declared — never from anything the target reports about itself, for the
 * reason §7.1 gives.
 *
 * Only construction is guarded. `kind` is the wire label, but reading one proves nothing the
 * caller did not already establish to obtain the value.
 *
 * A guard that refuses is answering "the fact you name is not established by what you
 * presented", which is a determination about this attempt rather than a malformed argument,
 * so it carries `invocation.invalid` like every other unsubstantiated Receipt claim. The
 * exact-class checks belong to the same answer: evidence that is not the declared output
 * shape, or not the cancellation the host owns, establishes nothing either.
 */
export declare abstract class AttemptFailureKind {
    abstract readonly kind: AttemptFailureKindName;
    /** §7.4: the sole kind the invoked code is permitted to originate. */
    get authoredByHandler(): boolean;
    /**
     * The invoked handler signalled failure itself.
     *
     * This is the one case with no host-side precondition to check, and the asymmetry is
     * §7.4's own: the other four are facts about boundaries the host owns and can therefore
     * be interrogated, while this one is the callee's answer and the host either holds it or
     * does not. Requiring evidence content here would be a witness for the adjacent question
     * — whether the handler produced content, not whether it signalled failure — and the two
     * come apart, since a reconciled external verdict is the callee's own report and carries
     * no §4.1 rejection. Naming this kind is therefore the seam's obligation: a caller must
     * have narrowed to a confirmed callee verdict, never to an unrecognized rejection.
     */
    static get raised(): AttemptFailureKind;
    /** A host-set bound on this attempt elapsed. */
    static deadline(bound: Date, observedAt: Date): AttemptFailureKind;
    /** Cancellation of the Turn or Run that owns the item reached the attempt. */
    static aborted(cancellation: AbortSignal): AttemptFailureKind;
    /** The protection domain hosting the target stopped answering. */
    static domainLost(target: AttemptTargetDomain): AttemptFailureKind;
    /** The handler resolved with a value the Operation's declared output shape rejects. */
    static outputInvalid(output: JsonSchema, value: JsonValue): AttemptFailureKind;
    /**
     * §7.4's derivation, or `undefined` when the host holds no determination and the outcome
     * is therefore `indeterminate`.
     *
     * The order is causal, not arbitrary. A confirmed verdict is the handler's own answer, so
     * the host is not guessing and asks nothing further. Otherwise a lost domain explains any
     * boundary of the host's that also closed; a cancelled Turn or Run explains an elapsed
     * bound but not a lost domain; and the host's own bound is named only when nothing else
     * accounts for the end of the wait. Falling through to `undefined` is the point rather
     * than a gap: an unexplained end is not a kind, because naming one would convert "I
     * cannot tell" into "I know why".
     */
    static classify(observation: AttemptFailureObservation): AttemptFailureKind | undefined;
    equals(other: AttemptFailureKind): boolean;
}
/**
 * An attempted outcome carrying its failure kind inseparably.
 *
 * §7.4 requires a kind on exactly the `failed` outcome, so `succeeded` and `indeterminate`
 * are values that accept no argument and `failed` is the only call that accepts one. A kind
 * on a non-failed outcome, a `failed` outcome without one, and two kinds on one outcome are
 * therefore not calls that exist rather than calls that are rejected. `indeterminate` in
 * particular cannot carry one: naming a kind is a determination, and a host that has one has
 * stopped not knowing.
 */
export declare abstract class AttemptCompletion {
    static get succeeded(): AttemptCompletion;
    static get indeterminate(): AttemptCompletion;
    static failed(failure: AttemptFailureKind): AttemptCompletion;
    abstract readonly outcome: AttemptReceiptOutcome;
    abstract readonly failure: AttemptFailureKind | undefined;
}
export declare abstract class Receipt {
    #private;
    protected constructor(recordedAt: Date, properties: ReceiptProperties);
    static encode(record: Receipt): Uint8Array;
    static decode(bytes: Uint8Array): Receipt;
    abstract readonly variant: "preEffect" | "attempt";
    abstract readonly id: ReceiptId;
    abstract readonly outcome: PreEffectReceiptOutcome | AttemptReceiptOutcome;
    get recordedAt(): Date;
}
export declare class PreEffectReceipt extends Receipt {
    readonly variant: "preEffect";
    readonly id: ReceiptId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly outcome: PreEffectReceiptOutcome;
    readonly reason: string;
    constructor(id: ReceiptId, invocation: InvocationId, itemIndex: number, outcome: PreEffectReceiptOutcome, recordedAt: Date, reason: string);
}
export declare class AttemptReceipt extends Receipt {
    readonly variant: "attempt";
    readonly id: ReceiptId;
    readonly attempt: EffectAttemptId;
    readonly outcome: AttemptReceiptOutcome;
    readonly failure: AttemptFailureKind | undefined;
    readonly previous: ReceiptId | undefined;
    readonly result: ContentRef | undefined;
    constructor(id: ReceiptId, attempt: EffectAttemptId, completion: AttemptCompletion, previous: ReceiptId | undefined, recordedAt: Date, result: ContentRef | undefined);
}
/**
 * The ContentRef an audited Receipt holds (§8.4). A Receipt is append-only, so its writer
 * owes retention on write and never a release: the result bytes an attempt produced stay
 * reachable for as long as the Receipt naming them does. A pre-effect Receipt records a
 * refusal and names no content, and an indeterminate attempt is refused a result at
 * construction, so both project nothing rather than an absent field.
 */
export declare function receiptContentRetention(receipt: Receipt): readonly ContentRetentionField[];
interface PreEffectReceiptProperties {
    readonly variant: "preEffect";
    readonly id: ReceiptId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly outcome: PreEffectReceiptOutcome;
    readonly reason: string;
}
interface AttemptReceiptProperties {
    readonly variant: "attempt";
    readonly id: ReceiptId;
    readonly attempt: EffectAttemptId;
    readonly outcome: AttemptReceiptOutcome;
    readonly failure: AttemptFailureKind | undefined;
    readonly previous: ReceiptId | undefined;
    readonly result: ContentRef | undefined;
}
export declare const ReceiptCodec: RecordCodec<Receipt>;
export {};
