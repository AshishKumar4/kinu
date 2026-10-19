/** One delegated turn in the agent's isolate: its model loop here, every tool call back in the workspace. */
import { jsonSchema, tool, type ModelMessage, type ToolSet, type UIMessageChunk } from 'ai';
import {
  actorAffinity, HeadCapture, ownerLaneTools, toolsInWorkMode, withEffectReceipt, decodeJsonValue, decodeModelMessageValues, encodeModelMessageValues, replayPolicyFor, REAL_CLOCK, driveDeliveredRun, permitInPlan, imageModelOutput,
  type AuthRequest, type AuthResolution, type HandedOffTurn, type SettledRun, type RelayedProvider, type EnqueueTurnResult, type HeadInferenceDeps, type ProgrammaticTurn, type JsonObject, type JsonValue, type Executor, type Memory, type MissionBudgetPort, type HeadStep, type HeadStreamKind, type AgentSignal, type SendOutcome,
  turnSourcesFromBundle, captureOperationProfile, currentOperationProfile, recordModelOperations, PROVIDER_WAIT_PART, type ModelCallReport, type ModelOperationSink, type ProviderWaitInfo,
  type AdvisorRecoverySnapshot, type AgentFigures, type AgentReport, type HostedActor, type SerializedMessage, type SessionEvent, type TurnEndEvent,
  type SubordinateReportLedger, type SubordinateReportStatus, type TaskTurnEnding, type WorkMode, type ResolvedTurnProfile,
  type RemoteReceipt, type ReplyToCommentToolDeps, type StoredRow, type SubmitPlanToolDeps, type TurnCraftLedger,
} from '@kinu.run/core';

import { attempt, diagnostics, hold, logged, settle, settleLoggedSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import { routedModelReads, type AgentProviderDeps, type AgentProviderRegistry, type UserCredentialClient, type UserCredentialSource } from '../providers/agent-registry';
import { compactionDiagnostics, hostedActorCompaction } from '@kinu.run/compaction';
import type { AgentDatabase } from './agent-database';
import type { StepPacer } from './step-pacer';
import type { ChatTurnRequest } from '../agent-turns';
import type { AgentHeadDelta, AgentReview, AgentTurnActivity, ChatWindow, AgentTurnTask, AgentToolAnswer, AgentToolCall, AgentTrace, CacheWarmArm, OpenWork, PreparedAgentTurn, RunEndOutcome, TurnCapability } from '@kinu.run/core';

/** The answer's metadata, unless the workspace reads the turn's narration before it can say it. One shape, not a union:
 *  a stub's promise of a union is a union of promises. */
export interface AnswerMetadataReply {
  readonly owesNarration: boolean;
  readonly metadata: JsonObject | null;
}

/** Asks without the narration first: a turn that changed no slate it did not show never reads it. */
export async function answerMetadataOf(
  workspace: Pick<AgentWorkspace, 'answerMetadata'>, close: TurnBound, narration: () => Promise<readonly string[]>,
): Promise<JsonObject | null> {
  const first = await workspace.answerMetadata(close, null);

  return first.owesNarration ? (await workspace.answerMetadata(close, await narration())).metadata : first.metadata;
}


/** What a call that runs more of a turn names (design v2 §3): its turn, its run and its capability's epoch, which the
 *  workspace's fence must still hold; a run the workspace started has none, and only its own cut ends it. */
export type TurnBound = Pick<AgentToolCall, 'turnId' | 'runId' | 'epoch'>;

/** A bound that names a capability: what opens or prepares an execution, never a measure's. */
export type TurnCapabilityOf = TurnBound & { readonly epoch: number };

export interface AgentWorkspace {
  session(): NimbusSessionSurface;
  stateSession(): NimbusSessionSurface;
  memory(): Memory;
  program(bound: TurnBound, ...args: Parameters<Executor['execute']>): ReturnType<Executor['execute']>;
  /** A close (design v2 §3) names the execution it closes, `close`, which the workspace judges against the openings it
   *  admitted: its own close runs after a Stop or a newer opening; one naming another execution runs nothing. */
  traceTurn(close: TurnBound, event: AgentTrace): Promise<void>;
  traceStream(close: TurnBound, lines: ReadableStream<Uint8Array>): Promise<void>;
  /** In the session codec's durable form: a ModelMessage's type is too deep for an RPC signature. */
  resume(bound: TurnBound): Promise<readonly JsonValue[] | null>;
  guard(bound: TurnBound, ...args: Parameters<MissionBudgetPort['guard']>): ReturnType<MissionBudgetPort['guard']>;
  debit(close: TurnBound, ...args: Parameters<MissionBudgetPort['debit']>): Promise<void>;
  /** A delivered run's preparation, under its first round's capability: it opens the workspace's fence for the run. */
  prepareTurn(bound: TurnCapabilityOf): Promise<PreparedAgentTurn>;
  /** A null id reads one between turns. */
  prepareChat(request: ChatTurnRequest): Promise<PreparedAgentTurn>;
  /** The program the agent's isolate is built on, as a turn would read it, with its seat (and so the program) seeded.
   *  Opens no turn and holds none: an isolate adopted between turns asks it before its chat exists. */
  scaffold(): Promise<StoredRow>;
  chatEvent(event: SessionEvent): Promise<void>;
  /** `ended` names the execution it closes. `activity`: the lines its turn logged that no tool call took. `window`: the
   *  transcript's newest messages as it ended, the frame its room is sent. */
  turnEnded(ended: TurnEndEvent, figures: AgentFigures, activity: readonly AgentTurnActivity[], window: ChatWindow): Promise<void>;
  /** A committed answer was stamped after its end (its slates' previews): `window` is the transcript's newest messages
   *  now, which its room is shown again unless a turn is live, whose own end carries it. */
  answerAmended(window: ChatWindow): Promise<void>;
  /** The report a hire's settled turn owes its hirer, decided where the hirer's roster is and relayed to it, once its
   *  answer committed: `turn`, what it told so far; `relay`, its dedupe key and mode. Answers the relay's disposition, or
   *  `none` where it owed none. */
  turnReport(
    /** `taskId`: the assignment this turn answers, if one opened it. */
    turn: { readonly reports: SubordinateReportLedger; readonly ownerDriven: boolean; readonly taskId: string | null },
    ended: { readonly ending: TaskTurnEnding; readonly assistantText: string; readonly narration: readonly string[] },
    relay: { readonly sequenceId: string; readonly mode: WorkMode },
  ): Promise<string>;
  parentReport(report: {
    readonly text: string; readonly status: SubordinateReportStatus; readonly mode: WorkMode; readonly sequenceId: string; readonly quiet?: true;
  }): Promise<string>;
  /** With no `title`, lands the stand-in and answers the mission to name, or null; with one, lands the agent's own. */
  autoTitle(subject: string, title: string | null): Promise<string | null>;
  /** The workspace's own agent hands its settled turn to the workspace, which owes that turn's lanes. Repeatable: the
   *  workspace keys what it owes on the turn. */
  turnSettled(settled: HandedOffTurn): Promise<void>;
  /** Any other agent's run settled: the workspace drops the receipts its tools kept under it. Repeatable. */
  runSettled(run: SettledRun): Promise<void>;
  hireAdvisor(advisor: AdvisorRecoverySnapshot): Promise<void>;
  /** `report`: its standing and its delivered runs' ends not yet told, each told again until a report reached. */
  owes(seq: number, next: number | null, holds: boolean, report: AgentReport): Promise<void>;
  birthContext(drainTurnId: string): Promise<SerializedMessage[]>;
  steerSkills(text: string, alreadyActive: readonly string[]): Promise<string | null>;
  /** A person wrote while the agent's step runs `executing` tool calls: each, held by the workspace's job runner, moves to
   *  the background where that frees the step. */
  releaseForeground(executing: number): Promise<boolean>;
  /** Its open tasks and running jobs, where its tools wrote them. */
  openWork(): Promise<OpenWork>;
  /** The workspace's lane that keeps its prompt cache warm (`CacheWarming`): a chat turn's preparation notes its request
   *  there (`TurnOpeningAsk`), and its end arms the warm it earned. */
  armCacheWarm(input: CacheWarmArm): Promise<number | null>;
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  executeTool(call: AgentToolCall): Promise<AgentToolAnswer>;
  /** The workspace's receipts for calls of an execution whose rows here only point there; a call it holds none for is
   *  absent. Read only, so a closed or stopped turn's repair still asks. */
  receipts(turnId: string, runId: string, callIds: readonly string[]): Promise<ReadonlyMap<string, RemoteReceipt>>;
  observe(lines: ReadableStream<Uint8Array>): Promise<void>;
  /**
   * Calls the agent's `step` for the turn's waiting step, and answers once that step has ended (`StepPacer`). The first
   * step carries the profile the agent assembled the turn on (D5): the workspace binds its tools and live block to it,
   * and the grant carries that block back. Null after the first.
   */
  paceStep(bound: TurnBound, profile: ResolvedTurnProfile | null): Promise<void>;
  /** The answer's metadata. The turn's narration names the slates its words promoted, read only when the turn changed
   *  a slate it did not show: asked without it then, the workspace takes nothing and answers `owesNarration`. */
  answerMetadata(close: TurnBound, narration: readonly string[] | null): Promise<AnswerMetadataReply>;
  getAuth(key: string, opts?: AuthRequest): Promise<AuthResolution | null>;
  listCredentials(): ReturnType<UserCredentialClient['listCredentials']>;
  relayDevice(provider: RelayedProvider): ReturnType<UserCredentialClient['relayDevice']>;
  relayModelCall(deviceId: string, callId: string, request: Request): Promise<Response>;
  cancelModelRelay(callId: string): Promise<void>;
  sayToParent(signal: AgentSignal): Promise<SendOutcome>;
  /** What the agent logged that no tool call or task's end carried, for the workspace's activity log. */
  logActivity(lines: readonly AgentTurnActivity[]): Promise<void>;
  /** The agent's non-turn model calls (its compaction's folds), filed with the workspace's spend. */
  reportModelCall(report: ModelCallReport): Promise<void>;
}

class StepWords implements UnderlyingDefaultSource<Uint8Array> {
  private words: ReadableStreamDefaultController<Uint8Array> | null = null;

  private open = true;

  readonly stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>(this);

  start(words: ReadableStreamDefaultController<Uint8Array>): void {
    this.words = words;
  }

  cancel(): void {
    this.open = false;
  }

  write(bytes: Uint8Array): void {
    if (this.open) this.words?.enqueue(bytes);
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    this.words?.close();
  }
}

/** A turn's live words crossing to its workspace's room, which tabs read. A relay its RPC session lost leaves the tabs the
 *  answer at the turn's end, so its failure is the relay's, never the turn's: the room's side reads it so too
 *  (`degradeRelay`). */
function liveRelay(turnId: string, relay: () => Promise<void>): Effect.Effect<void> {
  return attempt({ doing: "relaying an agent's live output to its workspace", otherwise: 'io' }, relay).pipe(Effect.catch((failure) => Effect.sync(() => {
    diagnostics.failure('agent.live_output_failed', failure, { turn: turnId });
  })));
}

/** A step's words on one stream, then its record (AGENTS.md Waste). */
class HeadTrace {
  private live: { readonly words: StepWords; readonly sent: Promise<void> } | null = null;

  private readonly encoder = new TextEncoder();

  constructor(private readonly workspace: AgentWorkspace, private readonly close: TurnBound) {}

  delta(kind: HeadStreamKind, delta: string): void {
    const line: AgentHeadDelta = { kind, delta };

    (this.live ?? this.openStep()).words.write(this.encoder.encode(`${JSON.stringify(line)}\n`));
  }

  async step(sequence: number, step: HeadStep): Promise<void> {
    await this.flush();
    await this.workspace.traceTurn(this.close, { kind: 'step', sequence, step });
  }

  async flush(): Promise<void> {
    const live = this.live;

    if (live === null) return;
    this.live = null;
    live.words.end();
    await live.sent;
  }

  relay(words: StepWords): Promise<void> {
    return settle(liveRelay(this.close.turnId, () => this.workspace.traceStream(this.close, words.stream)));
  }

  private openStep(): { readonly words: StepWords; readonly sent: Promise<void> } {
    const words = new StepWords();

    this.live = { words, sent: this.relay(words) };

    return this.live;
  }
}

const AGENT_CALLER = { workspaceToken: '' };

/** Bounded well below an access token's life (an hour, for the providers whose login the owner holds), so a credential
 *  held here is refreshed before it could expire; an upstream's refusal refreshes it at once. */
const CREDENTIAL_HELD_MS = 5 * 60_000;

/** The credentials an isolate holds, and the account revision they were read under. */
interface CredentialBroker {
  readonly client: UserCredentialSource;
  readonly held: Map<string, { readonly at: number; readonly auth: AuthResolution | null }>;
  revision: number | null;
}

/** Each workspace client's broker: the isolate's turns share the credentials one of them read. */
const brokers = new WeakMap<AgentWorkspace, CredentialBroker>();

/**
 * The isolate's credentials, held under their refresh rules (design v2 §8): a step asks its workspace for one only once
 * the account's credentials moved (the revision its turn opened under), it is older than {@link CREDENTIAL_HELD_MS}, or an
 * upstream refused the one held, whichever turn of it asks.
 */
function brokeredCredentials(workspace: AgentWorkspace, revision: number | null): UserCredentialSource {
  const broker = brokers.get(workspace) ?? heldCredentials(workspace);

  // A preparation that opened no turn read no revision: what is held stands.
  if (revision !== null && broker.revision !== revision) {
    broker.held.clear();
    broker.revision = revision;
  }

  brokers.set(workspace, broker);

  return broker.client;
}

function heldCredentials(workspace: AgentWorkspace): CredentialBroker {
  const held = new Map<string, { readonly at: number; readonly auth: AuthResolution | null }>();

  const client: UserCredentialSource = {
    caller: async () => AGENT_CALLER,
    getAuth: async (key, opts) => {
      const known = held.get(key);

      if (opts?.rejected === undefined && known !== undefined && Date.now() - known.at < CREDENTIAL_HELD_MS) return known.auth;
      const auth = await workspace.getAuth(key, opts);

      held.set(key, { at: Date.now(), auth });

      return auth;
    },
    listCredentials: () => workspace.listCredentials(),
    hub: () => ({
      relayDevice: (_caller, provider) => workspace.relayDevice(provider),
      relayModelCall: (_caller, deviceId, callId, request) => workspace.relayModelCall(deviceId, callId, request),
      cancelModelRelay: (_caller, callId) => workspace.cancelModelRelay(callId),
    }),
  };

  return { client, held, revision: null };
}

function workspaceTools(
  workspace: AgentWorkspace,
  prepared: PreparedAgentTurn,
  turn: FacetToolTurn,
  durable: (callId: string, signal?: AbortSignal) => Promise<void>,
): ToolSet {
  return Object.fromEntries(prepared.tools.map((descriptor) => {
    const entry = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputSchema),
      execute: async (input, { toolCallId, messages, abortSignal }) => {
        // In this store's history before it crosses, so a reset after its effect committed there finds it to ask after;
        // a program's own call streams no part.
        if (replayPolicyFor(descriptor.name) !== 'safe' && messages.length > 0) await durable(toolCallId, abortSignal);

        const answer = await workspace.executeTool({
          activity: turn.database.takeActivity(), turnId: turn.id, runId: turn.runId, epoch: turn.epoch, mode: turn.mode, parentDriven: turn.parentDriven, ...(turn.driving !== undefined && { driving: turn.driving }),
          callId: toolCallId, name: descriptor.name, input: decodeJsonValue({ value: input }),
        });

        turn.live.dynamic = answer.dynamic;
        turn.live.openWork = answer.openWork;
        turn.database.recordReports(turn.id, answer.reports);
        const { captured, crafted } = answer;

        // Scored in the workspace, where its crafted tools ran: the turn's record here carries it to its run and review.
        if (crafted !== null) turn.craft?.note(toolCallId, crafted);

        if (turn.capture !== undefined && captured !== undefined) {
          turn.capture.evidence.push(...captured.evidence);
          turn.capture.decisions.push(...captured.decisions);
          turn.capture.artifacts.push(...captured.artifacts);
          turn.capture.toolCalls.push(...captured.toolCalls);
          turn.capture.childHeadIds.push(...captured.childHeadIds);
        }

        return answer.output;
      },
      // As the workspace's own tool renders it: an image reaches the model, and the transcript, as an image.
      toModelOutput: imageModelOutput,
    });

    return [descriptor.name, descriptor.planAllowed ? permitInPlan(entry) : entry];
  }));
}

export interface LiveTurn {
  dynamic: PreparedAgentTurn['dynamic'];
  /** A chat turn's open work, as its preparation and then each of its tools answered: its task reminder reads it. */
  openWork: OpenWork | null;
}

/** Filed in the order it was spent. */
export class FacetSpend {
  private filed: Promise<unknown> = Promise.resolve();

  /** `kept`: a delivered run's charges, which ride its end ({@link takeCharges}); a chat turn's are relayed as made. */
  constructor(private readonly workspace: AgentWorkspace, private readonly kept: ModelCallReport[] | null = null) {}

  readonly report = (report: ModelCallReport): void => {
    if (this.kept === null) this.file(() => this.workspace.reportModelCall(report));
    else this.kept.push(report);
  };

  /** The charges kept so far, for the end that carries them. */
  takeCharges(): readonly ModelCallReport[] {
    return this.kept?.splice(0) ?? [];
  }

  async settled(): Promise<void> {
    await this.filed;
  }

  private file(work: () => Promise<void>): void {
    this.filed = this.filed.then(() => hold(logged('agent.spend_relay_failed', { doing: "filing an agent's spend with its workspace", otherwise: 'unavailable' }, work)));
  }
}

/** Each of the agent's model calls' start and end, kept in its own ledger beside the call's attempts, under the run whose
 *  operation made it, else `runId`: as the CLI keeps them. Relayed to the workspace, each crossed twice a call, and its
 *  workspace's write of the start held the step's grant there (#103). */
export function modelOperations(actor: HostedActor, runId: string): ModelOperationSink {
  return recordModelOperations(actor.stores.eventRecorder, () => currentOperationProfile(actor.handle)?.runId ?? runId);
}

/** The registry an agent's isolate resolves its models through, over its own providers (`AgentFacet.models`). */
export type FacetModels = (deps: Omit<AgentProviderDeps, 'env'>) => AgentProviderRegistry;

/** A turn's provider waits, told on the answer stream its words already cross to the room (AGENTS.md Waste), so a wait
 *  costs no call of its own. One while no answer streams (its compaction's, its title's) is the ledger's alone. */
class TurnWaits {
  private told: ((chunk: UIMessageChunk) => void) | null = null;

  constructor(private readonly actor: HostedActor, private readonly runId: string) {}

  readonly wait = (info: ProviderWaitInfo): void => {
    settleLoggedSync('event.provider_wait_emit_failed', { doing: 'recording a provider_wait run event', otherwise: 'io' }, () => {
      this.actor.stores.eventRecorder.emit(this.runId, { type: 'provider_wait', ...info });
    }, { provider: info.provider });
    this.told?.({ type: PROVIDER_WAIT_PART, data: info, transient: true });
  };

  /** The answer's chunks as the lines its workspace relays, one a line, with the provider's waits told among them. */
  lines(chunks: ReadableStream<UIMessageChunk>): ReadableStream<Uint8Array> {
    const answer = chunks.getReader();
    const encoder = new TextEncoder();
    const line = (chunk: UIMessageChunk): Uint8Array => encoder.encode(`${JSON.stringify(chunk)}\n`);

    return new ReadableStream<Uint8Array>({
      start: (controller) => { this.told = (chunk) => { controller.enqueue(line(chunk)); }; },
      pull: async (controller) => {
        const next = await answer.read();

        if (!next.done) {
          controller.enqueue(line(next.value));

          return;
        }

        this.told = null;
        controller.close();
      },
      cancel: async (reason) => {
        this.told = null;
        await answer.cancel(reason);
      },
    });
  }
}

/** A turn in this isolate, assembled as every actor's is: from what its workspace read of it (core turnSourcesFromBundle)
 *  and what this isolate holds, its own models and compaction among them. */
export function facetTurnSources(turn: {
  readonly actor: HostedActor;
  readonly workspace: AgentWorkspace;
  readonly models: FacetModels;
  readonly prepared: PreparedAgentTurn;
  readonly spend: FacetSpend;
  readonly live: LiveTurn;
  readonly runId: string;
  readonly turnId: string;
  readonly epoch: number | null;
  readonly pacer: StepPacer;
  /** The run of this actor's log its provider's words are recorded in (`provider_wait`, `model_attempt`): its own, or,
   *  for a call outside any run (the title), the workspace's, which no run listing shows (WORKSPACE_RUN_ID). */
  readonly recordsIn: string;
}) {
  const { actor, prepared, spend } = turn;
  const operations = modelOperations(actor, turn.recordsIn);
  const bound: TurnBound = { turnId: turn.turnId, runId: turn.runId, epoch: turn.epoch };
  // The profile the turn assembled on, until its first step's pace carries it to the workspace (D5).
  let unbound: ResolvedTurnProfile | null = null;
  const waits = new TurnWaits(actor, turn.recordsIn);

  const registry = turn.models({
    userDO: brokeredCredentials(turn.workspace, prepared.credentialsRevision),
    accountFor: (provider) => actor.stores.config.getProviderAccounts()[provider] ?? prepared.accounts[provider]
      ?? prepared.sources.profileInputs.envelope.catalog.accounts?.[provider],
    appTitle: 'Kinu',
    onProviderWait: waits.wait,
    onModelAttempt: (info) => {
      settleLoggedSync('event.model_attempt_emit_failed', { doing: 'recording a model_attempt run event', otherwise: 'io' }, () => {
        actor.stores.eventRecorder.emit(turn.recordsIn, { type: 'model_attempt', ...info });
      }, { provider: info.provider });
    },
  });

  // Its calls are routed under its own conversation, as a CLI hire's are, in its workspace's cache.
  const affinity = actorAffinity(actor.record);

  const compaction = hostedActorCompaction(actor, {
    logger: compactionDiagnostics,
    models: { normalize: (spec) => registry.normalizeSpecSync(spec || prepared.sources.model), resolve: (spec) => registry.resolveModel(spec, affinity) },
    report: (_actor, report) => spend.report(report),
    operations,
    turn: { profile: () => actor.session.profile, ledger: actor.session.dynamic },
  });

  const sources = turnSourcesFromBundle(prepared.sources, {
    rt: actor.runtime,
    config: actor.stores.config,
    models: { normalize: (spec) => registry.normalizeSpecSync(spec), resolve: (spec) => registry.resolveModel(spec, affinity), routed: routedModelReads(registry) },
    scaffoldSpend: { source: 'scaffold', report: spend.report, operations },
    operations,
    observeStream: (chunks) => settle(liveRelay(turn.turnId, () => turn.workspace.observe(waits.lines(chunks)))),
    paceStep: async (signal) => {
      const profile = unbound;

      unbound = null;
      const granted = await turn.pacer.pace(turn.workspace, bound, signal, profile);

      // Its first step's grant carries the live block on the profile it bound, before the step reads it.
      if (granted.dynamic !== null) turn.live.dynamic = granted.dynamic;

      return granted.ended;
    },
    attachmentBudget: actor.session.orchestrator.acc.ledgers.context,
    extensions: () => [compaction.extension],
    dynamic: () => () => turn.live.dynamic,
    // Bound and frozen by the driver as it resolved (`ClaimedRound.bind`); the workspace answers tools and the live block
    // on it from its first step.
    settle: async (profile) => { unbound = profile; },
    taskPlan: () => null,
    operation: (profile, inputs) => captureOperationProfile({ actor: actor.handle, profile, inputs, runId: turn.runId, turnId: turn.turnId }),
  });

  return { sources, trigger: compaction.trigger };
}

/** A turn's tool calls carry its execution and its lane, so a workspace that restarted mid-turn rebuilds the same turn. */
interface FacetToolTurn {
  readonly id: string;
  readonly runId: string;
  readonly epoch: number | null;
  readonly mode: WorkMode;
  readonly parentDriven: boolean;
  readonly driving: JsonObject | undefined;
  readonly live: LiveTurn;
  /** A run's, which its inference reads; a chat turn records none. */
  readonly capture?: HeadCapture;
  readonly database: AgentDatabase;
  /** A chat turn's crafted-tool record, which its run and review read; a run keeps none, as its seat's tools observe none. */
  readonly craft?: TurnCraftLedger;
  /** The agent's own plan store, where the owner's lane submits and replies; a run reaches no owner's lane. */
  readonly owner?: { readonly submitPlan: SubmitPlanToolDeps; readonly replyToComment: ReplyToCommentToolDeps };
}

/**
 * A turn's tools here (design v2 §4): each workspace tool commits in the workspace, which keeps its receipt, so a call
 * leaves nothing here; the owner's lane (its plans, its questions) commits in this store, under a receipt here.
 */
export function facetTurnTools(workspace: AgentWorkspace, prepared: PreparedAgentTurn, actor: HostedActor, turn: FacetToolTurn): ToolSet {
  const receipts = {
    actor: actor.handle,
    sql: actor.runtime.storage.sql,
    execution: () => ({ turnId: turn.id, runId: turn.runId }),
    durable: (callId: string, signal?: AbortSignal) => actor.session.durableCall(callId, signal),
  };

  const { ownerLane } = prepared;

  // Asking the owner has no executor: its call parks in this isolate's store, which the repair reads.
  const owned = toolsInWorkMode(turn.mode, ownerLaneTools({
    ...(ownerLane.submitPlan && turn.owner !== undefined && { submitPlan: turn.owner.submitPlan }),
    ...(ownerLane.replyToComment && turn.owner !== undefined && { replyToComment: turn.owner.replyToComment }),
    ...(ownerLane.askOwner && { askOwner: true }),
  }));

  return {
    ...workspaceTools(workspace, prepared, turn, receipts.durable),
    ...withEffectReceipt(owned, { ...receipts, transaction: (body) => actor.runtime.storage.transactionSync(body) }),
  };
}

/** What a delivered run's newest round's preparation set, which the compiler does not follow into: the opening it made at
 *  the workspace, which every call of that round names, the run's closes too, and the trace its steps stream to. */
interface PreparedRun {
  opened: TurnCapabilityOf | null;
  trace: HeadTrace | null;
}

/**
 * A delivered run's own parts (D2): each round's preparation, under that round's claim, by its workspace over this
 * isolate's models and tools, and the projection of its rounds into its end, kept on its held input (`recordEnd`), where a
 * restart tells it and never runs it again. Core drives it (`driveDeliveredRun`), in its chat's turn, which `signal`
 * stops.
 */
export async function deliveredRun(
  { database, workspace, models, pacer }: { readonly database: AgentDatabase; readonly workspace: AgentWorkspace; readonly models: FacetModels; readonly pacer: StepPacer },
  task: AgentTurnTask,
  signal: AbortSignal,
  recordEnd: (outcome: RunEndOutcome) => Promise<() => void>,
): Promise<void> {
  const actor = await database.acquire();
  const { runId } = task;
  const capture = new HeadCapture();
  // Its charges ride its end, kept in the commit that ends it: none is lost to a death after that commit, nor told twice.
  const spend = new FacetSpend(workspace, []);
  const run: PreparedRun = { opened: null, trace: null };
  // Its rounds' reviews ride its end: no advice crosses before the end commits.
  const reviews: AgentReview[] = [];
  let produced: readonly ModelMessage[] | undefined;

  // Each round's: the workspace knows the run by its own turn, and each round reopens it at that round's epoch.
  const prepare = async (capability: TurnCapability) => {
    // Every call of the round carries its capability: the opening its preparation made at the workspace.
    const bound: TurnCapabilityOf = { turnId: task.sequenceId, runId: capability.runId, epoch: capability.epoch };

    // The last round's live words reach the workspace under its own opening, before the next is made. A preparation the
    // workspace failed opened nothing there (`AgentTurns.prepare`): the run's closes name its last opening.
    await run.trace?.flush();
    const prepared = await workspace.prepareTurn(bound);

    run.opened = bound;
    database.prepare(bound, prepared);
    const live: LiveTurn = { dynamic: prepared.dynamic, openWork: null };
    const { sources, trigger } = facetTurnSources({ actor, workspace, models, prepared, spend, live, runId, turnId: task.sequenceId, epoch: bound.epoch, pacer, recordsIn: runId });

    const inference: HeadInferenceDeps = {
      actor,
      runId,
      clock: REAL_CLOCK,
      sources,
      compaction: trigger,
      tools: facetTurnTools(workspace, prepared, actor, { id: task.sequenceId, runId, epoch: bound.epoch, mode: task.mode, parentDriven: false, driving: undefined, live, capture, database }),
      // Its tools are the workspace's, run there, and so is its program.
      stores: null,
      opening: decodeModelMessageValues(prepared.opening),
      capture,
      isAborted: () => signal.aborted,
      signal,
      advise: async (turn, reachable, mode) => { reviews.push({ turn, reachable, mode }); },
    };

    const { brief } = prepared;

    if (brief !== undefined) inference.brief = () => brief;

    run.trace = prepared.trace ? new HeadTrace(workspace, bound) : null;

    if (prepared.reportMessages) inference.reportMessages = (messages) => { produced = messages; };

    if (prepared.resume) {
      inference.resume = async () => {
        const resumed = await workspace.resume(bound);

        return resumed === null ? null : decodeModelMessageValues(resumed);
      };
    }

    if (prepared.missionLabels !== undefined) inference.mission = {
      labels: prepared.missionLabels,
      port: {
        guard: (...args) => workspace.guard(bound, ...args),
        debit: (...args) => workspace.debit(bound, ...args),
      },
    };

    const traced = run.trace;

    if (traced !== null) {
      inference.reportStep = (sequence, step) => traced.step(sequence, step);
      inference.reportDelta = (kind, delta) => { traced.delta(kind, delta); };
    }

    return { input: prepared.input, deps: inference };
  };

  try {
    // The agent a run is delivered to, a node or a head, holds no slates: none is stamped on its answer.
    await driveDeliveredRun(actor, task, {
      prepare,
      // Prepared before the commit, spilled if it outgrows a row; kept by it.
      ended: async (report) => {
        const charges = spend.takeCharges();

        return await recordEnd({
          ended: {
            ...report,
            activity: database.takeActivity(),
            figures: database.figures(),
            errorMessage: report.errorMessage ?? null,
            ...(produced !== undefined && { produced: encodeModelMessageValues(produced) }),
            ...(reviews.length > 0 && { reviews }),
            ...(charges.length > 0 && { charges }),
          },
        });
      },
    });
  } finally {
    // Its steps' grant answers: the run ran its last.
    pacer.release(task.sequenceId);
    // Observability, told after its end committed, so no death in them runs the run again (#75), and before the end is.
    await run.trace?.flush();
    await spend.settled();
  }
}
