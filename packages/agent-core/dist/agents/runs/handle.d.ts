import type { ContentStore } from "../../content/index.js";
import { ContentRef, Digest, RecordCodec, Revision, type JsonValue } from "../../core/index.js";
import { RunCommitId, TurnId } from "../../execution-references/index.js";
import { type FacetData, type Impact } from "../../facets/index.js";
import { InvocationId } from "../../interaction-references/index.js";
import { EffectAttemptId, ReceiptId } from "../../invocation-references/index.js";
import type { AdmittedInvocationItem } from "../../invocations/index.js";
import { CodecRecord } from "../record-data.js";
import type { RunAdmissionReservation, RunObligation } from "./admission.js";
import { RunId } from "./id.js";
import { RunInvocationDelivery } from "./invocation-delivery.js";
import type { LeaseToken } from "./lease.js";
import type { RunRuntime } from "./runtime.js";
import { TurnInboxEntry } from "./turn.js";
/**
 * What a handle puts in the model's tool position (SPEC §5.6): a mediated Invocation's own
 * admission identity, or the child RunRef a `delegate` spawn's Receipt carries. The two are
 * different owners rather than two spellings of one, because an Invocation identity leaves
 * the item owned by the issuing Run while a child RunRef names a settlement unit of its
 * own, so each renders its own tool position and its own address instead of a reader
 * branching on a kind field it has to remember the meaning of.
 */
export declare abstract class TurnAdmissionIdentity {
    static invocation(invocation: InvocationId): TurnAdmissionIdentity;
    /**
     * The child a `delegate` spawn's Receipt names, with that Receipt and the digest of its
     * result. A child RunRef cannot exist before the Receipt carries it, so the evidence that
     * proves it belongs to this case alone: an Invocation identity commits at admission, where
     * no Receipt exists, and a handle carrying both would have to leave one of them empty.
     */
    static childRun(run: RunId, receipt: ReceiptId, result: Digest): TurnAdmissionIdentity;
    abstract readonly kind: "invocation" | "childRun";
    /** The child Run this identity names; an Invocation identity names none. */
    abstract readonly childRun: RunId | undefined;
    /**
     * The Run whose cancellation is cancellation of this item's owner (SPEC §5.6). The
     * caller supplies the Run the issuing Turn belongs to. An Invocation identity detaches
     * the item from the Turn and not from the Run, so the issuing Run answers for it. A
     * child RunRef detaches it from that Run as well, so the child Run answers for itself.
     */
    abstract owner(issuingRun: RunId): RunId;
    /** The exact canonical value the model reads in the tool position. */
    abstract toolPosition(): FacetData;
    /** The stable string an at-least-once delivery keys its idempotency on. */
    abstract get address(): string;
    abstract equals(other: TurnAdmissionIdentity): boolean;
    abstract toData(): JsonValue;
    /**
     * Decodes exactly the fields the named case carries. One shared field list would admit an
     * Invocation identity holding a spawn Receipt, which is the pairing these two cases exist
     * to leave unconstructable.
     */
    static fromData(value: JsonValue): TurnAdmissionIdentity;
}
export interface TurnAdmissionHandleInit {
    readonly run: RunId;
    readonly turn: TurnId;
    readonly issuedEpoch: number;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
    readonly identity: TurnAdmissionIdentity;
}
/**
 * A durable, addressable reference to an admitted mediated item (SPEC §5.6). It is a value
 * rather than a stored record on purpose: everything it names — the Invocation, the
 * EffectAttempt, the child RunRef — is already owned durably elsewhere, so a table of handles
 * would be a second copy of state with its own way of going stale. Its canonical bytes are
 * what survive a process, and re-verifying those bytes against the same §7.4 records is what
 * makes a decoded handle address exactly the work the original named. It carries no time of
 * its own for the same reason: the EffectAttempt it names already records when the item was
 * admitted.
 *
 * It names the four facts of the admitted item and no outcome. Admission is the commit point
 * an Invocation identity has (§5.6), and admission leaves an EffectAttempt that no Receipt
 * names yet, so a Receipt on this record would be a field one whole case could never fill.
 * The one identity whose commit point is a Receipt carries that Receipt itself.
 *
 * The recorded `issuedEpoch` is provenance and never authority. A handle authorizes
 * addressing its Turn; writing as that Turn needs the exact current lease (§5.3), which the
 * caller presents separately and which this record cannot substitute for.
 */
export declare class TurnAdmissionHandle extends CodecRecord {
    static get codec(): RecordCodec<TurnAdmissionHandle>;
    readonly run: RunId;
    readonly turn: TurnId;
    readonly issuedEpoch: number;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
    readonly identity: TurnAdmissionIdentity;
    constructor(init: TurnAdmissionHandleInit);
    /** The exact canonical value the model reads in the tool position (SPEC §5.6). */
    toolPosition(): FacetData;
    /** The stable string a later delivery addresses this admission by. */
    get address(): string;
    /**
     * The Run that governs this published item's cancellation (SPEC §5.6). §7.4 assigns
     * `aborted` to cancellation of the Turn or Run that owns an item, and leaves which of
     * the two open. Publication closes that disjunction. It closes it on a Run in both
     * cases: the issuing Run for an Invocation identity, and the child Run for a RunRef. A
     * published item therefore keeps no Turn owner for a Turn's cancellation to be.
     */
    get owner(): RunId;
    /**
     * The durable message this published item's Invocation owner is owed when `scope`
     * cancels (SPEC §5.6). It answers nothing where `scope` does not own the item, which is
     * the issuing Turn's case: RunId and TurnId are different classes, so a cancelled Turn
     * never equals the owner and the prohibition holds by identity rather than by a branch
     * a host can forget.
     *
     * The message is a request and never a verdict. §7.4 builds `aborted` only from
     * cancellation that reached the attempt, and the Run observes its own end rather than
     * the target's live controller, so what travels here is the exact item and attempt the
     * Run stopped owning. The Invocation owner aborts its own controller and classifies the
     * attempt from what it observes, including observing that nothing is left to abort.
     */
    cancellationDelivery(scope: RunId | TurnId, terminalCommit: RunCommitId): RunInvocationDelivery | undefined;
    /**
     * The durable message its Invocation owner is owed once publication has detached the
     * item into this Run (SPEC §5.6). An item detached to a child Run is that Run's own
     * settlement unit, so this Run owes its owner nothing and answers nothing.
     */
    admissionDelivery(): RunInvocationDelivery | undefined;
    /**
     * The Run obligation publishing this handle detaches the item into (SPEC §5.2, §5.6).
     * Terminalization captures whatever is still reserved, so an outstanding handle withholds
     * Settled without holding any Turn.
     */
    obligation(): RunObligation;
    equals(other: TurnAdmissionHandle): boolean;
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnAdmissionHandle;
}
export declare const TurnAdmissionHandleCodec: RecordCodec<TurnAdmissionHandle>;
/** The EffectAttempt an AttemptReceipt names, as the Turn seam reads it (SPEC §7.4). */
export interface TurnAdmissionAttemptFacts {
    readonly id: EffectAttemptId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly idempotencyKey: string;
}
/** The attempt and result a succeeded Receipt admits a handle over. */
export interface TurnAdmittedItem {
    readonly attempt: TurnAdmissionAttemptFacts;
    readonly result: ContentRef;
}
/**
 * What one item's Receipt says (SPEC §7.4), reduced to what a handle is built from. Three
 * shapes for three questions, because a single `succeeded` flag answered two of them at
 * once: a pre-effect Receipt never attempted anything, while an attempt Receipt that failed
 * or came back indeterminate attempted and did not succeed, and reporting both as "not
 * succeeded" left one refusal covering two different operator actions. Only the succeeded
 * case can be constructed at all, and it cannot be constructed without its result, so the
 * pairings the verifier used to check are now unrepresentable.
 *
 * `detail` carries why a non-admitting Receipt does not admit — a pre-effect outcome and
 * reason, or an unsuccessful attempt's outcome and failure kind. It exists for the refusal
 * message and is deliberately unreachable from `admitted()`, so no admission decision can
 * come to depend on Receipt failure state (§7.4, C13-RECEIPT-FAILURE-ORTHOGONAL).
 */
export declare abstract class TurnAdmissionReceiptFacts {
    /** A Receipt over an item that never reached an EffectAttempt, so nothing succeeded. */
    static preEffect(detail: string): TurnAdmissionReceiptFacts;
    /** An attempt Receipt that attempted and did not succeed; it names no result. */
    static unsucceeded(attempt: TurnAdmissionAttemptFacts, detail: string): TurnAdmissionReceiptFacts;
    /** The only shape that admits a handle, and it cannot exist without its result. */
    static succeeded(attempt: TurnAdmissionAttemptFacts, result: ContentRef): TurnAdmissionReceiptFacts;
    /**
     * The attempt and result this Receipt admits a handle over, or a typed refusal naming
     * which non-admitting case it is. Returning rather than reporting keeps the two answers
     * distinct without a nullable pair for a caller to re-check.
     */
    abstract admit(): TurnAdmittedItem;
}
/**
 * Reads the §7.4 evidence a handle is built from. Deliberately narrow: this seam retrieves
 * records and resolves content and decides nothing, so every rule about what that evidence
 * must say lives in `TurnAdmissionVerifier` and no substrate can admit a handle the Turn
 * layer would refuse.
 */
export declare abstract class TurnAdmissionRecordPort {
    abstract receipt(receipt: ReceiptId): Promise<TurnAdmissionReceiptFacts | undefined>;
    abstract result(ref: ContentRef): Promise<Uint8Array>;
}
/** The Turn presenting an admission, and the exact lease that proves it is that Turn. */
export interface TurnAdmissionScope {
    readonly run: RunId;
    readonly turn: TurnId;
    readonly token: LeaseToken;
}
export interface TurnAdmissionRequest extends TurnAdmissionScope {
    /** The bound Operation's impact; only `delegate` can carry a child RunRef (SPEC §5.6). */
    readonly impact: Impact;
    readonly invocation: InvocationId;
    readonly receipts: readonly ReceiptId[];
}
/**
 * Builds a handle at either of the two commit points §5.6 gives one, or refuses. Admission
 * itself is untouched in both: this runs after the Invocation plane has recorded what it
 * records, and reads that rather than adding to it.
 *
 * `admit` is the admission commit point. An item with a durable EffectAttempt and no Receipt
 * is exactly what a detached admission leaves, so the facts of that item are all this path
 * reads and there is no Receipt for it to wait on.
 *
 * `verify` is the Receipt commit point, which one identity genuinely needs: a child RunRef
 * cannot exist before the spawn's `delegate` Receipt carries it. A spawn's Receipt has to
 * carry that RunRef and nothing else, so a result naming a child alongside any other field is
 * rejected instead of being read as a child handle plus extra output. A mediated result that
 * names no child leaves the Invocation as the identity, and the item facts it is built from
 * are the ones the Receipt's own EffectAttempt reports, so both paths end in one builder.
 */
export declare class TurnAdmissionVerifier {
    private readonly records;
    constructor(records: TurnAdmissionRecordPort);
    /**
     * The handle an admitted item admits, with no Receipt read (SPEC §5.6). The item is the
     * whole evidence: it names the Invocation, the item index, that item's key and the exact
     * EffectAttempt admission recorded, which is what a later delivery is matched against.
     */
    admit(scope: TurnAdmissionScope, item: AdmittedInvocationItem): TurnAdmissionHandle;
    verify(request: TurnAdmissionRequest): Promise<TurnAdmissionHandle>;
    private build;
    private requireIssuingScope;
}
/**
 * An Event a handle addresses to a Turn's inbox (SPEC §5.6). Cancellation is not one of
 * them: `turn.cancel` is the reserved inbox Event a fence delivers, and routing it through a
 * handle would make a detached reference a way to end a Turn it no longer belongs to.
 */
export declare abstract class TurnAdmissionMessage {
    /** The awaited answer, arriving as ordinary history once admission has detached. */
    static outcome(payload: FacetData): TurnAdmissionMessage;
    /** External steering of admitted work, keyed by the caller's own nonce. */
    static steering(nonce: string, payload: FacetData): TurnAdmissionMessage;
    abstract readonly event: string;
    abstract readonly payload: FacetData;
    abstract key(handle: TurnAdmissionHandle): string;
}
export interface TurnAdmissionDelivery {
    readonly handle: TurnAdmissionHandle;
    /** The Turn being addressed: the issuing Turn, or a later one reading it as history. */
    readonly turn: TurnId;
    readonly expected: Revision;
    /** That Turn's exact current lease. A handle addresses work; a lease authorizes writes. */
    readonly token: LeaseToken;
    readonly message: TurnAdmissionMessage;
    readonly now: Date;
}
/**
 * Publishes handles and addresses the work they name (SPEC §5.6).
 *
 * Publication is the point where an item stops being awaited and becomes owned by the Run,
 * so it reserves exactly the §5.2 admission obligation terminalization already knows how to
 * capture — the handle's lifetime and the Run's terminalization are therefore one story:
 * terminalization closes the registry with the handle's item still in the frontier, the Run
 * terminalizes normally, and `isSettled` withholds Settled until that item has a terminal
 * current Receipt. A handle is never a hold on a Turn, which is why ending the issuing Turn
 * is the ordinary case this shape exists for.
 *
 * Every mutation here presents the addressed Turn's exact current lease and is refused
 * without it, so a handle that outlives its Turn can still name the work and can no longer
 * write as it.
 */
export declare class TurnAdmissionPublisher<Transaction> {
    private readonly runtime;
    private readonly content;
    constructor(runtime: RunRuntime<Transaction>, content: ContentStore);
    /**
     * Reserves the Run obligation a published handle detaches its item into, and in the same
     * transaction takes on the message its Invocation owner is owed (SPEC §5.2, §5.6).
     *
     * One transaction, because the two facts are one fact: an obligation the Run holds with
     * no message durable would leave the owner never told to start, and a message durable
     * with no obligation would let the Run settle while the item is still owed.
     */
    publish(handle: TurnAdmissionHandle, token: LeaseToken, now: Date): RunAdmissionReservation;
    /** Discharges a published handle's obligation once its item is no longer outstanding. */
    settle(reservation: RunAdmissionReservation): void;
    /**
     * Appends the handle's addressed Event to a Turn's inbox under that Turn's own lease. The
     * addressed Turn may be a later one than the issuing Turn — that is the shape §5.6 exists
     * for — but never one outside the Run the handle detached into, so a handle can be read
     * as history without becoming reach into an unrelated Run.
     */
    deliver(delivery: TurnAdmissionDelivery): Promise<TurnInboxEntry>;
    private requireIssuingLease;
}
