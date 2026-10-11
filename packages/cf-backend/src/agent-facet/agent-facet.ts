import { type VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
/** One non-main agent in its own loader isolate (D9). */
import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { Nimbus, type NimbusSandbox, type NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import type { UIMessage } from 'ai';
import { Cause, Effect, Exit } from 'effect';
import { attempt, attemptInItsWords, diagnostics, flight, hold, KinuError, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';
import {
  encodeModelMessageValues, jsonResultOrVoid, readAgentArchivePage,
  type InspectedWork,
  type AgentOwnInspection, type JsonValue, type ArchiveAgentPage, type ArchiveSqlCursor, type ChatHistoryPage,
  type NimbusSandboxHandle, type PositionPageRequest, type ProviderEnv, type SerializedMessage, type SubordinateInspectionResult,
  servedContextTree, type ContextEditor, type ContextTreeRemote, type SpendLedger, type StepSpendSource, type TurnRequestIndex, type TurnRequestPage, type ConversationSearchHit, type ConversationScrollResult, type ConversationSummary,
  type SendState, DeliverySchema, WorkModeSchema, type Delivery, type DeliveryAnswer,
} from '@kinu.run/core';
import * as v from 'valibot';
import { StepPacer } from './step-pacer';
import { AgentDatabase } from './agent-database';
import { runAgentTask, type AgentRunOutcome } from './agent-turn';
import { createAgentProviderRegistry, type AgentProviderDeps, type AgentProviderRegistry } from '../providers/agent-registry';
import { FacetChat } from './agent-chat';
import { workspaceClient, type AgentWorkspaceCalls } from './workspace-rpc';
import type {
  AgentAnswer, AgentAnswerTexts, AgentStanding, AgentSteps, AgentRecovery, AgentSnapshot, ConversationProjection, ConversationTurnPair, AgentTurnTask, EnqueueTurnResult, ProgrammaticTurn, SendLanding, TurnRequestAt,
  JsonObject, PlanDecisionOutcome, PlanEdit, PlanReview, PlanReviewDecision, PlanReviewResult, ReviewAnnotation, AskedQuestions, OwnerAnswer,
  Page, PageRequest, RunEvent, RunEventQuery, RunListEntry, RunSummary, StoredRunEvent,
  ForkConversationPlan, ForkConversationSection, ForkRowSection, ForkRows,
} from '@kinu.run/core';
import { getRunEvents, getRunEventText, getRunSummaries, listRuns } from '@kinu.run/core';

export type { AgentWorkspace } from './agent-turn';

export interface AgentFacetEnv {
  readonly WORKSPACE: AgentWorkspaceCalls;
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

export interface AgentFacetCalls {
  /** Resolves once its chat holds the delivery in its own store. */
  admit(snapshot: AgentSnapshot, delivery: Delivery): Promise<DeliveryAnswer>;
  landing(snapshot: AgentSnapshot, id: string): Promise<SendLanding>;
  retry(snapshot: AgentSnapshot, claim: (turnId: string) => void): Promise<SendLanding>;
  sendState(snapshot: AgentSnapshot, id: string): Promise<SendState>;
  awaitSend(snapshot: AgentSnapshot, id: string): Promise<SendState>;
  interruptChat(snapshot: AgentSnapshot): Promise<readonly string[]>;
  /** The owner's Stop: unseen steers stay queued and rerun. */
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
  /** Its questions to its owner, in its own store: asked on the owner's turns, answered from the workspace's stack. */
  ownerQuestions(snapshot: AgentSnapshot): Promise<readonly AskedQuestions[]>;
  /** The answer becomes the asking call's result, and the turn that continues from it is queued in its own chat. */
  answerOwnerQuestions(snapshot: AgentSnapshot, id: string, answers: readonly OwnerAnswer[]): Promise<void>;
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

  private box: NimbusSandboxHandle | undefined;

  private stateBox: NimbusSandboxHandle | undefined;

  private database: AgentDatabase | undefined;

  /** Its chat, prepared once and joined by every caller; a failed preparation is not kept, so the next call prepares again. */
  private readonly chats = flight((snapshot: AgentSnapshot) => Effect.promise(() => this.prepared(snapshot)), { keep: 'success' });

  private held: FacetChat | undefined;

  private readonly pacer = new StepPacer();

  /** The registry this agent's turns resolve their models through, over its own providers. */
  protected models(deps: Omit<AgentProviderDeps, 'env'>): AgentProviderRegistry {
    return createAgentProviderRegistry({ ...deps, env: this.env });
  }

  protected workspace(): NimbusSandboxHandle {
    this.box ??= sandboxHandle(Nimbus.fromSession((): NimbusSessionSurface => this.workspaceCalls.session())
      .sandbox(this.env.WORKSPACE_NAME, { shellId: this.env.SHELL_ID, root: this.env.HOME }));

    return this.box;
  }

  private state(): NimbusSandboxHandle {
    this.stateBox ??= sandboxHandle(Nimbus.fromSession((): NimbusSessionSurface => this.workspaceCalls.stateSession())
      .sandbox(this.env.WORKSPACE_NAME, { shellId: this.env.STATE_SHELL_ID }));

    return this.stateBox;
  }


  private open(snapshot: AgentSnapshot): AgentDatabase {
    this.database ??= new AgentDatabase(this.ctx.storage, {
      agent: () => this.workspace(), home: this.env.HOME, state: () => this.state(),
      enqueueTurn: (input) => this.enqueue(snapshot, input),
      admitDelivery: (delivery) => this.admit(snapshot, delivery),
      // A steer's fate rides its chat's events, in order with the turns it names.
      broadcast: (event) => { this.held?.session.emit({ type: 'broadcast', event }); },
      turnInFlight: () => this.held?.session.turnInFlight() ?? false,
      memory: () => this.workspaceCalls.memory(), program: (...args) => this.workspaceCalls.program(...args),
      sayToParent: (signal) => this.workspaceCalls.sayToParent(signal),
      logActivity: (lines) => this.workspaceCalls.logActivity(lines),
    });
    this.database.adopt(snapshot);

    return this.database;
  }

  private async prepared(snapshot: AgentSnapshot): Promise<FacetChat> {
    const database = this.open(snapshot);
    // The workspace's program first: the actor is built on it.
    const prepared = await this.workspaceCalls.prepareChat({ turnId: null, mode: 'build', userText: '', parentDriven: false });

    database.adopt({ ...snapshot, scaffold: [prepared.scaffold] });
    const actor = await database.acquire();
    const chat = new FacetChat({ actor, database, workspace: this.workspaceCalls, models: (deps) => this.models(deps), storage: this.ctx.storage, pacer: this.pacer });

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


  /** A turn its own isolate queues: answered once its chat has processed it. */
  async enqueue(snapshot: AgentSnapshot, turn: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.enqueueTurn(turn)));
  }

  /** A delivery from the workspace (design v2 §1): in this isolate's store before it is answered, which retires the
   *  workspace's row; a repeat is answered `duplicate`. */
  async admit(snapshot: AgentSnapshot, delivery: Delivery): Promise<DeliveryAnswer> {
    const parsed = v.parse(DeliverySchema, delivery);

    // A run is this isolate's to run beside its chat, never a turn of it.
    if (parsed.input.kind === 'run') return this.admitRun(snapshot, parsed.id, parsed.input.task);

    return await settle(Effect.flatMap(this.withChat(snapshot, (chat) => chat), (chat) => (chat.session.closing
      // Closing: owed to its next start, so the crossing fails and the workspace's wake crosses it again.
      ? Effect.fail(new KinuError('unavailable', 'The agent is closing; the delivery is owed to its next start.'))
      : attemptInItsWords('io', () => chat.session.admitDelivery(v.parse(DeliverySchema, delivery))).pipe(
        // Its own refusal is its answer, not a lost crossing: told with its whole cause chain.
        Effect.catch((refusal) => Effect.succeed<DeliveryAnswer>({ refused: { code: refusal.code, message: renderThrownChain({ cause: refusal }) } })),
        Effect.tap(() => Effect.promise(() => chat.taken())),
      ))));
  }

  /** Where a person's words landed, once a turn took them: what their client is told. */
  async landing(snapshot: AgentSnapshot, id: string): Promise<SendLanding> {
    return await settle(this.withChat(snapshot, (chat) => chat.session.awaitLanding(id)));
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
    // A run a death cut off runs again: its workspace's caller still awaits its end.
    for (const owed of this.runs().unended()) this.startRun(snapshot, owed.id, owed.task);

    return await settle(this.withChat(snapshot, (chat) => chat.wake()));
  }

  private runTable: FacetRuns | null = null;

  private runs(): FacetRuns {
    this.runTable ??= new FacetRuns(this.ctx.storage.sql);

    return this.runTable;
  }


  /** A delivered run (design v2 §1): in this isolate's store before it is answered, run to its end beside the chat, and its
   *  end reported to the workspace, whose caller awaits it; a repeat is answered `duplicate`. */
  private admitRun(snapshot: AgentSnapshot, id: string, task: AgentTurnTask): DeliveryAnswer {
    if (!this.runs().admit(id, task)) return 'duplicate';
    this.startRun(snapshot, id, task);

    return 'taken';
  }

  private startRun(snapshot: AgentSnapshot, id: string, task: AgentTurnTask): void {
    if (this.runsInFlight.has(id)) return;

    const run = Effect.gen({ self: this }, function* () {
      const exit = yield* Effect.exit(attempt({ doing: 'running a delivered task in its agent\'s isolate', otherwise: 'io' }, () => runAgentTask({
        database: this.open(snapshot), workspace: this.workspaceCalls, models: (deps) => this.models(deps), pacer: this.pacer,
      }, task)));

      const outcome: AgentRunOutcome = Exit.isSuccess(exit)
        ? { ended: exit.value }
        : { refused: { code: toKinuError({ doing: 'running a delivered task', cause: Cause.squash(exit.cause), otherwise: 'io' }).code, message: renderThrownChain({ cause: Cause.squash(exit.cause) }) } };

      yield* attempt({ doing: "reporting a delivered run's end to its workspace", otherwise: 'unavailable' }, () => this.workspaceCalls.runEnded(id, outcome));
      this.runs().ended(id);
    }).pipe(Effect.catch((failure) => Effect.sync(() => {
      // Unreported: the next wake runs it again, and its caller hears that end.
      diagnostics.failure('agent.run_report_failed', failure, { runId: id });
    })), Effect.ensuring(Effect.sync(() => { this.runsInFlight.delete(id); })));

    this.runsInFlight.set(id, hold(run));
  }

  /** The runs this isolate runs now, by id: a wake starts none twice, and its idle joins them. */
  private readonly runsInFlight = new Map<string, Promise<unknown>>();

  async modelSettingsChanged(snapshot: AgentSnapshot): Promise<void> {
    return await settle(this.withChat(snapshot, (chat) => chat.modelSettingsChanged()));
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

  async ownerQuestions(snapshot: AgentSnapshot): Promise<readonly AskedQuestions[]> {
    return await settle(this.withChat(snapshot, (chat) => chat.questions.recent()));
  }

  async answerOwnerQuestions(snapshot: AgentSnapshot, id: string, answers: readonly OwnerAnswer[]): Promise<void> {
    return await settle(Effect.flatMap(this.withChat(snapshot, (chat) => chat), (chat) => chat.session.answerQuestions(id, answers)));
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

  async idle(): Promise<void> {
    await Promise.all([this.held?.idle(), ...this.runsInFlight.values()]);
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

}

const FacetRunRowSchema = v.object({ id: v.string(), task_json: v.string() });

const AgentTurnTaskSchema = v.object({ sequenceId: v.string(), body: v.string(), mode: WorkModeSchema });

/** The runs delivered to this isolate, durable until each one's end is reported: a death between admitting one and
 *  reporting its end leaves it here, for the next wake to run again. */
class FacetRuns {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS facet_runs (id TEXT PRIMARY KEY, task_json TEXT NOT NULL, ended INTEGER NOT NULL DEFAULT 0)');
  }

  /** False for one already admitted. */
  admit(id: string, task: AgentTurnTask): boolean {
    return this.sql.exec('INSERT OR IGNORE INTO facet_runs (id, task_json) VALUES (?, ?) RETURNING id', id, JSON.stringify(task)).toArray().length > 0;
  }

  ended(id: string): void {
    this.sql.exec('UPDATE facet_runs SET ended = 1 WHERE id = ?', id);
  }

  unended(): { readonly id: string; readonly task: AgentTurnTask }[] {
    return this.sql.exec('SELECT id, task_json FROM facet_runs WHERE ended = 0').toArray().map((raw) => {
      const row = v.parse(FacetRunRowSchema, raw);

      return { id: row.id, task: v.parse(AgentTurnTaskSchema, JSON.parse(row.task_json)) };
    });
  }
}
