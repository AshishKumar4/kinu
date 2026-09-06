import { Revision } from "../../core/index.js";
import type { PrincipalRef } from "../../identity/index.js";
import type { RunCommitId, TurnId } from "../../execution-references/index.js";
import type { ReceiptId } from "../../invocation-references/index.js";
import type { AuditRecordId, EventId } from "../../interaction-references/index.js";
import { TurnCutPointPort } from "../../operations/index.js";
import type { RunSourceRevisionPort } from "../source.js";
import type { AcceptanceCriterion, AcceptanceVerdict } from "./acceptance.js";
import { RunCommit } from "./commit.js";
import { type RunAdmissionReservation, type RunObligation } from "./admission.js";
import { type ResourceCeiling, type ResourceDimension } from "./ceiling.js";
import type { RealizedCost } from "./cost.js";
import type { RunEvidencePort, RunMergePort } from "./evidence.js";
import { RunId, type AcceptanceId, type RunBranchId } from "./id.js";
import type { TurnAdmissionHandle } from "./handle.js";
import { RunInvocationDelivery } from "./invocation-delivery.js";
import { type LeaseToken } from "./lease.js";
import { RunConfigurationSnapshot } from "./pins.js";
import { TurnPlacementSnapshot } from "./placement.js";
import { Run, RunBranch } from "./run.js";
import { RunSpawnPort, SpawnReservation } from "./spawn.js";
import { SettlementEvidencePort, TerminalSnapshot, type RunOutcome } from "./settlement.js";
import { RunRepository } from "./store.js";
import { RunCheckpoint, Turn, TurnInboxEntry, type TurnTerminalStatus } from "./turn.js";
export interface RunGenesis {
    readonly run: Run;
    readonly configuration: RunConfigurationSnapshot;
    readonly branch: RunBranch;
    readonly root: RunCommit;
    readonly acceptanceCriteria?: readonly AcceptanceCriterion[];
}
export interface TurnGenesis {
    readonly turn: Turn;
    readonly placement: TurnPlacementSnapshot;
}
export interface SuspendTurnRequest {
    readonly turn: TurnId;
    readonly expectedTurnRevision: Revision;
    readonly expectedBranchRevision: Revision;
    readonly token: LeaseToken;
    readonly checkpoint: RunCheckpoint;
    readonly commit: RunCommit;
    readonly now: Date;
}
export interface CompleteTurnRequest {
    readonly turn: TurnId;
    readonly expectedTurnRevision: Revision;
    readonly expectedBranchRevision: Revision;
    readonly token: LeaseToken;
    readonly outcome: TurnTerminalStatus;
    readonly commit: RunCommit;
    readonly now: Date;
}
export interface TerminalizeRunRequest {
    readonly run: RunId;
    readonly turn: TurnId;
    readonly expectedRunRevision: Revision;
    readonly expectedTurnRevision: Revision;
    readonly expectedBranchRevision: Revision;
    readonly token: LeaseToken;
    readonly outcome: RunOutcome;
    readonly commit: RunCommit;
    readonly forcedCancellationControl?: ForcedCancellationControl;
    readonly siblingCancellations: ReadonlyMap<string, SiblingCancellationEvidence>;
    readonly exhausted?: ResourceDimension;
    /**
     * The cancellation a `cancelled` outcome carries (SPEC §5.6). §7.4 builds `aborted` only
     * from cancellation that reached the attempt, so a cancelled Run has to name the signal
     * that reached the items its Turns published, and every other outcome names none.
     */
    readonly cancellation?: AbortSignal;
    readonly now: Date;
}
export interface ForcedCancellationControl {
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
}
export interface SiblingCancellationEvidence {
    readonly event: EventId;
    readonly audit: AuditRecordId;
}
/**
 * What one Run terminalization produced (SPEC §5.2).
 *
 * The cancellation messages its published items are owed are NOT here. They are durable
 * records on the Run, because a message that existed only in this response would be lost by
 * a lost response, and a terminal Run admits no second terminalization to produce it again.
 * A caller reads them back through `pendingInvocationDeliveries` and discharges each one
 * through `acknowledgeInvocationDelivery`.
 */
export interface RunTerminalization {
    readonly snapshot: TerminalSnapshot;
}
export declare class RunRuntime<Transaction> {
    readonly repository: RunRepository<Transaction>;
    private readonly sources;
    private readonly evidence;
    private readonly settlement;
    private readonly spawn;
    private readonly merge;
    private readonly cutPoints;
    constructor(repository: RunRepository<Transaction>, sources: RunSourceRevisionPort<Transaction, RunConfigurationSnapshot>, evidence: RunEvidencePort<Transaction>, settlement: SettlementEvidencePort<Transaction>, spawn: RunSpawnPort<Transaction>, merge: RunMergePort<Transaction>, cutPoints: TurnCutPointPort);
    createRun(genesis: RunGenesis): void;
    spawnRun(reservation: SpawnReservation, genesis: RunGenesis, now: Date): void;
    spawnRunInTransaction(tx: Transaction, reservation: SpawnReservation, genesis: RunGenesis, now: Date): void;
    createRunInTransaction(tx: Transaction, genesis: RunGenesis): void;
    reserveRunObligation(run: RunId, obligation: RunObligation): RunAdmissionReservation;
    reserveRunObligationInTransaction(tx: Transaction, run: RunId, obligation: RunObligation): RunAdmissionReservation;
    completeRunObligation(reservation: RunAdmissionReservation): void;
    completeRunObligationInTransaction(tx: Transaction, reservation: RunAdmissionReservation): void;
    acceptsRunAdmission(reservation: RunAdmissionReservation): boolean;
    acceptsRunAdmissionInTransaction(tx: Transaction, reservation: RunAdmissionReservation): boolean;
    recordAcceptanceVerdict(run: RunId, verdict: AcceptanceVerdict): void;
    recordAcceptanceVerdictInTransaction(tx: Transaction, runId: RunId, verdict: AcceptanceVerdict): void;
    acceptanceAttemptAdmissible(run: RunId, acceptance: AcceptanceId): boolean;
    acceptanceAttemptAdmissibleInTransaction(tx: Transaction, runId: RunId, acceptance: AcceptanceId): boolean;
    acceptanceSatisfied(run: RunId, acceptance: AcceptanceId): boolean;
    acceptanceSatisfiedInTransaction(tx: Transaction, runId: RunId, acceptance: AcceptanceId): boolean;
    createBranch(runId: RunId, branch: RunBranch, expectedRunRevision: Revision): void;
    createBranchInTransaction(tx: Transaction, runId: RunId, branch: RunBranch, expectedRunRevision: Revision): void;
    appendTurnCommit(commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    appendTurnCommitInTransaction(tx: Transaction, commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    appendSystemEvidenceCommit(commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    appendSystemEvidenceCommitInTransaction(tx: Transaction, commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    mergeRun(commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    mergeRunInTransaction(tx: Transaction, commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    undoRun(commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    undoRunInTransaction(tx: Transaction, commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    /**
     * Opens a rewrite bracket: reserves the planned rewrite's RunCommitId as a systemCommit
     * obligation and records it on the branch, which is what makes a second uncompleted
     * rewrite attempt on that branch rejected rather than raced.
     */
    reserveRunRewrite(runId: RunId, branchId: RunBranchId, planned: RunCommitId, expectedBranchRevision: Revision): RunAdmissionReservation;
    reserveRunRewriteInTransaction(tx: Transaction, runId: RunId, branchId: RunBranchId, planned: RunCommitId, expectedBranchRevision: Revision): RunAdmissionReservation;
    /**
     * Closes a rewrite bracket by appending exactly the reserved commit, installed with the
     * commits it shadows or abandoned on that attempt's failed Receipt. Both forms complete
     * the obligation, so an attempt that produced nothing neither blocks settlement nor
     * disappears from the log.
     */
    rewriteRun(commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    rewriteRunInTransaction(tx: Transaction, commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    migrateRun(commit: RunCommit, target: RunConfigurationSnapshot, expectedBranchRevision: Revision, now: Date): void;
    migrateRunInTransaction(tx: Transaction, commit: RunCommit, target: RunConfigurationSnapshot, expectedBranchRevision: Revision, now: Date): void;
    appendCapturedEvidence(commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    appendCapturedEvidenceInTransaction(tx: Transaction, commit: RunCommit, expectedBranchRevision: Revision, now: Date): void;
    createTurn(genesis: TurnGenesis, expectedBranchRevision: Revision): void;
    createTurnInTransaction(tx: Transaction, genesis: TurnGenesis, expectedBranchRevision: Revision): void;
    claimTurn(turnId: TurnId, expected: Revision, holder: PrincipalRef, now: Date, expiresAt: Date): Turn;
    claimTurnInTransaction(tx: Transaction, turnId: TurnId, expected: Revision, holder: PrincipalRef, now: Date, expiresAt: Date): Turn;
    renewTurn(turnId: TurnId, expected: Revision, token: LeaseToken, now: Date, expiresAt: Date): Turn;
    renewTurnInTransaction(tx: Transaction, turnId: TurnId, expected: Revision, token: LeaseToken, now: Date, expiresAt: Date): Turn;
    reclaimTurn(turnId: TurnId, expected: Revision, holder: PrincipalRef, now: Date, expiresAt: Date, cancellation: TurnInboxEntry): Turn;
    reclaimTurnInTransaction(tx: Transaction, turnId: TurnId, expected: Revision, holder: PrincipalRef, now: Date, expiresAt: Date, cancellation: TurnInboxEntry): Turn;
    cancelUnheldTurn(turnId: TurnId, expected: Revision): Turn;
    cancelUnheldTurnInTransaction(tx: Transaction, turnId: TurnId, expected: Revision): Turn;
    deliverEvent(turnId: TurnId, expected: Revision, token: LeaseToken, entry: TurnInboxEntry, now: Date): void;
    deliverEventInTransaction(tx: Transaction, turnId: TurnId, expected: Revision, token: LeaseToken, entry: TurnInboxEntry, now: Date): void;
    /**
     * SPEC §4.4's `input.submitted`, fired at the one place a submission reaches a running
     * Turn (§5.6's `turn.deliverEvent`) and before that submission becomes durable inbox
     * history — so a block refuses it outright and leaves no entry behind.
     *
     * The value in flight is the submission envelope, and a rewrite may transform only the
     * payload. An Interceptor is synchronous (rule 1) while content resolves through an
     * asynchronous ContentStore (§8.2), so transforming means naming content the interceptor
     * has already stored rather than editing bytes in hand; the substitution inherits
     * exactly the retention obligation the original submission carried, and nothing here
     * verified the original either. The event name and the idempotency key are delivery
     * identity: changing the name would forge a different submission, and changing the key
     * would defeat the at-least-once dedupe this inbox is ordered by (§6.1).
     */
    private submitted;
    suspendTurn(request: SuspendTurnRequest): void;
    suspendTurnInTransaction(tx: Transaction, request: SuspendTurnRequest): void;
    completeTurn(request: CompleteTurnRequest): void;
    completeTurnInTransaction(tx: Transaction, request: CompleteTurnRequest): void;
    cancelHeldTurn(request: CompleteTurnRequest, cancellation: TurnInboxEntry): void;
    cancelHeldTurnInTransaction(tx: Transaction, request: CompleteTurnRequest, cancellation: TurnInboxEntry): void;
    timeoutTurn(turnId: TurnId, expected: Revision, cancellation: TurnInboxEntry, now: Date): Turn;
    timeoutTurnInTransaction(tx: Transaction, turnId: TurnId, expected: Revision, cancellation: TurnInboxEntry, now: Date): Turn;
    terminalizeRun(request: TerminalizeRunRequest): RunTerminalization;
    terminalizeRunInTransaction(tx: Transaction, request: TerminalizeRunRequest): RunTerminalization;
    /**
     * The messages cancelling this Run owes the Invocation owners of the items its Turns
     * published (SPEC §5.6).
     *
     * Publication is what detaches an item from the Turn that issued it, and it detaches the
     * item to a Run: the issuing Run for an `InvocationId` handle, the child Run for a
     * `RunRef`. So this reads each captured item's handle back and asks the handle whose
     * cancellation it answers to. Cancelling this Run reaches the items it owns and stops
     * there — a child Run is its own settlement unit — and cancelling a Turn reaches none of
     * them, because a published item's owner is a RunId and a TurnId never equals one.
     *
     * Only an item still owed a Receipt is addressed. An item whose current Receipt is
     * already terminal was finished before the cancellation arrived, and §7.4 admits no
     * second Receipt over it, so addressing it would ask for a record that already exists.
     *
     * An item no Turn published is reached by neither: it is still awaited, so the Turn owns
     * it and `C13-FACET-CANCELLATION-REACH` is the rule that ends it. That is why an
     * unresolved handle is silence here rather than a refusal — §5.6 draws exactly this line
     * between an awaited item and a published one.
     *
     * Every message is a request naming the exact attempt, never a failure kind. The Run
     * knows that it ended; only the Invocation owner's own target can observe whether
     * cancellation reached the attempt, which is what §7.4 builds `aborted` from.
     */
    private cancellationDeliveriesInTransaction;
    /**
     * Reserves the Run obligation a published handle detaches its item into and takes on the
     * message its Invocation owner is owed, in one transaction (SPEC §5.2, §5.6). An item
     * detached to a child Run reserves the obligation and owes this Run's owner nothing.
     */
    publishAdmissionInTransaction(tx: Transaction, handle: TurnAdmissionHandle): RunAdmissionReservation;
    /** The messages this Run still owes Invocation owners, in canonical order (SPEC §5.6). */
    pendingInvocationDeliveries(run: RunId): readonly RunInvocationDelivery[];
    pendingInvocationDeliveriesInTransaction(tx: Transaction, run: RunId): readonly RunInvocationDelivery[];
    /**
     * Discharges one message its Invocation owner has acknowledged (SPEC §5.6, §6.1).
     *
     * The caller presents the message rather than an expected Run revision, and that is the
     * point: delivery is at-least-once, so the ordinary retry is an owner whose
     * acknowledgement response was lost and which therefore knows no current revision. The
     * transaction reads the Run itself, so the compare-and-set is against the state the
     * discharge actually applies to. A message of another Run is refused; a message already
     * discharged changes nothing and is not an error.
     */
    acknowledgeInvocationDelivery(delivery: RunInvocationDelivery): void;
    acknowledgeInvocationDeliveryInTransaction(tx: Transaction, delivery: RunInvocationDelivery): void;
    /**
     * Accumulated where a model call commits (SPEC §5.1, §5.2). `tokens` and `costMicros`
     * are the two ceiling dimensions with no derivation from records the Run already keeps,
     * so both advance here, in one transaction, or neither does. A host with no realized
     * cost to report passes none and leaves the dimension unbounded; it never passes an
     * estimate, and there is no field an estimate could travel in.
     */
    recordModelUsage(runId: RunId, tokens: number, cost?: RealizedCost): Run;
    recordModelUsageInTransaction(tx: Transaction, runId: RunId, tokens: number, cost?: RealizedCost): Run;
    /**
     * Every currency the Runs sharing this Run's lineage already record cost in (SPEC §5.2).
     *
     * A lineage runs from the root down through the spawn chain, so a Run shares a lineage
     * with its ancestors and with its descendants, and a cost recorded here is a cost in every
     * one of their lineages. Both directions therefore bind: reading only ancestors admitted a
     * parent's second currency whenever a child had recorded first, because the child's walk
     * found nothing above it and the parent's found nothing below. Siblings share no lineage —
     * neither is the other's ancestor — so neither constrains the other, and a parent that
     * would sit in both of their lineages is refused instead.
     *
     * The answer is derived from the durable Run records the spawn lineage already keeps, so a
     * mixed-currency lineage is refused at the recording path rather than stored a second time
     * or surfacing later as a remainder nobody can compare.
     */
    private lineageCurrenciesInTransaction;
    remainingResources(runId: RunId, now: Date): ResourceCeiling | undefined;
    remainingResourcesInTransaction(tx: Transaction, runId: RunId, now: Date): ResourceCeiling | undefined;
    exhaustedResource(runId: RunId, now: Date): ResourceDimension | undefined;
    settled(runId: RunId): boolean;
    settledInTransaction(tx: Transaction, runId: RunId): boolean;
    effectiveCommit(runId: RunId, branchId: RunBranchId): RunCommitId;
    effectiveBranchCommitInTransaction(tx: Transaction, runId: RunId, branchId: RunBranchId): RunCommitId;
    /**
     * The model-visible sequence a call reads. With `base` omitted it derives at the
     * branch's effective state; with `base` given it derives at exactly that commit, which
     * is how a reconstruction stays fixed by ancestry rather than by when it runs.
     */
    effectiveTranscript(runId: RunId, branchId: RunBranchId, base?: RunCommitId): readonly RunCommit[];
    effectiveTranscriptInTransaction(tx: Transaction, runId: RunId, branchId: RunBranchId, base?: RunCommitId): readonly RunCommit[];
    private appendInTransaction;
    private validateMerge;
    /**
     * A merge authorized by one item of a declared fold must be the step that item declared.
     * The declaration is the ordered `administer` payload (§5.2); the merge chain below this
     * commit is what the fold has done so far, so the two are compared rather than a position
     * being trusted from the record that claims it.
     */
    private validateFoldStep;
    /** The fold item a control-authored commit's Receipt carries, if it carries one. */
    private foldStepOf;
    /** Steps of the same fold already appended below a commit, nearest first. */
    private precedingFoldSteps;
    private updateTurnInTransaction;
    private appendCancellation;
    private forceCancelSiblings;
    private validateTerminalSiblings;
    private requireAdministerControl;
    private requireForcedCancellationEvidence;
    private requireTurnAndBranch;
    private requireAttenuation;
    private remainingInTransaction;
    private requireNarrowingCeiling;
    private headTreeDigestInTransaction;
    /**
     * Resolves a commit identity against the store, answering for `pending` itself so the
     * same derivation decides a cut a commit proposes and one it already made.
     */
    private commitLoader;
    private transcriptAt;
    /**
     * A `TextId` keeps its identity in its class and its value, but every subclass has the
     * same shape, so a TurnId presented where a RunId is required is a value this signature
     * cannot refuse on its own. Storage keys are text, so such a call would load the Run
     * whose id reads the same and then compare identities that never match — a cancellation
     * that reached no published item, and nothing said so. The exact class is required here,
     * at the one gate every Run mutation passes through.
     */
    private requireActiveRun;
    private requireAdmission;
    private requireConfigurationForPins;
}
