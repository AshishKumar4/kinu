import { type VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
/** One agent in its own loader isolate (D9), the workspace agent's included. */
import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { Nimbus, type NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import { Effect } from 'effect';
import { attemptInItsWords, flight, KinuError, renderThrownChain, settle } from '@kinu.run/core/obs';
import {
  encodeModelMessageValues, readAgentArchivePage,
  type InspectedWork,
  type AgentOwnInspection, type AnsweredEvolutionSubagent, type JsonValue, type ArchiveAgentPage, type ArchiveSqlCursor, type ChatHistoryPage,
  type NimbusSandboxFiles, type PositionPageRequest, type ProviderEnv, type SerializedMessage, type SubagentInspectionResult,
  servedContextTree, type ContextEditor, type ContextTreeRemote, type SpendLedger, type StepSpendSource, type TurnRequestIndex, type TurnRequestPage, type ConversationSearchHit, type ConversationScrollResult, type ConversationSummary,
  type SendState, DeliverySchema, type AdmittedDelivery, type Delivery, type DeliveryAnswer, type InputProducer, type OwedDelivery,
} from '@kinu.run/core';
import * as v from 'valibot';
import { StepPacer } from './step-pacer';
import { openAgentDatabase, repairAgentDatabase, type AgentDatabase } from './agent-database';
import { censusOf, type ChatWindow, type MediaRef, type Repair, type RewindTold, type StoreCensus, type StoredImage } from '@kinu.run/core';
import { createAgentProviderRegistry, type AgentProviderDeps, type AgentProviderRegistry } from '../providers/agent-registry';
import { FacetChat } from './agent-chat';
import { workspaceClient, type AgentWorkspaceCalls } from './workspace-rpc';
import type {
  AgentAnswer, AgentAnswerTexts, AgentStanding, AgentSteps, AgentRecovery, AgentSnapshot, ConversationProjection, ConversationTurnPair, EnqueueTurnResult, ProgrammaticTurn, SendLanding, TurnRequestAt,
  DynamicContext, FactsKey, FrozenAuthority, JsonObject, PlanReview, PlanReviewResult, ReviewAnnotation, AskedQuestions,
  Page, PageRequest, RunEvent, RunEventQuery, RunListEntry, RunSummary, StoredRunEvent,
  ForkConversationPlan, ForkConversationSection, ForkRowSection, ForkRows,
} from '@kinu.run/core';
import { encodeRecordedTurns, getRunEvents, getRunEventText, getRunSummaries, listRuns } from '@kinu.run/core';

export interface AgentFacetEnv {
  readonly WORKSPACE: AgentWorkspaceCalls;
  readonly WORKSPACE_NAME: string;
  readonly HOME: string;
  readonly AI?: ProviderEnv['AI'];
  readonly AI_GATEWAY_URL?: string;
  readonly WORKERS_AI_VIA_BINDING?: string;
}

class AgentContextTree extends RpcTarget implements ContextTreeRemote {
  constructor(private readonly served: ContextTreeRemote) { super(); }

  readFile(path: string) { return this.served.readFile(path); }
  readFileAtRevision(path: string, revision: VfsRevision, range?: { readonly offset: number; readonly length: number }) { return this.served.readFileAtRevision(path, revision, range); }
  readRange(path: string, offset: number, length: number) { return this.served.readRange(path, offset, length); }
  readdir(path: string) { return this.served.readdir(path); }
  stat(path: string, options?: { follow?: boolean }) { return this.served.stat(path, options); }
  writeFile(path: string, data: Uint8Array) { return this.served.writeFile(path, data); }
  writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision) { return this.served.writeFileIfRevision(path, data, expected); }
}

export interface AgentFacetCalls {
  /** The deploy's walk of this agent's database (`OrchestratorAgent.opsTables`). */
  opsTables(): Promise<StoreCensus>;
  /** Resolves once its chat holds the delivery in its own store, with the report its admission makes. */
  admit(snapshot: AgentSnapshot, delivery: Delivery): Promise<AdmittedDelivery>;
  landing(snapshot: AgentSnapshot, id: string): Promise<SendLanding>;
  sendState(snapshot: AgentSnapshot, id: string): Promise<SendState>;
  awaitSend(snapshot: AgentSnapshot, id: string): Promise<SendState>;
  /** `cutoff`: the newest workspace delivery the Stop cancelled; none at or below it is taken after. */
  interruptChat(snapshot: AgentSnapshot, cutoff: number | null): Promise<readonly string[]>;
  /** What a reset left owed is taken up; the agent tells its workspace what is left once it rests. */
  wake(snapshot: AgentSnapshot): Promise<void>;
  /** The next request is measured on the new settings, and a refusal only the owner could fix may answer now. */
  modelSettingsChanged(snapshot: AgentSnapshot): Promise<void>;
  /** The chat continues from before `entryId`; refused while a turn runs. */
  /** With `told`, a chat-only rewind that tells the agent what its rewound turns left. */
  revertTo(snapshot: AgentSnapshot, entryId: string, told?: RewindTold): Promise<void>;
  /** The owner's Clear; answers why the emptied request went unmeasured, if it did. */
  clearConversation(snapshot: AgentSnapshot): Promise<string | null>;
  owed(snapshot: AgentSnapshot): Promise<boolean>;
  /** Its own turns and effects still owed, as the workspace's work read reports them. */
  owedWork(snapshot: AgentSnapshot): Promise<readonly InspectedWork[]>;
  /** One of its answers, as its `<slate-ui>` blocks are read from it; null for an id that names no answer of its own. */
  answerTexts(snapshot: AgentSnapshot, messageId: string): Promise<AgentAnswerTexts | null>;
  /** One of its answers whole, for a lane its workspace runs on it; null for an id that names none. */
  answer(snapshot: AgentSnapshot, messageId: string): Promise<AgentAnswer | null>;
  /** Its conversation's newest rows first, for a lane its workspace runs on it. */
  newestFirst(snapshot: AgentSnapshot, limit: number): Promise<readonly ConversationProjection[]>;
  /** A tab shows one of its settled answers whose phases have no line: they are named by its fast tier; false while it
   *  has no committed answer of that id. */
  namePhases(snapshot: AgentSnapshot, messageId: string): Promise<boolean>;
  /** The compaction ladder's forced rebuild, armed for its next turn assembly in the state that assembly reads. */
  armCompaction(snapshot: AgentSnapshot): Promise<void>;
  /** Its conversation as a fork of its workspace reads it: whether a message can be cut at, the cut's plan, a section's
   *  count, and its rows as JSON lines, pulled as the fork's frames are sent. */
  forkHas(snapshot: AgentSnapshot, messageId: string): Promise<boolean>;
  forkPlan(snapshot: AgentSnapshot, untilMessageId: string, artifactDirectory: string): Promise<ForkConversationPlan>;
  forkCount(snapshot: AgentSnapshot, kind: ForkConversationSection, plan: ForkConversationPlan, artifactDirectory: string): Promise<number>;
  forkRows(snapshot: AgentSnapshot, kind: ForkConversationSection, plan: ForkConversationPlan, artifactDirectory: string): Promise<ReadableStream<Uint8Array>>;
  /** A fork of its workspace landing its conversation here, a batch at a time, then pointing the cut at its context;
   *  carried payloads re-root under `artifactDirectory`. */
  forkClear(snapshot: AgentSnapshot, artifactDirectory: string): Promise<void>;
  forkStage<K extends ForkRowSection>(snapshot: AgentSnapshot, artifactDirectory: string, kind: K, rows: readonly ForkRows[K][]): Promise<void>;
  forkPublish(snapshot: AgentSnapshot, artifactDirectory: string, cutMessageId: string): Promise<void>;
  /** Where its chat stands between turns, for its window and its workspace's tile; `contextWindow` is its model's. */
  standing(snapshot: AgentSnapshot, contextWindow: number | null): Promise<AgentStanding>;
  /** Its runs, newest first, plain or folded with each run's provenance and usage, and one run's events; the workspace's
   *  own agent's are its workspace's runs. */
  listRuns(snapshot: AgentSnapshot, request: PageRequest | null): Promise<Page<RunListEntry>>;
  runSummaries(snapshot: AgentSnapshot, request: PageRequest | null): Promise<Page<RunSummary>>;
  runEvents(snapshot: AgentSnapshot, runId: string, query: RunEventQuery | null): Promise<RunEvent[]>;
  runEventText(snapshot: AgentSnapshot, runId: string, query: RunEventQuery | null): Promise<StoredRunEvent[]>;
  /** Its newest model steps, for the activity its workspace's window reads. */
  steps(snapshot: AgentSnapshot, limit: number): Promise<AgentSteps>;
  /** The first `before` finished steps of run `runId`, drawn, for a tab its room replays the run's turn to, as JSON
   *  lines pulled a step at a time: a long turn's steps never cross as one value (`do.facet.rpc_bytes`). A recorded step
   *  never changes, so the run may have closed since. */
  runSteps(snapshot: AgentSnapshot, runId: string, before: number): Promise<ReadableStream<Uint8Array>>;
  /** A turn's request and response by its answer's id, for a rating its workspace records; null for none. */
  turnPair(snapshot: AgentSnapshot, messageId: string): Promise<ConversationTurnPair | null>;
  /** The metadata of its newest message from a person, which its idle work mode reads; null before any. */
  lastUserMetadata(snapshot: AgentSnapshot): Promise<JsonObject | null>;
  /** The answer each drain turn gave, by drain turn id, for the replies its workspace owes. */
  drainAnswers(snapshot: AgentSnapshot, drainTurnIds: readonly string[]): Promise<Readonly<Record<string, string>>>;
  /** A retirement waits on it. */
  idle(): Promise<void>;
  deliverAdvice(snapshot: AgentSnapshot, subagent: AnsweredEvolutionSubagent, turnId: string): Promise<boolean>;
  frozen(snapshot: AgentSnapshot, key: FactsKey): Promise<FrozenAuthority | null>;
  /** Runs the turn's waiting model step under this call, and answers once it has ended (`StepPacer`). `dynamic`: the live
   *  block on the profile the step's pace bound, its turn's first. */
  step(turnId: string, dynamic: DynamicContext | null): Promise<void>;
  /** This chat's newest page, as a tab is sent it on connecting or a turn's end. */
  seed(snapshot: AgentSnapshot): Promise<ChatWindow>;
  /** One image a page of this chat named; each crosses alone, never inside a page. */
  media(snapshot: AgentSnapshot, ref: MediaRef): Promise<StoredImage | null>;
  historyPage(snapshot: AgentSnapshot, page: PositionPageRequest): Promise<ChatHistoryPage>;
  messageCount(snapshot: AgentSnapshot): Promise<number>;
  inspect(snapshot: AgentSnapshot, request: AgentOwnInspection): Promise<SubagentInspectionResult>;
  inheritedContext(snapshot: AgentSnapshot): Promise<SerializedMessage[]>;
  /** In the session codec's durable form, as `AgentWorkspace.resume`. */
  workingContext(snapshot: AgentSnapshot): Promise<readonly JsonValue[]>;
  turnRequests(snapshot: AgentSnapshot, turnId: string): Promise<TurnRequestIndex>;
  turnRequest(snapshot: AgentSnapshot, at: TurnRequestAt): Promise<TurnRequestPage>;
  /** In the session codec's durable form (`encodeRecordedTurns`). */
  recordedTurns(snapshot: AgentSnapshot, limit?: number): Promise<JsonValue[]>;
  spend(snapshot: AgentSnapshot, steps: readonly StepSpendSource[]): Promise<SpendLedger>;
  context(snapshot: AgentSnapshot, editor: ContextEditor): Promise<ContextTreeRemote>;
  searchConversations(snapshot: AgentSnapshot, query: string, limit?: number): Promise<ConversationSearchHit[]>;
  scrollConversation(snapshot: AgentSnapshot, around: string, window?: number, maxChars?: number): Promise<ConversationScrollResult | null>;
  browseConversations(snapshot: AgentSnapshot, limit?: number): Promise<ConversationSummary[]>;
  unseen(snapshot: AgentSnapshot, ids: readonly string[]): Promise<string[]>;
  interrupt(snapshot: AgentSnapshot, turnId: string): Promise<void>;
  recover(snapshot: AgentSnapshot): Promise<AgentRecovery>;
  /** The platform reported its isolate out of memory at `diedAt`. */
  outOfMemory(snapshot: AgentSnapshot, diedAt: number): Promise<void>;
  archivePage(snapshot: AgentSnapshot, cursor: ArchiveSqlCursor | null, maxBytes: number): Promise<ArchiveAgentPage>;
  /** Its plan reviews, in its own store: submitted by its turn's own tools, and reviewed by the owner through its window. */
  activePlanReview(snapshot: AgentSnapshot): Promise<PlanReview | null>;
  /** Newest first, for Work and the review queue; a retained retired agent answers too. */
  planReviews(snapshot: AgentSnapshot): Promise<readonly PlanReview[]>;
  savePlanReviewAnnotations(snapshot: AgentSnapshot, id: string, revision: number, annotations: ReviewAnnotation[]): Promise<PlanReviewResult>;
  dismissPlanReview(snapshot: AgentSnapshot, id: string, revision: number): Promise<PlanReviewResult>;
  /** Its questions to its owner, in its own store: asked on the owner's turns, answered from the workspace's stack. */
  ownerQuestions(snapshot: AgentSnapshot): Promise<readonly AskedQuestions[]>;
  dismissOwnerQuestions(snapshot: AgentSnapshot, id: string): Promise<number>;
}

/** `rows` as JSON lines, each pulled as its reader asks for it: none sits whole in either isolate. */
function jsonLineStream<Row>(rows: AsyncIterable<Row>): ReadableStream<Uint8Array> {
  const pulled = rows[Symbol.asyncIterator]();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const next = await pulled.next();

      if (next.done === true) controller.close();
      else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
    },
    cancel: async () => { await pulled.return?.(); },
  });
}

export class AgentFacet extends DurableObject<AgentFacetEnv> implements AgentFacetCalls {
  private readonly workspaceCalls = workspaceClient(this.env.WORKSPACE);

  private box: NimbusSandboxFiles | undefined;

  private stateBox: NimbusSandboxFiles | undefined;

  private database: AgentDatabase | undefined;

  /** Its chat, prepared once and joined by every caller; a failed preparation is not kept, so the next call prepares again. */
  private readonly chats = flight((snapshot: AgentSnapshot) => Effect.promise(() => this.prepared(snapshot)), { keep: 'success' });

  private held: FacetChat | undefined;

  private readonly pacer = new StepPacer();

  /** The registry this agent's turns resolve their models through, over its own providers. */
  protected models(deps: Omit<AgentProviderDeps, 'env'>): AgentProviderRegistry {
    return createAgentProviderRegistry({ ...deps, env: this.env });
  }

  /** Its workspace's files as the agent; a facet runs no command, so its session is only a file plane. */
  protected workspace(): NimbusSandboxFiles {
    this.box ??= this.sessionFiles(() => this.workspaceCalls.session());

    return this.box;
  }

  private state(): NimbusSandboxFiles {
    this.stateBox ??= this.sessionFiles(() => this.workspaceCalls.stateSession());

    return this.stateBox;
  }

  private sessionFiles(session: () => NimbusSessionSurface): NimbusSandboxFiles {
    return Nimbus.fromSession(session).sandbox(this.env.WORKSPACE_NAME).files;
  }


  /** The deploy's walk, from its workspace (reached only through the workspace's `ctx.facets`, which checked the walk's
   *  capability): this agent's database opened so it repairs itself, its tables and their rows, and what that did. */
  opsTables(): Promise<StoreCensus> {
    const repair = this.repaired();

    return Promise.resolve({ census: censusOf(this.ctx.storage.sql), repair, refused: repair?.refused ?? null });
  }

  /** This activation's repair of its database, run once, at its first open. */
  private repair: { readonly done: Repair | null } | undefined;

  private repaired(): Repair | null {
    this.repair ??= { done: repairAgentDatabase(this.ctx.storage, `agent of ${this.env.WORKSPACE_NAME}`) };

    return this.repair.done;
  }

  private open(snapshot: AgentSnapshot): AgentDatabase {
    this.database ??= openAgentDatabase(this.ctx.storage, this.repaired(), {
      agent: () => this.workspace(), home: this.env.HOME, state: () => this.state(),
      enqueueTurn: (input) => this.enqueue(snapshot, input),
      admitDelivery: async (delivery) => (await this.admit(snapshot, delivery, 'self')).answer,
      // A steer's fate rides its chat's events, in order with the turns it names.
      broadcast: (event) => { this.held?.session.emit({ type: 'broadcast', event }); },
      turnInFlight: () => this.held?.session.turnInFlight() ?? false,
      memory: () => this.workspaceCalls.memory(), program: (...args) => this.workspaceCalls.program(...args),
      sayToParent: (signal) => this.workspaceCalls.sayToParent(signal),
      receipts: (...args) => this.workspaceCalls.receipts(...args),
      logActivity: (lines) => this.workspaceCalls.logActivity(lines),
    });
    this.database.adopt(snapshot);

    return this.database;
  }

  private async prepared(snapshot: AgentSnapshot): Promise<FacetChat> {
    const database = this.open(snapshot);
    // The workspace's program first: the actor is built on it.
    const scaffold = await this.workspaceCalls.scaffold();

    // The rows newest to reach it, not those this call carried: a call adopted while the program was asked for may have
    // brought newer ones (the owner's model pin), and re-adopting older rows would put the old ones back.
    database.adopt({ ...database.current(), scaffold: [scaffold] });
    const actor = await database.acquire();
    const chat = new FacetChat({ actor, database, workspace: this.workspaceCalls, models: (deps) => this.models(deps), storage: this.ctx.storage, pacer: this.pacer });

    chat.session.measureSessionStart({ restored: chat.session.restoreWorkingHistory() });
    this.held = chat;

    return chat;
  }

  /** `use` on its chat, on the snapshot it is called with. */
  private withChat<A>(snapshot: AgentSnapshot, use: (chat: FacetChat) => A | Promise<A>): Effect.Effect<A, KinuError> {
    return Effect.suspend(() => {
      this.open(snapshot);

      return Effect.flatMap(this.chats(snapshot), (chat) => Effect.promise(async () => await use(chat)));
    });
  }


  /** A turn its own isolate queues: answered once its chat has processed it. */
  async enqueue(snapshot: AgentSnapshot, turn: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.enqueueTurn(turn)));
  }

  /**
   * A delivery from the workspace (design v2 §1), or from a producer in this isolate (`self`): in this isolate's store
   * before it is answered, which retires its producer's row; a repeat is answered `duplicate`. The workspace's answer
   * carries the report its admission makes; one of its own has no answer crossing, so that report is told.
   */
  async admit(snapshot: AgentSnapshot, delivery: OwedDelivery, producer: InputProducer = 'workspace'): Promise<AdmittedDelivery> {
    return await settle(Effect.flatMap(this.admission(snapshot, delivery, producer), ({ chat, answer }) => Effect.map(
      Effect.promise(() => (producer === 'self' ? chat.told() : chat.taken())), (owes) => ({ answer, owes }),
    )));
  }

  private admission(snapshot: AgentSnapshot, delivery: OwedDelivery, producer: InputProducer): Effect.Effect<{ readonly chat: FacetChat; readonly answer: DeliveryAnswer }, KinuError> {
    const parsed = v.parse(DeliverySchema, delivery);

    return Effect.flatMap(this.withChat(snapshot, (chat) => chat), (chat) => (chat.session.closed
      // Closing: owed to its next start, so the crossing fails and the workspace's wake crosses it again.
      ? Effect.fail(new KinuError('unavailable', 'The agent is closing; the delivery is owed to its next start.'))
      : attemptInItsWords('io', () => chat.session.admitDelivery(parsed, producer)).pipe(
        // Its own refusal is its answer, not a lost crossing: told with its whole cause chain. Not taken yet is no answer:
        // the crossing fails, and the delivery stays owed to the workspace's wake, as a closing agent's does.
        Effect.catch((refusal) => (refusal.code === 'unavailable' ? Effect.fail(refusal)
          : Effect.succeed<DeliveryAnswer>({ refused: { code: refusal.code, message: renderThrownChain({ cause: refusal }) } }))),
        Effect.map((answer) => ({ chat, answer })),
      )));
  }

  /** Where a person's words landed, once a turn took them: what their client is told. */
  async landing(snapshot: AgentSnapshot, id: string): Promise<SendLanding> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.awaitLanding(id)));
  }

  async sendState(snapshot: AgentSnapshot, id: string): Promise<SendState> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.sendState(id)));
  }

  async awaitSend(snapshot: AgentSnapshot, id: string): Promise<SendState> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.awaitSend(id)));
  }

  async interruptChat(snapshot: AgentSnapshot, cutoff: number | null): Promise<readonly string[]> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.interrupt(cutoff === null ? undefined : { producer: 'workspace', seq: cutoff })));
  }

  /** Its chat wakes: a run a death cut off is restored from its held input and runs again, as any input is (D2). */
  async wake(snapshot: AgentSnapshot): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => chat.wake()));
  }

  async modelSettingsChanged(snapshot: AgentSnapshot): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => chat.modelSettingsChanged()));
  }

  async revertTo(snapshot: AgentSnapshot, entryId: string, told?: RewindTold): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.revertTo(entryId, told)));
  }

  async clearConversation(snapshot: AgentSnapshot): Promise<string | null> {
    return await settle(this.withChat(snapshot, async (chat) => (await chat.clear())?.message ?? null));
  }

  async activePlanReview(snapshot: AgentSnapshot): Promise<PlanReview | null> {
    return this.open(snapshot).activePlan();
  }

  async planReviews(snapshot: AgentSnapshot): Promise<readonly PlanReview[]> {
    return this.open(snapshot).planReviews();
  }

  async savePlanReviewAnnotations(snapshot: AgentSnapshot, id: string, revision: number, annotations: ReviewAnnotation[]): Promise<PlanReviewResult> {
    return await settle(this.withChat(snapshot, (chat) => chat.planned((plans) => plans.saveAnnotations(id, revision, { value: annotations }))));
  }

  async dismissPlanReview(snapshot: AgentSnapshot, id: string, revision: number): Promise<PlanReviewResult> {
    return await settle(this.withChat(snapshot, (chat) => chat.planned((plans) => plans.dismiss(id, revision, (prefix) => { chat.session.stopIfRunning(prefix); }))));
  }

  /** The profile a run froze as it first assembled: a workspace that restarted mid-turn rebuilds its tools on it. */
  async frozen(snapshot: AgentSnapshot, key: FactsKey): Promise<FrozenAuthority | null> {
    return this.open(snapshot).frozen(key);
  }

  async ownerQuestions(snapshot: AgentSnapshot): Promise<readonly AskedQuestions[]> {
    return await settle(this.withChat(snapshot, (chat) => chat.questions.recent()));
  }

  async dismissOwnerQuestions(snapshot: AgentSnapshot, id: string): Promise<number> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.dismissQuestions(id)));
  }

  async owed(snapshot: AgentSnapshot): Promise<boolean> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.turnOwed));
  }

  async answerTexts(snapshot: AgentSnapshot, messageId: string): Promise<AgentAnswerTexts | null> {
    return await this.open(snapshot).answerTexts(messageId);
  }

  async answer(snapshot: AgentSnapshot, messageId: string): Promise<AgentAnswer | null> {
    return await this.open(snapshot).answerOf(messageId);
  }

  async newestFirst(snapshot: AgentSnapshot, limit: number): Promise<readonly ConversationProjection[]> {
    return await this.open(snapshot).newestFirst(limit);
  }

  async namePhases(snapshot: AgentSnapshot, messageId: string): Promise<boolean> {
    return await settle(this.withChat(snapshot, async (chat) => await chat.namePhases(messageId)));
  }

  async armCompaction(snapshot: AgentSnapshot): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => { chat.armCompaction(); }));
  }

  async forkHas(snapshot: AgentSnapshot, messageId: string): Promise<boolean> {
    return await this.open(snapshot).forkSource().has(messageId);
  }

  async forkPlan(snapshot: AgentSnapshot, untilMessageId: string, artifactDirectory: string): Promise<ForkConversationPlan> {
    return await this.open(snapshot).forkSource().plan(untilMessageId, artifactDirectory);
  }

  async forkCount(snapshot: AgentSnapshot, kind: ForkConversationSection, plan: ForkConversationPlan, artifactDirectory: string): Promise<number> {
    return await this.open(snapshot).forkSource().count(kind, plan, artifactDirectory);
  }

  async forkRows(snapshot: AgentSnapshot, kind: ForkConversationSection, plan: ForkConversationPlan, artifactDirectory: string): Promise<ReadableStream<Uint8Array>> {
    // Pulled a row at a time as the fork's frames go out: the section never sits whole in either isolate.
    return jsonLineStream(this.open(snapshot).forkSource().rows(kind, plan, artifactDirectory));
  }

  async forkClear(snapshot: AgentSnapshot, artifactDirectory: string): Promise<void> {
    await this.open(snapshot).forkTarget(artifactDirectory).clear();
  }

  async forkStage<K extends ForkRowSection>(snapshot: AgentSnapshot, artifactDirectory: string, kind: K, rows: readonly ForkRows[K][]): Promise<void> {
    await this.open(snapshot).forkTarget(artifactDirectory).stage(kind, rows);
  }

  async forkPublish(snapshot: AgentSnapshot, artifactDirectory: string, cutMessageId: string): Promise<void> {
    await this.open(snapshot).forkTarget(artifactDirectory).publish(cutMessageId);
  }

  async standing(snapshot: AgentSnapshot, contextWindow: number | null): Promise<AgentStanding> {
    return this.open(snapshot).standing(contextWindow);
  }

  async listRuns(snapshot: AgentSnapshot, request: PageRequest | null): Promise<Page<RunListEntry>> {
    return listRuns(this.open(snapshot).runs(), request?.cursor ?? null, request?.limit);
  }

  async runSummaries(snapshot: AgentSnapshot, request: PageRequest | null): Promise<Page<RunSummary>> {
    return getRunSummaries(this.open(snapshot).runs(), request?.cursor ?? null, request?.limit);
  }

  async runEvents(snapshot: AgentSnapshot, runId: string, query: RunEventQuery | null): Promise<RunEvent[]> {
    return getRunEvents(this.open(snapshot).runs(), runId, query ?? undefined);
  }

  async runEventText(snapshot: AgentSnapshot, runId: string, query: RunEventQuery | null): Promise<StoredRunEvent[]> {
    return getRunEventText(this.open(snapshot).runs(), runId, query ?? undefined);
  }

  async steps(snapshot: AgentSnapshot, limit: number): Promise<AgentSteps> {
    return this.open(snapshot).steps(limit);
  }

  async runSteps(snapshot: AgentSnapshot, runId: string, before: number): Promise<ReadableStream<Uint8Array>> {
    return jsonLineStream(this.open(snapshot).runSteps(runId, before));
  }

  async turnPair(snapshot: AgentSnapshot, messageId: string): Promise<ConversationTurnPair | null> {
    return await this.open(snapshot).turnPair(messageId);
  }

  async lastUserMetadata(snapshot: AgentSnapshot): Promise<JsonObject | null> {
    return await this.open(snapshot).lastUserMetadata();
  }

  async drainAnswers(snapshot: AgentSnapshot, drainTurnIds: readonly string[]): Promise<Readonly<Record<string, string>>> {
    return await this.open(snapshot).drainAnswers(drainTurnIds);
  }

  async owedWork(snapshot: AgentSnapshot): Promise<readonly InspectedWork[]> {
    return await settle(this.withChat(snapshot, (chat) => chat.owedWork()));
  }

  /** An advisor's answer on one of this agent's own turns, judged by this isolate's lane and said here. */
  async deliverAdvice(snapshot: AgentSnapshot, subagent: AnsweredEvolutionSubagent, turnId: string): Promise<boolean> {
    return await (await this.open(snapshot).acquire()).session.advisor.sayAnswer(subagent, turnId);
  }

  async idle(): Promise<void> {
    await this.held?.idle();
  }

  async step(turnId: string, dynamic: DynamicContext | null): Promise<void> {
    await this.pacer.grant(turnId, dynamic);
  }

  async seed(snapshot: AgentSnapshot): Promise<ChatWindow> {
    return await this.open(snapshot).seed();
  }

  async media(snapshot: AgentSnapshot, ref: MediaRef): Promise<StoredImage | null> {
    return await this.open(snapshot).media(ref);
  }

  async historyPage(snapshot: AgentSnapshot, page: PositionPageRequest): Promise<ChatHistoryPage> {
    return await this.open(snapshot).historyPage(page);
  }

  async archivePage(snapshot: AgentSnapshot, cursor: ArchiveSqlCursor | null, maxBytes: number): Promise<ArchiveAgentPage> {
    return readAgentArchivePage(this.ctx.storage.sql, this.open(snapshot).reference().actorId, cursor, maxBytes);
  }

  async inspect(snapshot: AgentSnapshot, request: AgentOwnInspection): Promise<SubagentInspectionResult> {
    return await this.open(snapshot).inspect(request);
  }

  async inheritedContext(snapshot: AgentSnapshot): Promise<SerializedMessage[]> {
    return await this.open(snapshot).inheritedContext();
  }

  async workingContext(snapshot: AgentSnapshot): Promise<readonly JsonValue[]> {
    return encodeModelMessageValues(await this.open(snapshot).workingContext());
  }

  async turnRequests(snapshot: AgentSnapshot, turnId: string): Promise<TurnRequestIndex> {
    return this.open(snapshot).turnRequests(turnId);
  }

  async recordedTurns(snapshot: AgentSnapshot, limit?: number): Promise<JsonValue[]> {
    return encodeRecordedTurns(await this.open(snapshot).recordedTurns(limit));
  }

  async turnRequest(snapshot: AgentSnapshot, at: TurnRequestAt): Promise<TurnRequestPage> {
    return await this.open(snapshot).turnRequest(at);
  }

  async messageCount(snapshot: AgentSnapshot): Promise<number> {
    return this.open(snapshot).messageCount();
  }

  async searchConversations(snapshot: AgentSnapshot, query: string, limit?: number): Promise<ConversationSearchHit[]> {
    return await this.open(snapshot).conversations().search(query, limit);
  }

  async scrollConversation(snapshot: AgentSnapshot, around: string, window?: number, maxChars?: number): Promise<ConversationScrollResult | null> {
    return await this.open(snapshot).conversations().scroll(around, window, maxChars);
  }

  async browseConversations(snapshot: AgentSnapshot, limit?: number): Promise<ConversationSummary[]> {
    return await this.open(snapshot).conversations().browse(limit);
  }

  async context(snapshot: AgentSnapshot, editor: ContextEditor): Promise<ContextTreeRemote> {
    return new AgentContextTree(servedContextTree(this.open(snapshot).contextTree(editor)));
  }

  async spend(snapshot: AgentSnapshot, steps: readonly StepSpendSource[]): Promise<SpendLedger> {
    return this.open(snapshot).spend(steps);
  }

  async unseen(snapshot: AgentSnapshot, ids: readonly string[]): Promise<string[]> {
    return this.open(snapshot).unseen(ids);
  }

  /** Stops one run its workspace delivered: queued, it never runs; running, its chat aborts it. */
  async interrupt(snapshot: AgentSnapshot, turnId: string): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => { chat.session.stopRun(turnId); }));
  }

  async recover(snapshot: AgentSnapshot): Promise<AgentRecovery> {
    return await this.open(snapshot).recover();
  }

  async outOfMemory(snapshot: AgentSnapshot, diedAt: number): Promise<void> {
    this.open(snapshot).outOfMemory(diedAt);
  }

}
