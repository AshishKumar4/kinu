import type { ContentPutResult } from "../../content/index.js";
import { ContentStore, type ContentStat, type MediaHint } from "../../content/index.js";
import { ContentRef, RecordCodec, TextId, type JsonValue } from "../../core/index.js";
import { RunCommitId } from "../../execution-references/index.js";
import { BindingName, FacetRef, InterceptorId, OperationDescriptor, OperationRef, type FacetData } from "../../facets/index.js";
import { OperationGateway, TurnCutPointPort, type OperationRequestKey, type TurnStopRequest } from "../../operations/index.js";
import { RunCommit } from "./commit.js";
import { TurnInboxEntryId } from "./id.js";
import type { TurnAdmissionHandle, TurnAdmissionVerifier } from "./handle.js";
import { type LeaseToken } from "./lease.js";
import type { TurnPlacementSnapshot } from "./placement.js";
import { CodecRecord } from "../record-data.js";
import { RealizedCost } from "./cost.js";
import { RunRuntime } from "./runtime.js";
import { RunRepository } from "./store.js";
import { RunCheckpoint, Turn, TurnInboxEntry } from "./turn.js";
export declare class TurnBoundOperation {
    readonly binding: BindingName;
    readonly facet: FacetRef;
    readonly operation: OperationRef;
    readonly descriptor: OperationDescriptor;
    constructor(binding: BindingName, facet: FacetRef, operation: OperationRef, descriptor: OperationDescriptor);
}
export interface TurnExecutionScope {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly effectiveCommit: RunCommit;
    readonly placement: TurnPlacementSnapshot;
    readonly resumeCheckpoint: RunCheckpoint | undefined;
}
export declare abstract class TurnOperationSource {
    abstract resolve(scope: TurnExecutionScope): Promise<readonly TurnBoundOperation[]>;
}
export interface TurnPromptAssembly extends TurnExecutionScope {
    readonly operations: readonly TurnBoundOperation[];
}
export declare abstract class TurnPromptAssembler {
    abstract assemble(request: TurnPromptAssembly): Promise<ContentRef>;
}
export interface TurnInvocationRequest {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly operation: TurnBoundOperation;
    readonly requestKey: OperationRequestKey;
    readonly input: FacetData;
    readonly signal: AbortSignal;
}
/**
 * Which enforcement tier served the call (§7.2). Only `mediated` carries evidence: a
 * direct call performs its authority, lease, watermark, PathEpochEvidence, and deadline
 * checks in memory and writes nothing durable, so there is no Invocation for it to name.
 * The tier is on the result rather than the request because policy, not the executor,
 * decides it — the agent loop that §1.1 motivates the direct tier for makes an ordinary
 * `observe` call and is served by whichever tier the resolved authority admits.
 */
export type TurnInvocationResult = {
    readonly tier: "direct";
    readonly output: FacetData;
} | {
    readonly tier: "mediated";
    readonly output: FacetData;
    readonly evidence: FacetData;
    /**
     * The verified admission identity of this call, which an executor MAY hand the
     * model in place of the output (SPEC §5.6). It is read off the records this
     * dispatch already produced, so offering it changes nothing about admission.
     *
     * This is the awaited shape: the dispatch ran, so the Receipt that names its
     * EffectAttempt exists and is what the identity is verified over. A `delegate`
     * spawn commits its child RunRef at that Receipt and can commit nowhere earlier.
     * The detached shape is the other commit point — admission — and it is reached
     * through the Invocation plane's own detached entry rather than through a
     * dispatch that has already run.
     */
    readonly admission: TurnAdmissionHandle;
};
export declare abstract class TurnInvocationPort {
    abstract invoke(request: TurnInvocationRequest): Promise<TurnInvocationResult>;
}
export interface TurnGatewayScope {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly signal: AbortSignal;
}
export declare abstract class TurnGatewaySource {
    abstract open(scope: TurnGatewayScope): Promise<OperationGateway>;
}
export declare class GatewayTurnInvocationPort extends TurnInvocationPort {
    private readonly gateways;
    private readonly admissions;
    constructor(gateways: TurnGatewaySource, admissions: TurnAdmissionVerifier);
    invoke(request: TurnInvocationRequest): Promise<TurnInvocationResult>;
}
/**
 * What one model call consumed, as the host observed it. The token counts arrive in the
 * model response. `cost` does not: a price comes from a provider rate that varies by model,
 * by contract, and over time, so SPEC §5.2 leaves the rate source out of scope and requires
 * the amount reported here to be cost the call actually incurred. A host with no realized
 * cost reports none, which leaves the `costMicros` dimension unbounded; there is no field
 * an estimate could travel in.
 */
export interface TurnModelUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly cost?: RealizedCost | undefined;
}
/**
 * One prompt section's name, so a request records the order it was assembled in as
 * nameable parts rather than as one opaque blob.
 */
export declare class TurnPromptSectionName extends TextId {
    constructor(value: string);
}
/**
 * How much of a value the model was NOT shown, as metadata about the bytes it WAS shown
 * (SPEC §5.6). `none` withholds nothing, `exact` states a positive withheld amount, and
 * `unknown` is the honest case for a host that bounded a stream it never read to the end.
 * A two-case shape would force that host to report a guess as exact, and `exact` refuses
 * a zero so the absence of an omission stays distinguishable from one that withheld
 * nothing. An omission is always a budget decision about a value recorded whole
 * elsewhere, never a report that its source had less to give (§7.4).
 */
export declare class TurnOmission {
    readonly kind: "none" | "exact" | "unknown";
    readonly withheldBytes: number | undefined;
    static readonly none: TurnOmission;
    static readonly unknown: TurnOmission;
    static exact(withheldBytes: number): TurnOmission;
    private constructor();
    equals(other: TurnOmission): boolean;
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnOmission;
}
/**
 * How much of one carried commit's content the model was not shown (SPEC §5.2). A prompt
 * section may render several commits at once, so the section's own omission states how much
 * that section withheld, and this states which commit the withheld bytes belonged to.
 * Without it a commit a surface lists in its coverage and renders as no bytes at all reads
 * exactly like a commit it rendered whole. A commit no entry names was carried whole, so an
 * entry withholding nothing is refused rather than recorded as `none`.
 */
export declare class TurnCommitOmission {
    readonly commit: RunCommitId;
    readonly omission: TurnOmission;
    constructor(commit: RunCommitId, omission: TurnOmission);
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnCommitOmission;
}
/**
 * The bytes the model observed, held inline or by a `ContentRef` that resolves to exactly
 * them. Never by a digest of them: a digest proves what a value was while only a
 * reference retrieves it (SPEC §1.4), and never as a derivation over some larger value,
 * because ending retention of that value would leave the observed form unrebuildable.
 */
export declare class TurnShownContent {
    #private;
    readonly ref: ContentRef | undefined;
    static inline(bytes: Uint8Array): TurnShownContent;
    static reference(ref: ContentRef): TurnShownContent;
    private constructor();
    /** The inline bytes, copied, or nothing when this content is held by reference. */
    inlineBytes(): Uint8Array | undefined;
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnShownContent;
}
/** One assembled prompt section as the model observed it, in the request's final order. */
export declare class TurnPromptSection {
    readonly name: TurnPromptSectionName;
    readonly shown: TurnShownContent;
    readonly omission: TurnOmission;
    constructor(name: TurnPromptSectionName, shown: TurnShownContent, omission?: TurnOmission);
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnPromptSection;
}
/**
 * An inbox Event the call admitted. The request names the Event's content directly, so a
 * reconstruction depends on the undeletable RunCommit that carries it rather than on the
 * Event record, which SPEC §6.1 declares immutable and never undeletable. Events the cut
 * covered but the call did not admit are absent, and so stay releasable.
 */
export declare class TurnAdmittedEvent {
    readonly entry: TurnInboxEntryId;
    readonly sequence: number;
    readonly event: string;
    readonly content: ContentRef;
    constructor(entry: TurnInboxEntryId, sequence: number, event: string, content: ContentRef);
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnAdmittedEvent;
}
/**
 * One observation a `turn.step` interceptor left on a step, naming its author (SPEC §4.4).
 * The author is part of the annotation rather than beside it because the host admits an
 * appended annotation only when it names the interceptor that appended it: a supervisor
 * reading a trajectory must be able to tell whose judgement it is reading, and an
 * annotation an interceptor could sign with a neighbour's id would say the opposite.
 */
export declare class TurnStepAnnotation {
    readonly interceptor: InterceptorId;
    readonly note: string;
    constructor(interceptor: InterceptorId, note: string);
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnStepAnnotation;
}
/**
 * The value in flight at `turn.step`: which iteration of the Turn's loop is opening, the
 * branch head and inbox cut it opened on, and the annotations earlier firings of this Turn
 * left. SPEC §5.3 defines a Turn step as the interval between two firings of this cut
 * point, so the ordinal counts firings and nothing else.
 *
 * The head and the cut are host facts the interceptor may read and not change; only the
 * annotations are its to extend. This is not a durable record: the annotations are Turn
 * state, they do not outlive the Turn that collected them, and no later Turn reads them.
 */
export declare class TurnStepContext {
    readonly ordinal: number;
    readonly head: RunCommitId;
    readonly inboxCut: number;
    readonly annotations: readonly TurnStepAnnotation[];
    constructor(ordinal: number, head: RunCommitId, inboxCut: number, annotations?: readonly TurnStepAnnotation[]);
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnStepContext;
}
export interface TurnModelInputInit {
    readonly sections: readonly TurnPromptSection[];
    readonly catalog: readonly TurnBoundOperation[];
    readonly admitted: readonly TurnAdmittedEvent[];
    readonly admissionCut: number;
    readonly covers: readonly RunCommitId[];
    /**
     * The omissions this surface attributes to the commits it carries. Absent and empty are
     * one case. A surface that carries more than one commit and withholds content owes a
     * complete attribution here; every other surface may leave it absent. The record orders
     * the entries by commit id, so a caller states them in any order.
     */
    readonly withheld?: readonly TurnCommitOmission[];
}
/**
 * The complete model input one call issued, as the model observed it: the assembled
 * sections in their final order, the operation catalog as offered, and the inbox
 * admission cut. It is the content of a `modelInput` RunCommit, whose parent is the exact
 * commit the call read, so the base of any derivation over history is fixed by ancestry
 * rather than by when a reconstruction happens to run.
 *
 * `covers` names the transcript commits the assembled sections carry, in the order they
 * carry them. It lifts that fact out of the section bytes for the same reason SPEC §5.2
 * puts a message's `requests` in the graph rather than in its content: prose cannot be
 * asked which commits it renders, so a claim inside it is unreadable by any check.
 *
 * `withheld` attributes each omission to the commit whose content it withheld, which is the
 * fact the two other fields cannot state between them: `covers` is per record and a
 * section's omission is per section, so a commit fully abridged inside a multi-commit
 * section is otherwise indistinguishable from one carried whole. A surface that carries more
 * than one commit and withholds content attributes all of it; every other surface may
 * attribute nothing. The field is additive and stays absent while it says nothing, because a
 * `modelInput` commit derives its identity from these bytes and a key on every record would
 * fork every identity already recorded.
 */
export declare class TurnModelInput extends CodecRecord {
    static get codec(): RecordCodec<TurnModelInput>;
    readonly sections: readonly TurnPromptSection[];
    readonly catalog: readonly TurnBoundOperation[];
    readonly admitted: readonly TurnAdmittedEvent[];
    readonly admissionCut: number;
    readonly covers: readonly RunCommitId[];
    readonly withheld: readonly TurnCommitOmission[];
    constructor(init: TurnModelInputInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): TurnModelInput;
}
export declare const TurnModelInputCodec: RecordCodec<TurnModelInput>;
/** One section's observed bytes, with the omission fact that accompanies them. */
export interface TurnShownSection {
    readonly name: TurnPromptSectionName;
    readonly bytes: Uint8Array;
    readonly omission: TurnOmission;
}
/** One admitted Event's observed payload, resolved from the content the request names. */
export interface TurnAdmittedContent {
    readonly entry: TurnInboxEntryId;
    readonly sequence: number;
    readonly event: string;
    readonly content: ContentRef;
    readonly bytes: Uint8Array;
}
/**
 * The complete request as the model observed it, reconstructed from committed records
 * alone. A model call issues this value rather than a separately assembled one, so the
 * request and its record cannot drift.
 */
export interface TurnModelRequest {
    readonly input: RunCommitId;
    readonly baseCommit: RunCommitId;
    readonly sections: readonly TurnShownSection[];
    readonly catalog: readonly TurnBoundOperation[];
    readonly admitted: readonly TurnAdmittedContent[];
    readonly admissionCut: number;
    readonly covers: readonly RunCommitId[];
}
export interface TurnModelCall extends TurnModelRequest {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly signal: AbortSignal;
}
export interface TurnModelResult {
    readonly output: ContentRef;
    readonly usage: TurnModelUsage;
}
export declare abstract class TurnModelPort {
    abstract call(request: TurnModelCall): Promise<TurnModelResult>;
}
/** The canonical bytes of a request, so a replay compares byte for byte against what was sent. */
export declare function turnModelRequestBytes(request: TurnModelRequest): Uint8Array;
export interface TurnModelInputRecords<Transaction> {
    readonly repository: RunRepository<Transaction>;
    readonly content: ContentStore;
}
/**
 * The records-only reconstruction SPEC §5.6 requires. It reads a Turn's committed records
 * alone — a `modelInput` RunCommit, the content that commit names, and nothing from
 * executor memory — and yields the exact request the model received, which is why it
 * survives a restart that discards the executor process. Content a request names that is
 * no longer retained fails typed and names what is missing; it never yields a shorter
 * prefix, a partial request, or a best-effort approximation.
 */
export declare class TurnModelInputReplay<Transaction> {
    private readonly records;
    constructor(records: TurnModelInputRecords<Transaction>);
    reconstruct(input: RunCommitId): Promise<TurnModelRequest>;
    private shown;
    /**
     * The transcript commits a surface assembled at `base` must account for, in the order it
     * must carry them. A host reads this to know what it owes the record; the check below
     * reads the same derivation, so what a host is told and what it is held to cannot differ.
     */
    accountable(base: RunCommitId): readonly RunCommitId[];
    /**
     * Refuses a surface whose coverage is not exactly the transcript it was assembled over.
     * The comparison is a sequence equality against the effective transcript at `base`
     * restricted to the commits a surface can carry, so the only conforming way to put less
     * history in front of the model is a `rewrite` that shadows it — a reduction the host
     * kept in its own memory leaves commits this derivation still reaches and no section
     * claims. It guards both boundaries: the seam calls it before the record is appended, and
     * every reconstruction calls it again, so a surface written by any other writer is
     * refused on the way out even though nothing refused it on the way in.
     */
    requireAccounted(input: RunCommitId, base: RunCommitId, record: TurnModelInput): void;
    private resolve;
}
export type TurnStreamEvent = {
    readonly kind: "content";
    readonly bytes: Uint8Array;
} | {
    readonly kind: "usage";
    readonly usage: TurnModelUsage;
};
export interface TurnStreamPublication {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly event: TurnStreamEvent;
}
export declare abstract class TurnStreamPort {
    abstract publish(publication: TurnStreamPublication): Promise<void>;
}
export type TurnOutcome = {
    readonly kind: "succeeded";
    readonly result: ContentRef;
    readonly commit: RunCommitId;
} | {
    readonly kind: "failed";
    readonly result: ContentRef;
    readonly commit: RunCommitId;
} | {
    readonly kind: "suspended";
    readonly checkpoint: RunCheckpoint;
    readonly commit: RunCommitId;
} | {
    readonly kind: "cancelled";
    readonly result?: ContentRef;
    readonly commit?: RunCommitId;
};
export declare abstract class TurnContentHandle {
    abstract put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult>;
    abstract get(ref: ContentRef): Promise<Uint8Array>;
    abstract stat(ref: ContentRef): Promise<ContentStat | undefined>;
}
/**
 * What an executor assembles to put in front of the model. It is not yet the request: the
 * host records it, then issues the reconstruction of what it recorded.
 */
export interface TurnModelInputAssembly {
    readonly sections: readonly TurnPromptSection[];
    readonly catalog: readonly TurnBoundOperation[];
    readonly admitted: readonly TurnInboxEntry[];
    /** The transcript commits these sections carry, which `TurnModelInputHandle` supplies. */
    readonly covers: readonly RunCommitId[];
    /**
     * Which of those commits the sections carry in abridged form, and how much of each one
     * they withhold. A host states this where it makes the abridgement, because nothing
     * downstream can tell which commit's bytes a shortened section dropped. A surface that
     * carries more than one commit and withholds content is refused without it, and the
     * record orders the entries, so the host states them in any order.
     */
    readonly withheld?: readonly TurnCommitOmission[];
}
/** One model exchange: the durable record its request was issued from, and the response. */
export interface TurnModelExchange {
    readonly input: RunCommitId;
    readonly output: ContentRef;
    readonly usage: TurnModelUsage;
}
export declare abstract class TurnModelHandle {
    abstract call(assembly: TurnModelInputAssembly): Promise<TurnModelExchange>;
}
export declare abstract class TurnModelInputHandle {
    abstract reconstruct(input: RunCommitId): Promise<TurnModelRequest>;
    /**
     * The transcript commits the next call's surface must account for, at the branch head
     * this Turn stands on now. A host that means to put less history in front of the model
     * appends a `rewrite` first and reads this again; there is no other conforming reduction.
     */
    abstract accountable(): Promise<readonly RunCommitId[]>;
}
export declare abstract class TurnStreamHandle {
    abstract publish(event: TurnStreamEvent): Promise<void>;
}
export declare abstract class TurnCommitHandle {
    abstract append(commit: RunCommit): Promise<RunCommitId>;
}
export declare abstract class TurnCheckpointHandle {
    abstract current(): Promise<RunCheckpoint | undefined>;
    abstract persist(checkpoint: RunCheckpoint, commit: RunCommit): Promise<TurnOutcome>;
}
export declare abstract class TurnInvocationHandle {
    abstract invoke(operation: TurnBoundOperation, requestKey: OperationRequestKey, input: FacetData): Promise<TurnInvocationResult>;
}
export declare abstract class TurnInboxHandle {
    abstract read(afterSequence: number): Promise<readonly TurnInboxEntry[]>;
}
/**
 * What opening a Turn step produced. A `turn.step` gate can only *request* a stop (SPEC
 * §4.4): it holds no lease and is no CommitWriter (§5.2), so it cannot author the Turn's
 * status. The request is returned rather than thrown because the Turn still owes its own
 * terminal transition, and the host enforces the request instead of hoping for it — a
 * stopped Turn issues no further model call and opens no further step.
 */
export type TurnStepDecision = {
    readonly kind: "proceed";
    readonly step: TurnStepContext;
} | {
    readonly kind: "stopped";
    readonly step: TurnStepContext;
    readonly stop: TurnStopRequest;
};
export declare abstract class TurnStepHandle {
    /**
     * Opens the next Turn step, firing `turn.step`. SPEC §5.3 defines a Turn step as the
     * interval between two successive firings, so what one iteration comprises stays the
     * executor's to decide while the cut point stays the host's to run.
     */
    abstract open(): Promise<TurnStepDecision>;
}
export declare abstract class TurnOutcomeHandle {
    abstract succeed(commit: RunCommit): Promise<TurnOutcome>;
    abstract fail(commit: RunCommit): Promise<TurnOutcome>;
    abstract cancel(commit: RunCommit, cancellation: TurnInboxEntry): Promise<TurnOutcome>;
    abstract cancelled(): Promise<TurnOutcome>;
}
export interface TurnContext extends TurnExecutionScope {
    readonly operations: readonly TurnBoundOperation[];
    readonly prompt: ContentRef;
    readonly content: TurnContentHandle;
    readonly inbox: TurnInboxHandle;
    readonly commit: TurnCommitHandle;
    readonly checkpoint: TurnCheckpointHandle;
    readonly invocation: TurnInvocationHandle;
    readonly model: TurnModelHandle;
    readonly modelInput: TurnModelInputHandle;
    readonly step: TurnStepHandle;
    readonly stream: TurnStreamHandle;
    readonly outcome: TurnOutcomeHandle;
    readonly cancellation: AbortSignal;
}
export declare abstract class TurnExecutor {
    abstract execute(turn: TurnContext): Promise<TurnOutcome>;
}
export interface TurnExecutorHostInit<Transaction> {
    readonly runtime: RunRuntime<Transaction>;
    readonly executor: TurnExecutor;
    readonly content: ContentStore;
    readonly operations: TurnOperationSource;
    readonly prompt: TurnPromptAssembler;
    readonly invocations: TurnInvocationPort;
    readonly model: TurnModelPort;
    readonly stream: TurnStreamPort;
    readonly cutPoints: TurnCutPointPort;
    readonly now: () => Date;
}
export declare class TurnExecutorHost<Transaction> {
    private readonly init;
    constructor(init: TurnExecutorHostInit<Transaction>);
    execute(token: LeaseToken): Promise<TurnOutcome>;
}
