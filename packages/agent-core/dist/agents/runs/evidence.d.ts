import { ContentRef } from "../../core/index.js";
import type { OperationRef } from "../../facets/index.js";
import type { EffectAttemptId, ReceiptId } from "../../invocation-references/index.js";
import type { AttemptReceiptOutcome, EffectAttempt, PreparedInvocation, PreparedInvocationHeader, Receipt } from "../../invocations/index.js";
import type { AuditRecordId, EventId, InvocationId, RouteReservationId } from "../../interaction-references/index.js";
import type { LeaseToken } from "./lease.js";
import type { TurnAdmissionHandle } from "./handle.js";
import type { RunBranchId, RunId } from "./id.js";
import type { RunCommit } from "./commit.js";
import type { AgentPolicyId } from "../id.js";
import type { AgentPolicyRevisionRecord } from "../source.js";
import type { SourcePin } from "./pins.js";
import type { TurnId } from "../../execution-references/index.js";
export interface ReceiptCommitEvidence {
    readonly kind: "receipt";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly invocation: InvocationId;
    readonly subjectTurn?: LeaseToken["turn"];
}
export interface DeliveryCommitEvidence {
    readonly kind: "delivery";
    readonly run: RunId;
    readonly reservation: RouteReservationId;
    readonly audit: AuditRecordId;
    readonly subjectTurn?: LeaseToken["turn"];
}
/**
 * One item of the ordered `administer` payload a multiway fold declares (§5.2). The order is
 * the caller's, fixed by the Invocation's argument digest before the first merge is attempted,
 * so nothing here is a second copy of the graph: the fold is the request, the merge chain is
 * the result, and each merge already had to name this exact control Receipt.
 */
export interface MergeFoldStep {
    readonly invocation: InvocationId;
    /** Zero-based position of this binary merge in the declared fold. */
    readonly itemIndex: number;
    /** Length of the declared payload; one item declares no order. */
    readonly itemCount: number;
    /** The branch this item declared as the merge's source lineage. */
    readonly source: RunBranchId;
}
export interface ControlCommitEvidence {
    readonly kind: "control";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly proposalDigest: string;
    /** Present when this control Receipt is one item of a declared fold. */
    readonly fold?: MergeFoldStep;
}
/**
 * The one commit this platform admits on failed control evidence: a rewrite whose attempt
 * ended without installing anything. It binds the Run, the proposal and the audit record to
 * one Receipt and stops there: §7.4's closed failure kind on that Receipt is what says why the
 * attempt ended, so this evidence names the Receipt and never restates its determination. A
 * `failed` outcome and a failure label beside the Receipt were both that restatement, and a
 * host could name a kind the Receipt contradicted; `validateCommitWriter` now loads the
 * Receipt and reads the kind off it, so an abandoned attempt that says nothing about why it
 * ended is refused on the Receipt's own record rather than on a label.
 */
export interface AbandonedRewriteEvidence {
    readonly kind: "abandonedRewrite";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly proposalDigest: string;
}
export interface SynthesisCommitEvidence {
    readonly kind: "synthesis";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly token: LeaseToken;
    readonly content: ContentRef;
}
export interface AdministerControlEvidence {
    readonly kind: "administer";
    readonly run: RunId;
    readonly terminalTurn: TurnId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly outcome: "succeeded";
}
export interface AcceptanceReceiptEvidence {
    readonly kind: "acceptanceReceipt";
    readonly receipt: ReceiptId;
    readonly outcome: AttemptReceiptOutcome;
    /** The Operation this Receipt's attempt invoked, so discharge can bind it to the
     *  criterion's declared verifier rather than accept any succeeded Receipt. */
    readonly operation: OperationRef;
}
export interface ForcedCancellationEvidence {
    readonly kind: "turnCancellation";
    readonly eventKind: "turn.cancel";
    readonly run: RunId;
    readonly terminalTurn: TurnId;
    readonly turn: TurnId;
    readonly priorLeaseEpoch: number;
    readonly fencedLeaseEpoch: number;
    readonly inboxLeaseEpoch: number;
    readonly controlReceipt: ReceiptId;
    readonly controlAudit: AuditRecordId;
    readonly event: EventId;
    readonly audit: AuditRecordId;
}
/**
 * SPEC §7.3's `InvocationAuthority` as the Run plane reads it off a stored PreparedInvocation:
 * the Principal the invocation was prepared for. The mediation plane carries it as a
 * structural reference, and this is the shape of that reference the Run plane depends on.
 */
export interface ControlInvocationAuthority {
    readonly kind: "initiator" | "delegated";
    readonly tenant: string;
    readonly principal: string;
}
/**
 * The fields of a stored §7.4 EffectAttempt a control commit is read against. It is the
 * stored record itself, narrowed by `Pick` to the fields that do not depend on the mediation
 * plane's own lease and admission references, so no second shape of the attempt exists.
 */
export type ControlEffectAttempt = Pick<EffectAttempt<never, never>, "id" | "invocation" | "itemIndex">;
/**
 * The fields of a stored §7.3 PreparedInvocation a control commit is read against: the
 * invocation identity, the pinned Operation (whose impact it declares), the authority it was
 * prepared under, and its item count. Narrowed by `Pick` from the record itself, as above.
 */
export interface ControlPreparedInvocation extends Pick<PreparedInvocation<never, ControlInvocationAuthority, never, never>, "itemCount"> {
    readonly header: Pick<PreparedInvocationHeader<never, ControlInvocationAuthority, never, never>, "id" | "operation" | "authority">;
}
export declare abstract class RunEvidencePort<Transaction> {
    abstract receipt(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): ReceiptCommitEvidence | undefined;
    abstract delivery(transaction: Transaction, reservation: RouteReservationId, audit: AuditRecordId): DeliveryCommitEvidence | undefined;
    abstract control(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): ControlCommitEvidence | undefined;
    abstract abandonedRewrite(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): AbandonedRewriteEvidence | undefined;
    /**
     * The §7.4 Receipt this id names, exactly as §7.4 recorded it. Deliberately narrow: it
     * retrieves the record and decides nothing, so a commit that stands on a failed attempt
     * reads why that attempt ended off the Receipt rather than off a label beside it, and
     * every rule about what a commit may stand on stays in `validateCommitWriter`.
     */
    abstract storedReceipt(transaction: Transaction, receipt: ReceiptId): Receipt | undefined;
    /** The §7.4 EffectAttempt this id names, exactly as recorded; it decides nothing. */
    abstract storedAttempt(transaction: Transaction, attempt: EffectAttemptId): ControlEffectAttempt | undefined;
    /** The §7.3 PreparedInvocation this id names, exactly as recorded; it decides nothing. */
    abstract storedInvocation(transaction: Transaction, invocation: InvocationId): ControlPreparedInvocation | undefined;
    /**
     * The handle a Turn published for one admitted item (SPEC §5.6), or none where no Turn
     * published it. Publication is what detaches an item from its Turn to a Run, and which
     * Run that is lives in the handle's admission identity, so a Run's cancellation has to
     * read the handle back rather than infer an owner from the obligation. Nothing here is a
     * second copy of state: every field of a handle is already owned durably by the §7.4
     * records it names, which is why a table of handles is exactly what this platform does
     * not keep, and this seam derives the value from those records instead.
     */
    abstract publishedHandle(transaction: Transaction, invocation: InvocationId, itemIndex: number, itemKey: string): TurnAdmissionHandle | undefined;
    abstract synthesis(transaction: Transaction, receipt: ReceiptId): SynthesisCommitEvidence | undefined;
    abstract administer(transaction: Transaction, receipt: ReceiptId, audit: AuditRecordId): AdministerControlEvidence | undefined;
    abstract forcedCancellation(transaction: Transaction, event: EventId, audit: AuditRecordId): ForcedCancellationEvidence | undefined;
    abstract acceptance(transaction: Transaction, receipt: ReceiptId): AcceptanceReceiptEvidence | undefined;
}
export declare abstract class RunMergePort<Transaction> {
    abstract verifyConcat(transaction: Transaction, commit: RunCommit, target: RunCommit, source: RunCommit): boolean;
    /**
     * Whether the merge's `treeResolution.base` names the one common-ancestor tree of its two
     * parents (§5.2.1). Everything else about the tree — the Environment, the declared policy,
     * and the per-path conflicts — the Run plane derives from the decoded trees itself.
     */
    abstract verifyTreeBase(transaction: Transaction, commit: RunCommit, target: RunCommit, source: RunCommit): boolean;
    /**
     * The source revision record for exactly this effective-policy id and revision, or nothing
     * where none exists. It retrieves and decides nothing: the Run plane compares the record
     * against the pin and reads `policies.treeMerge` (§5.2.1, §9.2) off the prefetched bytes
     * whose digest is the pinned one, so the declaration a merge follows is the pinned one.
     */
    abstract effectivePolicy(transaction: Transaction, pin: SourcePin<AgentPolicyId>): AgentPolicyRevisionRecord | undefined;
}
