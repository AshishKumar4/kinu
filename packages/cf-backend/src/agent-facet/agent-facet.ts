import { type VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
/** One non-main agent in its own loader isolate (D9). */
import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { Nimbus, type NimbusSandbox, type NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import type { UIMessage } from 'ai';
import { Effect } from 'effect';
import { flight, settle, type KinuError } from '@kinu.run/core/obs';
import {
  encodeModelMessageValues, jsonResultOrVoid, readAgentArchivePage,
  type InspectedWork,
  type AgentOwnInspection, type AnsweredEvolutionHelper, type JsonValue, type ArchiveAgentPage, type ArchiveSqlCursor, type ChatHistoryPage,
  type NimbusSandboxHandle, type PositionPageRequest, type ProviderEnv, type SerializedMessage, type SubordinateInspectionResult,
  servedContextTree, type ContextEditor, type ContextTreeRemote, type SpendLedger, type StepSpendSource, type TurnRequestIndex, type TurnRequestPage, type ConversationSearchHit, type ConversationScrollResult, type ConversationSummary,
  type SendState,
} from '@kinu.run/core';
import { StepPacer } from './step-pacer';
import { AgentDatabase } from './agent-database';
import { runAgentTask, type AgentWorkspace } from './agent-turn';
import { FacetChat } from './agent-chat';
import type {
  AgentAnswer, AgentAnswerTexts, AgentStanding, AgentSteps, AgentRecovery, AgentSnapshot, ConversationProjection, ConversationTurnPair, AgentTurnEnd, AgentTurnTask, EnqueueTurnResult, ProgrammaticTurn, PromptFile, SendLanding, SendOptions, TurnRequestAt,
  JsonObject, PlanDecisionOutcome, PlanEdit, PlanReview, PlanReviewDecision, PlanReviewResult, ReviewAnnotation,
  Page, PageRequest, RunEvent, RunEventQuery, RunListEntry, RunSummary, StoredRunEvent,
} from '@kinu.run/core';
import { getRunEvents, getRunEventText, getRunSummaries, listRuns } from '@kinu.run/core';

export type { AgentWorkspace } from './agent-turn';

export interface AgentFacetEnv {
  readonly WORKSPACE: AgentWorkspace;
  readonly WORKSPACE_NAME: string;
  readonly SHELL_ID: string;
  readonly HOME: string;
  readonly STATE_SHELL_ID: string;
  readonly AI?: ProviderEnv['AI'];
  readonly AI_GATEWAY_URL?: string;
  readonly WORKERS_AI_VIA_BINDING?: string;
}

function sandboxHandle(sandbox: NimbusSandbox): NimbusSandboxHandle {
  return {
    ready: () => sandbox.ready(),
    exec: (command, options) => sandbox.exec(command, options),
    execStream: (command, options) => sandbox.execStream(command, options),
    startProcess: (command, options) => sandbox.startProcess(command, options),
    runCode: (code, options) => sandbox.runCode(code, options),
    files: sandbox.files,
    runtimes: {
      ensure: (specs, options) => jsonResultOrVoid(sandbox.runtimes.ensure(specs, options)),
      install: (spec, options) => jsonResultOrVoid(sandbox.runtimes.install(spec, options)),
      list: () => jsonResultOrVoid(sandbox.runtimes.list()),
    },
    processes: {
      list: () => jsonResultOrVoid(sandbox.processes.list()),
      kill: (pid) => jsonResultOrVoid(sandbox.processes.kill(pid)),
      logs: (pid, options) => jsonResultOrVoid(sandbox.processes.logs(pid, options)),
    },
  };
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

/** The owner's decision on one revision of an agent's plan. */
export interface PlanVerdict {
  readonly id: string;
  readonly revision: number;
  readonly decision: PlanReviewDecision;
  readonly feedback?: string;
}

export interface AgentSend {
  readonly text: string;
  readonly files?: readonly PromptFile[];
  /** A card's stamp: it is its own turn, never a steer, and it renders from this. */
  readonly card?: JsonObject;
}

export interface AgentFacetCalls {
  run(snapshot: AgentSnapshot, task: AgentTurnTask): Promise<AgentTurnEnd>;
  /** Answered once its chat has processed it. */
  enqueue(snapshot: AgentSnapshot, turn: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  /** Answered once the turn is queued: the workspace's own agent's wakes, handed over from inside the workspace's settles. */
  queue(snapshot: AgentSnapshot, turn: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  send(snapshot: AgentSnapshot, input: AgentSend, opts: SendOptions): Promise<SendLanding>;
  /** Resolves once its chat has reserved the words, not when they land. */
  admit(snapshot: AgentSnapshot, input: AgentSend, opts: SendOptions): Promise<void>;
  retry(snapshot: AgentSnapshot, claim: (turnId: string) => void): Promise<SendLanding>;
  sendState(snapshot: AgentSnapshot, id: string): Promise<SendState>;
  awaitSend(snapshot: AgentSnapshot, id: string): Promise<SendState>;
  interruptChat(snapshot: AgentSnapshot): Promise<readonly string[]>;
  /** The owner's Stop: unseen steers stay queued and rerun. */
  stopChat(snapshot: AgentSnapshot): Promise<void>;
  /** What a reset left owed is taken up; the agent tells its workspace what is left once it rests. */
  wake(snapshot: AgentSnapshot): Promise<void>;
  /** The next request is measured on the new settings, and a refusal only the owner could fix may answer now. */
  modelSettingsChanged(snapshot: AgentSnapshot): Promise<void>;
  /** The chat continues from before `entryId`; refused while a turn runs. */
  revertTo(snapshot: AgentSnapshot, entryId: string): Promise<void>;
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
  /** A turn's request and response by its answer's id, for a rating its workspace records; null for none. */
  turnPair(snapshot: AgentSnapshot, messageId: string): Promise<ConversationTurnPair | null>;
  /** The metadata of its newest message from a person, which its idle work mode reads; null before any. */
  lastUserMetadata(snapshot: AgentSnapshot): Promise<JsonObject | null>;
  /** The answer each drain turn gave, by drain turn id, for the replies its workspace owes. */
  drainAnswers(snapshot: AgentSnapshot, drainTurnIds: readonly string[]): Promise<Readonly<Record<string, string>>>;
  /** A retirement waits on it. */
  idle(): Promise<void>;
  /** Runs the turn's waiting model step under this call, and answers once it has ended (`StepPacer`). */
  step(turnId: string): Promise<void>;
  history(snapshot: AgentSnapshot, limit?: number): Promise<UIMessage[]>;
  historyPage(snapshot: AgentSnapshot, page: PositionPageRequest): Promise<ChatHistoryPage>;
  messageCount(snapshot: AgentSnapshot): Promise<number>;
  inspect(snapshot: AgentSnapshot, request: AgentOwnInspection): Promise<SubordinateInspectionResult>;
  inheritedContext(snapshot: AgentSnapshot): Promise<SerializedMessage[]>;
  /** In the session codec's durable form, as `AgentWorkspace.resume`. */
  workingContext(snapshot: AgentSnapshot): Promise<readonly JsonValue[]>;
  turnRequests(snapshot: AgentSnapshot, turnId: string): Promise<TurnRequestIndex>;
  turnRequest(snapshot: AgentSnapshot, at: TurnRequestAt): Promise<TurnRequestPage>;
  spend(snapshot: AgentSnapshot, steps: readonly StepSpendSource[]): Promise<SpendLedger>;
  context(snapshot: AgentSnapshot, editor: ContextEditor): Promise<ContextTreeRemote>;
  searchConversations(snapshot: AgentSnapshot, query: string, limit?: number): Promise<ConversationSearchHit[]>;
  scrollConversation(snapshot: AgentSnapshot, around: string, window?: number, maxChars?: number): Promise<ConversationScrollResult | null>;
  browseConversations(snapshot: AgentSnapshot, limit?: number): Promise<ConversationSummary[]>;
  admitted(snapshot: AgentSnapshot, id: string): Promise<boolean>;
  interrupt(snapshot: AgentSnapshot, turnId: string): Promise<void>;
  recover(snapshot: AgentSnapshot): Promise<AgentRecovery>;
  archivePage(snapshot: AgentSnapshot, cursor: ArchiveSqlCursor | null, maxBytes: number): Promise<ArchiveAgentPage>;
  deliverAdvice(snapshot: AgentSnapshot, helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean>;
  /** Its plan reviews, in its own store: submitted by its turn, under that turn's author-stamped metadata, and reviewed by
   *  the owner through its window. */
  submitPlan(snapshot: AgentSnapshot, edits: readonly PlanEdit[], driving: JsonObject | undefined): Promise<PlanReviewResult>;
  /** Its reply in a comment thread of the review the owner sent back. */
  replyPlanComment(snapshot: AgentSnapshot, comment: string, text: string, driving: JsonObject | undefined): Promise<PlanReviewResult>;
  activePlanReview(snapshot: AgentSnapshot): Promise<PlanReview | null>;
  /** Newest first, for Work and the review queue; a retained retired agent answers too. */
  planReviews(snapshot: AgentSnapshot): Promise<readonly PlanReview[]>;
  savePlanReviewAnnotations(snapshot: AgentSnapshot, id: string, revision: number, annotations: ReviewAnnotation[]): Promise<PlanReviewResult>;
  dismissPlanReview(snapshot: AgentSnapshot, id: string, revision: number): Promise<PlanReviewResult>;
  /** The feedback or approval turn is queued in its own chat. */
  decidePlanReview(snapshot: AgentSnapshot, verdict: PlanVerdict): Promise<PlanDecisionOutcome>;
}

export class AgentFacet extends DurableObject<AgentFacetEnv> implements AgentFacetCalls {
  private box: NimbusSandboxHandle | undefined;

  private stateBox: NimbusSandboxHandle | undefined;

  private database: AgentDatabase | undefined;

  /** Its chat, prepared once and joined by every caller; a failed preparation is not kept, so the next call prepares again. */
  private readonly chats = flight((snapshot: AgentSnapshot) => Effect.promise(() => this.prepared(snapshot)), { keep: 'success' });

  private held: FacetChat | undefined;

  private readonly pacer = new StepPacer();

  protected workspace(): NimbusSandboxHandle {
    this.box ??= sandboxHandle(Nimbus.fromSession((): NimbusSessionSurface => this.env.WORKSPACE.session())
      .sandbox(this.env.WORKSPACE_NAME, { shellId: this.env.SHELL_ID, root: this.env.HOME }));

    return this.box;
  }

  private state(): NimbusSandboxHandle {
    this.stateBox ??= sandboxHandle(Nimbus.fromSession((): NimbusSessionSurface => this.env.WORKSPACE.stateSession())
      .sandbox(this.env.WORKSPACE_NAME, { shellId: this.env.STATE_SHELL_ID }));

    return this.stateBox;
  }


  private open(snapshot: AgentSnapshot): AgentDatabase {
    this.database ??= new AgentDatabase(this.ctx.storage, {
      agent: () => this.workspace(), home: this.env.HOME, state: () => this.state(),
      enqueueTurn: (input) => this.enqueue(snapshot, input),
      turnInFlight: () => this.held?.session.turnInFlight() ?? false,
      memory: () => this.env.WORKSPACE.memory(), program: (...args) => this.env.WORKSPACE.program(...args),
      sayToParent: (signal) => this.env.WORKSPACE.sayToParent(signal),
    });
    this.database.adopt(snapshot);

    return this.database;
  }

  private async prepared(snapshot: AgentSnapshot): Promise<FacetChat> {
    const database = this.open(snapshot);
    // The workspace's program first: the actor is built on it.
    const prepared = await this.env.WORKSPACE.prepareChat({ turnId: null, mode: 'build', userText: '', parentDriven: false });

    database.adopt({ ...snapshot, scaffold: [prepared.scaffold] });
    const actor = await database.acquire();
    const chat = new FacetChat({ actor, database, workspace: this.env.WORKSPACE, providers: this.env, storage: this.ctx.storage, pacer: this.pacer });

    chat.session.measureSessionStart({ restored: chat.session.restoreHistory() });
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

  async run(snapshot: AgentSnapshot, task: AgentTurnTask): Promise<AgentTurnEnd> {
    return await runAgentTask({ database: this.open(snapshot), workspace: this.env.WORKSPACE, providers: this.env, pacer: this.pacer }, task);
  }

  async enqueue(snapshot: AgentSnapshot, turn: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.enqueueTurn(turn)));
  }

  async queue(snapshot: AgentSnapshot, turn: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.queueTurn(turn)));
  }

  async send(snapshot: AgentSnapshot, input: AgentSend, opts: SendOptions): Promise<SendLanding> {
    return await settle(this.withChat(snapshot, async (chat) => {
      const landing = await chat.session.send(input.files === undefined ? input.text : { text: input.text, files: input.files }, opts);

      await chat.told();

      return landing;
    }));
  }

  async admit(snapshot: AgentSnapshot, input: AgentSend, opts: SendOptions): Promise<void> {
    return await settle(this.withChat(snapshot, async (chat) => {
      const words = input.files === undefined ? input.text : { text: input.text, files: input.files };

      // A card's reservation has nothing of the workspace's to take in its transaction: the workspace takes its own after.
      await chat.session.admit(words, input.card === undefined ? opts : { ...opts, metadata: input.card, consume: () => {} });
      await chat.told();
    }));
  }

  async retry(snapshot: AgentSnapshot, claim: (turnId: string) => void): Promise<SendLanding> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.retry(claim)));
  }

  async sendState(snapshot: AgentSnapshot, id: string): Promise<SendState> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.sendState(id)));
  }

  async awaitSend(snapshot: AgentSnapshot, id: string): Promise<SendState> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.awaitSend(id)));
  }

  async interruptChat(snapshot: AgentSnapshot): Promise<readonly string[]> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.interrupt()));
  }

  async wake(snapshot: AgentSnapshot): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => chat.wake()));
  }

  async modelSettingsChanged(snapshot: AgentSnapshot): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => chat.modelSettingsChanged()));
  }

  async stopChat(snapshot: AgentSnapshot): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => { chat.session.stop(); }));
  }

  async revertTo(snapshot: AgentSnapshot, entryId: string): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.revertTo(entryId)));
  }

  async clearConversation(snapshot: AgentSnapshot): Promise<string | null> {
    return await settle(this.withChat(snapshot, async (chat) => (await chat.clear())?.message ?? null));
  }

  async submitPlan(snapshot: AgentSnapshot, edits: readonly PlanEdit[], driving: JsonObject | undefined): Promise<PlanReviewResult> {
    return await settle(this.withChat(snapshot, (chat) => chat.planned((plans) => plans.submit(edits, driving))));
  }

  async replyPlanComment(snapshot: AgentSnapshot, comment: string, text: string, driving: JsonObject | undefined): Promise<PlanReviewResult> {
    return await settle(this.withChat(snapshot, (chat) => chat.planned((plans) => plans.reply(comment, text, driving))));
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

  async decidePlanReview(snapshot: AgentSnapshot, verdict: PlanVerdict): Promise<PlanDecisionOutcome> {
    return await settle(this.withChat(snapshot, (chat) => chat.planned((plans) => plans.decideAndHandOff(verdict, (turn) => chat.session.enqueueTurn(turn)))));
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

  async idle(): Promise<void> {
    await this.held?.idle();
  }

  async step(turnId: string): Promise<void> {
    await this.pacer.grant(turnId);
  }

  async history(snapshot: AgentSnapshot, limit?: number): Promise<UIMessage[]> {
    return await this.open(snapshot).history(limit);
  }

  async historyPage(snapshot: AgentSnapshot, page: PositionPageRequest): Promise<ChatHistoryPage> {
    return await this.open(snapshot).historyPage(page);
  }

  async archivePage(snapshot: AgentSnapshot, cursor: ArchiveSqlCursor | null, maxBytes: number): Promise<ArchiveAgentPage> {
    return readAgentArchivePage(this.ctx.storage.sql, this.open(snapshot).reference().actorId, cursor, maxBytes);
  }

  async inspect(snapshot: AgentSnapshot, request: AgentOwnInspection): Promise<SubordinateInspectionResult> {
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

  async admitted(snapshot: AgentSnapshot, id: string): Promise<boolean> {
    return this.open(snapshot).admitted(id);
  }

  async interrupt(snapshot: AgentSnapshot, turnId: string): Promise<void> {
    this.open(snapshot).interrupt(turnId);
  }

  async recover(snapshot: AgentSnapshot): Promise<AgentRecovery> {
    return await this.open(snapshot).recover();
  }

  async deliverAdvice(snapshot: AgentSnapshot, helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean> {
    return await (await this.open(snapshot).acquire()).session.sayAdvisorAnswer(helper, turnId);
  }
}
