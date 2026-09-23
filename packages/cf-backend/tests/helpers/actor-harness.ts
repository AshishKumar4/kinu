/**
 * Instantiate a real cf actor class under bun, the platform mocked at its seams
 * (agents SDK base, DO storage over bun:sqlite, env). Codemode cannot execute here (env.LOADER throws).
 */
import { Database } from 'bun:sqlite';
import { makeSqlExec } from '../../../core/tests/helpers';
import type { PlanReviewStore } from '@kinu.run/core';
import type { AgentContext, Connection, FiberRecoveryContext, FiberRecoveryResult, WSMessage } from 'agents';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import * as v from 'valibot';
import { scriptedTurnModel, type ModelStreamPart, type ScriptedTurnOptions, type ScriptedTurnResult } from '@kinu.run/test-utils/turn-model';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import type { PreparedRequest, ScriptedAnswer, SettledTurn, TurnHarness } from './turn-harness';
import type { UserCaller, SendLanding, ProgrammaticTurn, EnqueueTurnResult, SpendSource, BackendHost } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import type { Refusal } from '@kinu.run/core/obs';
import type { SessionTranscript } from '@kinu.run/core';
import { OwnedModelServices } from '../../src/owned-model-services';
import type { ChatTurnInput, ActorTurnLease, PreparedTurn, RunEventRecorder } from '@kinu.run/core';
import type { ChatWireTransport } from '../../src/chat-transport';
import { isWorkMode, workModeForTurnMetadata, ChatSession, ExtensionHost, PendingSendStore, type KinuExtension } from '@kinu.run/core';
import {
  createParentWorkspaceVfs, openWorkspaceMainActor, SessionHistory, TerminalTransitions, type VFS,
} from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import {
  createCompositeLogger, createConsoleLogger, renderCauseChain, setDiagnosticsSink, toKinuError, type Logger,
} from '@kinu.run/core/obs';
import type { UserDO } from '../../src/user/user-do';
import type { SlateHost } from '../../src/slates/host';
import {
  shadowTrialPlan, claimToolEffect, actorReferenceOf,
  type ActorHandle, type SqlExecutor,
  type ActorHost, type HostedActor, type SubordinateSeed, type HeadStreamFrame,
} from '@kinu.run/core';
import {
  BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC, profileCatalogDigest,
  type AgentOrchestrator, type AgentRuntime, type CompletedTurn, type DynamicContext,
  type IngressDescriptor, type ProfileCatalog, type ProfileCatalogEnvelope, type ProviderCatalogSnapshot,
  type RoleCatalog, type ResolvedTurnProfile, type RunEndReason, type SqlValue, type SubordinateRosterStore,
  type TierAssignments,
  projectJsonValue, composePrepareStep,
  type BackgroundJobStore, type JsonValue,
  type DeviceStatus,
  type WorkMode, type JsonObject,
  startBranchHead, branchHeadId,
  type HeadInput, type HeadReport, type HeadRuntime,
  type NimbusExecResult,
  type FactsStore, type SleepTimeUpdate,
  type AgentSignal, type SendOutcome, type ReleaseBoard, type EgressSecretBinding,
} from '@kinu.run/core';
import { joinHarnessFibers, mockAgentsSdk, seedOrphanFiberRow } from './agents-sdk';
import { fleetPlaneForTest, fleetPointWritten, openAnalyticsWindowForTest, type FleetPoint } from './analytics-plane';
import { platformGatewayEnv, type StubbedAiBinding } from './platform-gateway';
import {
  TerminalEffectInterrupt,
  type TerminalEffectName, type TerminalEffectPhase,
} from '@kinu.run/core';
import type { ExplorationHostSeams } from '../../src/exploration-hosting';
import type { HostedTaskProfile } from '../../src/subordinate-hosting';
import type { AgentProviderRegistry } from '../../src/providers/agent-registry';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SupervisorRPC } from '@nimbus-sh/worker/workspace-host';

mockAgentsSdk();

const { OrchestratorAgent } = await import('../../src/orchestrator');

const { runHostedTask } = await import('../../src/subordinate-hosting');

/** The scaffold precondition, declared satisfied. The soul is not: a turn
 *  refreshes the cache `setObservedSoul` pre-fills from the workspace filesystem. */
const HARNESS_PROFILE_ENVELOPE: ProfileCatalogEnvelope = {
  authority: { kind: 'local' },
  version: 0,
  digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
  catalog: BUILTIN_PROFILE_CATALOG,
};

const HARNESS_PROVIDER_SNAPSHOT: ProviderCatalogSnapshot = {
  revision: 'actor-harness',
  availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC],
};

export class HarnessOrchestratorAgent extends OrchestratorAgent {
  modelFactory?: () => LanguageModel;
  override getModel(): LanguageModel {
    return this.modelFactory?.() ?? super.getModel();
  }
  /** The harness's scripted model when supplied, the resolver's otherwise. */
  protected override turnModel(spec: string): LanguageModel {
    return this.modelFactory?.() ?? super.turnModel(spec);
  }
  /** Side models (titler, advisor, judge) are silent scripted ones: harness actors hold no
   *  provider credentials. A suite-scripted route is honoured; never the turn model. */
  sideModelFactory?: () => LanguageModel;
  protected override async modelForSource(source: SpendSource) {
    const routed = await super.modelForSource(source);
    // A scripted resolver is a plain object, not an `OwnedModelServices` instance.
    const scriptedRoute = !(this.ownedModelServices instanceof OwnedModelServices);

    if (scriptedRoute) return routed;

    return { ...routed, model: this.sideModelFactory?.() ?? SILENT_SIDE_MODEL };
  }
  observeRawTools(): ToolSet { return this.getRawTools(); }
  /** `true` admits a turn and parks it at its first model call; `false` settles it. */
  async declareTurnInFlight(inFlight: boolean): Promise<void> {
    if (inFlight) await chatSessionTurns(this).prepare({ messages: [{ role: 'user', content: 'a live turn' }] });
    else await chatSessionTurns(this).settle({ messageId: 'a live turn', text: 'done' });
  }
  get harnessChatLoop(): ChatSession { return this.chatLoop; }
  /** The conversation a stated turn is admitted over. Applies only while the actor
   *  holds no working history of its own. */
  async harnessSeedHistory(messages: readonly ModelMessage[]): Promise<void> {
    const current = await this.actorSession.canonical.materialize();

    if (current.entries.length > 0) return;
    await this.actorSession.restoreHistory(messages);
  }
  /** An observer on the actor's extension host: tool calls and results in settle order. */
  harnessRegisterExtension(extension: KinuExtension): void { this.extensions.register(extension); }
  get harnessTranscript(): SessionTranscript { return this.chatTranscript; }
  get harnessHistory(): SessionHistory { return this.actorSession.canonical; }
  harnessEnqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> { return this.chatLoop.enqueueTurn(input); }
  /** The answer id the next turn is persisted under; consumed by the next admission. */
  private _nextAnswerId: string | null = null;
  harnessNameNextAnswer(messageId: string): void { this._nextAnswerId = messageId; }
  protected override mintAnswerId(): string {
    const named = this._nextAnswerId;
    this._nextAnswerId = null;

    return named ?? super.mintAnswerId();
  }
  /** The ids the loop started its last turn under, off the transport's event stream. */
  private _lastTurnStart: { turnId: string; messageId: string } | null = null;
  harnessLastTurnStart(): { turnId: string; messageId: string } | null { return this._lastTurnStart; }
  /** Every text delta the transport delivered, in order: what a client has seen so far. */
  private readonly _deliveredText: string[] = [];
  private readonly _deliveryWatchers = new Set<() => void>();
  harnessDeliveredText(): string { return this._deliveredText.join(''); }
  /** Settles once the delivered text ends with `text`: the client has seen it. */
  harnessDelivered(text: string): Promise<void> {
    if (this.harnessDeliveredText().endsWith(text)) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const watcher = (): void => {
        if (!this.harnessDeliveredText().endsWith(text)) return;
        this._deliveryWatchers.delete(watcher);
        resolve();
      };

      this._deliveryWatchers.add(watcher);
    });
  }
  protected override get chatTransport(): ChatWireTransport {
    const transport = super.chatTransport;

    if (!this._observedTransport) {
      this._observedTransport = true;
      const deliver = transport.deliver.bind(transport);

      transport.deliver = (event) => {
        if (event.type === 'turn-start') this._lastTurnStart = { turnId: event.turnId, messageId: event.messageId };

        if (event.type === 'text-delta') {
          this._deliveredText.push(event.delta);

          for (const watcher of this._deliveryWatchers) watcher();
        }

        return deliver(event);
      };
    }

    return transport;
  }
  private _observedTransport = false;

  /** The next assistant row fails to write; the commit is one transaction, so nothing lands. */
  harnessNextAnswerUndurable(): void {
    const transcript = this.harnessTranscript;
    const append = transcript.appendAssistant.bind(transcript);
    Object.defineProperty(transcript, 'appendAssistant', {
      configurable: true,
      value: (row: Parameters<typeof append>[0]) => {
        Reflect.deleteProperty(transcript, 'appendAssistant');
        throw new Error(`the answer row ${row.id} could not be written`);
      },
    });
  }

  /** The head-stream broadcaster (`protected` on the actor). */
  observePublishHeadStreamFrame(frame: HeadStreamFrame): void { this.publishHeadStreamFrame(frame); }
  /** The child substrate, for lifecycle verbs without a roster row. */
  observeSubordinateRuntime() { return this.subordinateRuntime(); }
  /** The per-turn logic, for asserting what the steering + opportunity ledger saw. */
  observeOrch(): AgentOrchestrator { return this.orch; }
  observeRuntime(): AgentRuntime { return this.rt; }
  /** The slate host, so a suite can arm its one launch seam (`ensure`) as a tripwire. */
  observeSlateHost(): SlateHost { return this.slates; }
  /** The profile the last `beforeTurn` resolved. */
  observeResolvedTurnProfile(): ResolvedTurnProfile | null { return this.resolvedTurnProfile(); }
  /** The turn-start device-status refresh, awaited; production detaches it. */
  harnessRefreshDeviceStatus(): Promise<DeviceStatus> { return this.rt.deviceTransport.refreshStatus(); }
  setObservedSoul(text: string): void { this._cachedSoulText = text; }
  declareScaffoldPresent(): void { this._scaffoldReady = true; }
  /** The webhook signing secret, absent from the harness env by default. */
  declareWebhookRouteSecret(secret: string): void {
    Object.assign(this.env, { WEBHOOK_ROUTE_SECRET: secret });
  }
  /**
   * The container binding, absent by default: `createCFRuntime` gates `sandboxHandle` on it.
   * Declare before the actor is acquired: `ActorHostDeps.runtimeFor` memoizes one runtime per handle.
   */
  declareContainerBinding(): void {
    Object.assign(this.env, { Sandbox: { idFromName: (name: string) => name, get: () => ({}) } });
  }
  /** Deployment bindings declared after construction (AUTH_KV, preview suffix).
   *  Declare before the read: `slates` memoizes its deps on first use. */
  harnessDeclareEnv(bindings: { AUTH_KV?: KvStore; PREVIEW_HOST_SUFFIX?: string; CREDENTIAL_ENCRYPTION_KEY?: string }): void {
    Object.assign(this.env, bindings);
  }

  protected override async profileInputs() {
    const overlay = this._catalogOverlay;

    if (overlay === null) return { envelope: HARNESS_PROFILE_ENVELOPE, provider: HARNESS_PROVIDER_SNAPSHOT };

    // Merged over the builtins, digest recomputed. Overlay tier models join the
    // provider snapshot: a tier naming an unlisted model is refused before routing.
    const catalog: ProfileCatalog = {
      roles: { ...BUILTIN_PROFILE_CATALOG.roles, ...overlay.roles },
      tiers: { ...BUILTIN_PROFILE_CATALOG.tiers, ...overlay.tiers },
    };

    return {
      envelope: { ...HARNESS_PROFILE_ENVELOPE, catalog, digest: profileCatalogDigest(catalog) },
      provider: overlay.availableModels === undefined ? HARNESS_PROVIDER_SNAPSHOT : {
        ...HARNESS_PROVIDER_SNAPSHOT,
        availableModels: [...new Set([...HARNESS_PROVIDER_SNAPSHOT.availableModels, ...overlay.availableModels])],
      },
    };
  }
  /** Install roles/tiers over the builtin catalog; hosted children resolve through it. */
  harnessInstallCatalog(overlay: {
    readonly roles?: RoleCatalog;
    readonly tiers?: TierAssignments;
    readonly availableModels?: readonly string[];
  }): void {
    this._catalogOverlay = overlay;
  }
  private _catalogOverlay: {
    readonly roles?: RoleCatalog;
    readonly tiers?: TierAssignments;
    readonly availableModels?: readonly string[];
  } | null = null;
  /** Run a shell command on the workspace box as a host-stamped credential. */
  harnessBoxExec(shellId: string, command: string, cred: VfsCred): Promise<NimbusExecResult> {
    return this.workspaceBox(shellId).exec(command, { cred });
  }
  /** A cold activation: the owner row persists in SQL, in-memory latches do not. */
  forgetActivationLatches(): void {
    this._scaffoldReady = false;
    this._ownerUserId = undefined;
    this._titleCache = null;
    this._titleHydrated = false;
  }
  /** A further activation through the actor's own `onStart`. */
  activateActor(): Promise<void> { return Promise.resolve(super.onStart()); }
  harnessChatGate(): (connection: Connection, message: WSMessage) => Promise<void> {
    const gate = this.onMessage.bind(this);

    return (connection, message) => Promise.resolve(gate(connection, message));
  }
  /** The parent-side roster store; seed through it, not a hand-written INSERT. */
  harnessRoster(): SubordinateRosterStore { return this.subordinateRoster; }
  /** One auto-GEPA cadence tick, as `onTurnComplete` makes it. */
  /** One cadence tick under a named terminal tick. `pass` stands in for the real
   *  lanes, which need a live tool surface. */
  harnessOncePerTick(scope: string, tick: string, pass: () => Promise<void>): Promise<void> {
    return this.oncePerTick(scope, tick, pass);
  }

  async tickAutoGepa(): Promise<void> { await this.maybeRunAutoGepa(); }

  harnessShadowPlan(messageId: string): number | null {
    return shadowTrialPlan(this.scaffoldControl, messageId);
  }

  observeAutoGepaCadence(): number { return this.config.getAutoGepaEveryNTurns(); }
  setAutoGepaCadence(turns: number): void { this.config.setAutoGepaEveryNTurns(turns); }
  /** One auto-title round-trip through `ActorAgent.suggestTitle`. */
  harnessSuggestWorkspaceTitle(mission: string): Promise<string | null> {
    return this.suggestTitle(mission);
  }
  /** Admit one event via `publish`, the single writer of `kind='event'` rows. */
  publishHarnessEvent(descriptor: IngressDescriptor, now: number): void {
    this.eventLog.publish({ descriptor, now });
  }

  /** The background-job registry; its store owns lease epoch and resume counter policy. */
  harnessJobs(): BackgroundJobStore { return this.jobs; }
  /** The actor's SQL executor and handle, for seeding through production classes. */
  harnessSql(): SqlExecutor { return this.boundSql; }
  harnessActor(): ActorHandle { return this.actorHandle(); }
  /** One post-turn evolution lane, started exactly as a completed turn does. */
  harnessSettleEvolution(): void { this.settleEvolutionInBackground(); }
  /** One activation's alarm housekeeping: runs the interrupted-fiber scan with no client. */
  harnessAlarmHousekeeping(): Promise<void> { return this._onAlarmHousekeeping(); }

  /** Whether this session records evolution state, as `beforeTurn` would set it;
   *  the settled response records it so a recovering host cannot re-judge. */
  declareTurnEvolutionGate(): void {
    this._turnEvolutionEnabled = this.turnRecordsEvolution();
  }

  /** The user message this turn runs for; `turnWorkMode()` reads its metadata. */
  harnessDrivingUserMessage(text: string, metadata?: JsonObject): void {
    const id = `u-msg-${crypto.randomUUID().slice(0, 8)}`;
    const stamped = metadata !== undefined && Object.keys(metadata).some((key) => key !== 'kinuMode');

    // Nothing durable yet: the loop writes the user row when the driver admits the turn.
    this._drivingMessage = { id, text, metadata, stamped };
  }
  /** The user message the next admitted turn runs for, under this id and metadata. */
  private _drivingMessage: { id: string; text: string; metadata: JsonObject | undefined; stamped: boolean } | null = null;
  harnessTakeDrivingMessage(turnId: string | undefined): { id: string; text: string; metadata: JsonObject | undefined; stamped: boolean } | null {
    const message = this._drivingMessage;
    this._drivingMessage = null;

    if (message === null || turnId === undefined || turnId === message.id || message.stamped) return message;

    // The client's row is the turn's row, so it takes the turn's name.
    return { ...message, id: turnId };
  }
  /** On an idle read, a stated message no turn has taken stands in for the
   *  composer's last message, so tools listed before the turn see its mode. */
  protected override turnUserMetadata(): JsonObject | undefined {
    const stated = this._drivingMessage;

    return stated !== null && stated.metadata !== undefined ? stated.metadata : super.turnUserMetadata();
  }
  /** The tools and history the loop handed the model for the last prepared turn,
   *  before the step pipeline splices the dynamic block in. */
  private _preparedTools: ToolSet = {};
  private _prepareFailure: Error | null = null;
  /** The prepared turn's per-step dynamic block; null until prepared or after a refusal. */
  private _preparedDynamic: ((profile: ResolvedTurnProfile, tools: ToolSet) => DynamicContext) | null = null;
  private _preparedExtensions: readonly KinuExtension[] = [];
  harnessPreparedTools(): ToolSet { return this._preparedTools; }
  /** One model step's messages, composed as core's chat composes every step. */
  async harnessStep(stepNumber: number, messages: readonly ModelMessage[]): Promise<ModelMessage[]> {
    const profile = this.resolvedTurnProfile();
    const dynamic = this._preparedDynamic;

    if (profile === null || dynamic === null) throw new Error('a model step requires a prepared profile and tool surface');
    // Backend per-turn extensions, then the orchestrator's (whose prepareStep takes mid-turn steers).
    const extensions = new ExtensionHost();

    for (const extension of this._preparedExtensions) extensions.register(extension);
    extensions.register(this.orch.turnExtension);

    const result = await composePrepareStep(
      {
        extensions,
        dynamic: { ledger: this.actorSession.dynamic, snapshot: () => dynamic(profile, this._preparedTools) },
        // The destination provider a cross-provider replay is re-keyed at.
        destinationProviderId: this.promptModelContext().provider,
      },
      { stepNumber, messages: [...messages], steps: [] },
    );

    return result?.messages ?? [...messages];
  }
  harnessAdmittedHistory(): readonly ModelMessage[] { return [...this.actorSession.history]; }
  harnessTakePrepareFailure(): Error | null {
    const failure = this._prepareFailure;
    this._prepareFailure = null;

    return failure;
  }
  /** Told each lease the loop hands a preparation (ids and abort signal). */
  private readonly _leaseObservers: Array<(lease: ActorTurnLease) => void> = [];
  harnessObserveLease(observe: (lease: ActorTurnLease) => void): void { this._leaseObservers.push(observe); }
  protected override async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease): Promise<PreparedTurn> {
    for (const observe of this._leaseObservers) observe(lease);
    this._prepareFailure = null;

    try {
      const prepared = await super.prepareTurn(item, lease);
      this._preparedTools = prepared.execution.chat.tools ?? {};
      this._preparedDynamic = prepared.execution.dynamic;
      this._preparedExtensions = prepared.execution.extensions;

      return prepared;
    } catch (error) {
      this._prepareFailure = error instanceof Error ? error : new Error(String(error));
      this._preparedDynamic = null;
      throw error;
    } finally {
      // Handed to one turn only.
      this._suppliedTools = null;
    }
  }
  /** A tool surface replacing the actor's own for the requested mode; a rebuild
   *  for another mode (a role imposing Plan) is the actor's own. */
  private _suppliedTools: ToolSet | null = null;
  harnessSupplyTools(tools: ToolSet | undefined): void { this._suppliedTools = tools ?? null; }
  protected override getRawToolsForWorkMode(mode: WorkMode, claimScope?: string): ToolSet {
    // The requested mode is the message's, never the operation a role bound over it.
    if (this._suppliedTools !== null && mode === workModeForTurnMetadata(this.turnUserMetadata())) return this._suppliedTools;

    return super.getRawToolsForWorkMode(mode, claimScope);
  }

  /** The scripted model the next turns run on; held, not consumed by one turn. */
  harnessSupplyTurnModel(model: LanguageModel): void {
    const factory = () => model;
    Object.defineProperty(this, 'modelFactory', { configurable: true, value: factory });
    const turn = () => model;
    Object.defineProperty(this, 'turnModel', { configurable: true, value: turn });
  }
  harnessFleetTurnRows(): FleetPoint[] {
    return fleetPlaneForTest(this.env).agent.points.map((point) => ({ ...point }));
  }
  /** Resolves once the fleet dataset holds a row: the write is the signal. */
  harnessFleetRowWritten(): Promise<void> {
    return fleetPointWritten(this.env, (points) => points.length > 0);
  }
  /** Open the fleet plane's write window. No-op unless the actor was built over
   *  `fleetEnvForTest(makeEnv())`: the plane memoises on the env object. */
  harnessOpenFleetWindow(): void {
    openAnalyticsWindowForTest(this.env);
  }
  /** The live turn's step boundary, on the extension host production composes. */
  async harnessStepInto(stepNumber: number, messages: readonly ModelMessage[]): Promise<ModelMessage[]> {
    return this.harnessStep(stepNumber, messages);
  }

  /** Marks the turn running for `BackendHost.turnInFlight`, routing signals into the
   *  live turn's next step; production sets it in `beforeTurn`. `settleTurnEvents` clears it. */

  /** The persisted identity a fresh activation uses to stop old device work. */
  async harnessPersistActiveTurn(turnId: string): Promise<void> {
    const history = this.actorSession.canonical;
    const context = history.context.selected() ?? history.context.initialize();
    await this.claims.admit({
      runId: 'harness-' + turnId, turnId, workMode: 'build',
      program: { kind: 'builtin', version: 0, digest: null, build: null },
      context,
    });
  }

  harnessDurableTurnId(): string | null { return this.durableTurnId(); }
  /** Replace the delivery seam; signal policy and terminal ledger stay real. */
  harnessSetSignalDeliverer(
    deliver: (signal: AgentSignal) => Promise<SendOutcome>,
  ): void {
    Object.defineProperty(this.orch.inbox, 'send', {
      configurable: true,
      value: deliver,
    });
  }



  /** The terminal transition bracket via production's entry points. A transition
   *  names the durable turn and the response, so a Think auto-continuation gets its own sequence. */
  harnessBeginTerminalTransition(turnId: string | null, messageId = 'a-1') {
    return this.terminal.begin(turnId === null ? null : { turnId, messageId });
  }

  harnessEndTerminalTransition(turnId: string | null, messageId = 'a-1'): void {
    this.terminal.end(turnId === null ? null : { turnId, messageId });
  }

  /** Effect-claim rows for a terminal transition: null result is interrupted, no row is released. */
  harnessTerminalClaims(): Array<{ turn_id: string; call_id: string; result_json: string | null }> {
    // Transition rows only: the table also holds tool claims and per-effect markers.
    return this.sql<{ turn_id: string; call_id: string; result_json: string | null }>`
      SELECT turn_id, normalized_call_id AS call_id, result_json
      FROM tool_effect_claims WHERE normalized_call_id LIKE 'terminal:response:%'
      ORDER BY turn_id, normalized_call_id`;
  }

  /** Every per-effect disposition row of one sequence, in declared order. */
  harnessTerminalEffects(turnId: string, messageId = 'a-1'): Array<{
    effect_key: string; status: string; outcome: string | null; attempts: number;
  }> {
    return this.sql<{ effect_key: string; status: string; outcome: string | null; attempts: number }>`
      SELECT effect_key, status, outcome, attempts FROM terminal_effects
      WHERE sequence_id = ${this.terminal.sequenceId({ turnId, messageId })}
      ORDER BY seq, effect_key`;
  }

  /** Arm a deterministic cut in the terminal sequence: which effect, before or after its side effect. */
  harnessArmTerminalFault(
    name: TerminalEffectName, phase: TerminalEffectPhase, scope?: string,
  ): void {
    this.terminalEffectFault = (atPhase, atName, atScope) => {
      if (atName !== name || atPhase !== phase) return;

      if (scope !== undefined && atScope !== scope) return;
      throw new TerminalEffectInterrupt(atPhase, atName, atScope);
    };
  }

  harnessDisarmTerminalFault(): void { this.terminalEffectFault = null; }

  /** Move the ledger's clock past a pending row's backoff, so a replay is due. */
  harnessAdvanceTerminalClock(ms: number): void { this._terminalClockSkewMs += ms; }

  /** Turn off the between-turn compute lane via the production config switch: its
   *  effect keeps the row owed until the compute lands, and no model is behind the harness. */
  harnessDisableSleepTimeCompute(): void { this.config.setSleepTimeComputeEnabled(false); }

  /** Turn the lane back on with its answer already persisted, the state a first
   *  attempt leaves; `key` is the effect scope the terminal row carries. */
  harnessRecordSleepTimeAnswer(key: string, update: SleepTimeUpdate): void {
    this.config.setSleepTimeComputeEnabled(true);
    void this.sql`INSERT INTO sleep_time_updates (effect_key, update_json, created_at)
      VALUES (${key}, ${JSON.stringify(update)}, ${Date.now()})
      ON CONFLICT(effect_key) DO NOTHING`;
  }

  /** Turn the lane on behind a scripted fast model (`rt.fastLlm ?? rt.llm`) answering
   *  `answer`; returns the prompts it received. */
  harnessScriptSleepTimeModel(answer: SleepTimeUpdate, prompts: string[]): void {
    this.config.setSleepTimeComputeEnabled(true);

    Object.defineProperty(this.rt, 'fastLlm', {
      configurable: true,
      value: {
        stream: async function* () { yield ''; },
        complete: async (prompt: string) => {
          prompts.push(prompt);

          return JSON.stringify(answer);
        },
      },
    });
  }

  /** The world-model store, through its own API rather than an INSERT. */
  harnessFacts(): FactsStore { return this.facts; }
  /** The scaffold's tool bridge for one shadow-trial rollout, with the trial's scope. */
  harnessScaffoldCallTool(callScope?: string) {
    return this.makeScaffoldCallTool(callScope);
  }

  /** Declare one steer branch in flight, as `steerAsBranch` does. The handle never
   *  settles: a rejected one would be an unhandled rejection on creation. */
  /**
   * Spawn one branch head through `startBranchHead`, so its journal rows are production's:
   * the head is journalled under `branchHeadId(runId)`, not the run id. `report` null
   * leaves it running; the head actor is registered as `hostHead` does.
   */
  async harnessSpawnBranchHead(
    id: string, task: string,
    report: Pick<HeadReport, 'status' | 'summary' | 'errorMessage'> | null,
  ): Promise<void> {
    const runtime: HeadRuntime = {
      spawnHead: async (input: HeadInput) => {
        // The `exp:`-marked name `hostHead` registers; a head has no database of its own.
        await this.actorDirectory({ action: 'register', creationId: input.id, name: `exp:${input.id}`, kind: 'head', lifetime: 'task' });

        return {
          id: input.id,
          run: async () => {
            if (report === null) return new Promise<HeadReport>(() => { /* never reports */ });

            const reported: HeadReport = {
              id: input.id, status: report.status, summary: report.summary,
              evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
              toolCalls: [], stepCount: 1, usage: {}, wallClockMs: 1,
            };

            return report.errorMessage === undefined
              ? reported
              : { ...reported, errorMessage: report.errorMessage };
          },
          abort: async () => { await Promise.resolve(); },
        };
      },
      mergeLLM: () => { throw new Error('a steer branch is one head and never merges'); },
    };

    const handle = await startBranchHead(runtime, this.headJournal, { id, task, inheritedContext: [] });

    if (report !== null) await handle.result;
  }

  /** Record one branch head as reported, in the journal a cold replay reads. */
  async harnessRecordBranchReport(id: string, task: string, summary: string): Promise<void> {
    await this.harnessSpawnBranchHead(id, task, { status: 'completed', summary });
  }

  /** Land the report of a head spawned by {@link harnessSpawnBranchHead} with none. */
  harnessReportBranchHead(id: string, summary: string): void {
    this.headJournal.recordReport({
      id: branchHeadId(id), status: 'completed', summary,
      evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
      toolCalls: [], stepCount: 1, usage: {}, wallClockMs: 1,
    });
  }

  /** The journalled status of a branch run's single head, or null. */
  harnessBranchHeadStatus(id: string): string | null {
    return this.headJournal.readHeadView(branchHeadId(id))?.status ?? null;
  }

  /** Mark every head spawned so far `interrupted`, via the journal's cold-activation
   *  transition; the bound excludes heads seeded after this call. */
  harnessMarkHeadsInterrupted(): void {
    this.headJournal.markInterrupted({ spawnedBefore: Date.now() + 1 });
  }

  /** The exploration reclamation pass `onStart` detaches, awaited. */
  harnessReclaimSettledExplorationActors(): Promise<void> {
    return this.reclaimSettledExplorationActors();
  }

  /** The exploration actors this workspace still holds, read through the directory. */
  harnessExplorationActors(): string[] {
    return this.actorDirectoryStore().list()
      .filter((record) => record.kind === 'head' || record.kind === 'branch')
      .map((record) => record.name);
  }

  observeActorHost(): ActorHost { return this.actorHost(); }
  /** The seams the production head runtime and node seat factory are built from. */
  observeExplorationSeams(): ExplorationHostSeams { return this.explorationSeams(); }

  /** The profile one hosted actor's turn resolves under (`resolveProfile`). */
  observeHostedActorProfile(actor: HostedActor, workMode: WorkMode = 'build'): Promise<ResolvedTurnProfile> {
    return this.hostedActorProfile({ actor: actor.handle, availableTools: [], workMode })
      .then((resolved) => resolved.profile);
  }

  /** A hired child's delegated-turn profile, captured inside `runHostedTask` so it is
   *  the one the turn got. The turn then fails at the model under bun; the profile is built first. */
  async observeHostedTaskProfile(child: HostedActor, task: string): Promise<HostedTaskProfile> {
    const seams = this.subordinateSeams();
    // An empty array means the runner never reached its profile seam.
    const built: HostedTaskProfile[] = [];
    await runHostedTask({
      ...seams,
      taskProfile: async (turn) => {
        const profile = await seams.taskProfile(turn);
        built.push(profile);

        return profile;
      },
    }, child.reference, { body: task, mode: 'build', sequenceId: crypto.randomUUID() });
    const [profile] = built;

    if (profile === undefined) throw new Error('the delegated turn never built its profile');

    return profile;
  }

  /** Drive one delegated task turn through the production runner with an injected
   *  model. No `input` member: the runner builds its own HeadInput. */
  async runHostedTaskTurn(child: HostedActor, task: string) {
    return runHostedTask(this.subordinateSeams(), child.reference, {
      body: task,
      mode: 'build',
      sequenceId: crypto.randomUUID(),
    });
  }

  /** Instance-level seam override: under bun the owned model services have no
   *  provider; everything downstream of resolution is production's. */
  overrideProviderRegistry(registry: AgentProviderRegistry): void {
    Object.assign(this.ownedModelServices, { providerRegistry: (): AgentProviderRegistry => registry });
  }

  /** Forget the live handles, leaving only the durable journal. */
  harnessDropPendingBranches(): void { this._pendingBranches.length = 0; }

  harnessDeclarePendingBranch(id: string, task: string): void {
    this._pendingBranches.push({
      id, task,
      handle: new Promise(() => { /* the harness runs no branch heads */ }),
    });
  }

  /** A branch whose head already answered: settles through the handle, not the journal. */
  harnessDeclareLiveBranch(id: string, task: string, summary: string): void {
    this._pendingBranches.push({
      id, task,
      handle: Promise.resolve({
        id, task,
        // A real head's report carries the head id derived from the run id.
        result: Promise.resolve({
          id: branchHeadId(id), status: 'completed' as const, summary,
          evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
          toolCalls: [], stepCount: 1, usage: {}, wallClockMs: 1,
        }),
        abort: async () => { await Promise.resolve(); },
      }),
    });
  }

  /** The most recent terminal sequence's join, resolved once its disposition is written. */
  harnessTerminalReported(): Promise<void> { return this._terminalReported; }
  /** Every programmatic turn the loop was asked to admit through the host. */
  readonly harnessEnqueued: ProgrammaticTurn[] = [];
  protected override get host(): BackendHost {
    const base = super.host;

    return {
      ...base,
      enqueueTurn: (input) => {
        this.harnessEnqueued.push(input);

        return base.enqueueTurn(input);
      },
    };
  }
  /** Script the loop's next programmatic admissions, one answer per call; once
   *  exhausted the loop answers again. Every admission is recorded. */
  private readonly _scriptedAdmissions: Array<() => Promise<EnqueueTurnResult>> = [];
  readonly harnessAdmissionsAsked: ProgrammaticTurn[] = [];
  harnessScriptAdmissions(answers: Array<() => Promise<EnqueueTurnResult>>): void {
    this._scriptedAdmissions.push(...answers);
    const loop = this.chatLoop;
    const admit = ChatSession.prototype.enqueueTurn.bind(loop);
    Object.defineProperty(loop, 'enqueueTurn', {
      configurable: true,
      value: async (input: ProgrammaticTurn): Promise<EnqueueTurnResult> => {
        this.harnessAdmissionsAsked.push(input);
        const scripted = this._scriptedAdmissions.shift();

        return scripted === undefined ? admit(input) : scripted();
      },
    });
  }
  get harnessPlanReviews(): PlanReviewStore { return this.stores.planReviews; }
  /** Refuse every send with "this process may not drive" until disarmed. */
  private _driverRefusal: Refusal | null = null;
  harnessRefuseDriving(refusal: Refusal | null): void { this._driverRefusal = refusal; }
  protected override driverGate(): Refusal | null { return this._driverRefusal; }

  /** The wake arm that resumes the loop after a restart. */
  harnessResumeChatLoop(): void { this.resumeChatLoop(); }

  /** Rebuild the user queue from SQL via the loop's `restorePendingSends`, after
   *  dropping the in-memory queue as a reset does. */
  harnessRestorePendingSteers(turnId: string): void {
    this.orch.inbox.interrupt();

    const store = new PendingSendStore(this.boundSql, this.actorHandle().actorId);

    const pending = store.forTurn(turnId).map((row) => {
      const files = store.files(row.id);

      return files.length > 0 ? { ...row, files } : row;
    });

    this.orch.inbox.restorePending(pending);
  }

  /** The run ledger: an open run is a response that started and has not finished. */
  get harnessEventRecorder(): RunEventRecorder { return this.eventRecorder; }

  /** How many terminal sequences this activation currently owns. */
  harnessSequencesInFlight(): number { return this.terminal.inFlightCount; }

  /** The pass finishing interrupted terminal transitions, awaited; production detaches it. */
  harnessResumeTerminalTransitions(): Promise<void> {
    return this.terminal.resumeAll();
  }

  /** Whether this workspace owes a wake, as `onStart` classifies it. */
  harnessOwedWorkExists(): boolean {
    return this.owedWorkExists();
  }

  /** The budget-first interrupted-fiber prune, as `onStart` runs it. */
  harnessSweepUnrecoverableFibers(): void {
    this.sweepUnrecoverableFiberRows();
  }

  /** The recovery hook's decision, which the scan hides. */
  harnessRecoverFiber(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    return this.onFiberRecovered(ctx);
  }

  /** The improvement lanes, through the claimed effect production uses; returns
   *  whether the lanes were open. */
  async harnessSettleSpine(
    input: { status: RunEndReason; turn: CompletedTurn; workMode?: WorkMode },
  ): Promise<boolean> {
    const lanes = this.terminalEffectTable().improvement_lanes;

    if (lanes === undefined) return false;

    const outcome = await lanes.run({
      status: input.status,
      turn: projectJsonValue({ value: input.turn }),
      workMode: input.workMode ?? this.turnWorkMode(),
      advisor: projectJsonValue({ value: this.advisorSnapshotFor(input.turn, Object.keys(this.harnessPreparedTools())) }),
    }, input.turn.turnId ?? '');

    return outcome.status === 'completed' && outcome.detail === undefined;
  }

  /** Enable the advisor via its durable config row and script the reviewer. */
  harnessAdvisorsOn(reviewReply: string): void {
    this.config.setAdvisorEnabled(true);
    Object.defineProperty(this.rt, 'advisorLlm', {
      value: {
        stream: async function* () { yield ''; },
        complete: async () => reviewReply,
      },
      configurable: true,
    });
  }

  /** Script the review model and run one turn review, as the deferred lane does;
   *  classifier and reflection are both `fastLlm` completions. */
  async harnessReviewTurn(turn: CompletedTurn, followup: string): Promise<void> {
    Object.defineProperty(this.rt, 'fastLlm', {
      configurable: true,
      value: {
        stream: async function* () { yield ''; },
        complete: async (prompt: string) => prompt.includes('reflection')
          ? 'the answer skipped the constraint the question named'
          : '{"outcome":"corrected","confidence":0.9,"evidence":"the user restated it"}',
      },
    });
    await this.engine.reviewTurn(turn, followup);
  }

  harnessAdvisorNotes(): number {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM evolution_events
      WHERE type = 'advisor_note'`[0]?.n ?? 0;
  }

  /** Drive the post-turn MCP warm lane with a real `workspace_capability` row and the
   *  `env.UserDO` hub. The join is harness-local: production never waits on the warm. */
  async harnessWarmUserMcp(): Promise<void> {
    this.warmUserMcpInBackground();
    await (this._mcpWarmTask?.promise ?? Promise.resolve());
  }

  /** Issue the workspace capability token as a claim does: one row. */
  harnessHoldsCapability(token: string): void {
    void this.sql`INSERT OR REPLACE INTO workspace_capability (id, token) VALUES (1, ${token})`;
  }

  /** The pre-claim state: a workspace whose capability has not been issued. */
  harnessHoldsNoCapability(): void {
    void this.sql`DELETE FROM workspace_capability`;
  }

  harnessJoinDetachedFibers(): Promise<void> { return joinHarnessFibers(); }

  /** Join the activation's detached tasks (timer, event-delivery and fork-journal
   *  reconciles, facet reclaim), which production never waits on. */
  harnessSettleBackgroundTasks(): Promise<void> { return this.settleBackgroundTasks(); }

  /** When the ledger would next wake, given the sequences a live activation claims. */
  harnessNextRetryAt(inFlight: ReadonlySet<string>): number | null {
    return this.terminal.ledger.nextRetryAt(inFlight);
  }

  harnessSequenceId(turnId: string, messageId: string): string {
    return this.terminal.sequenceId({ turnId, messageId });
  }

  harnessOpenFiberRows(): { id: string; name: string }[] {
    return this.sql<{ id: string; name: string }>`SELECT id, name FROM cf_agents_runs ORDER BY created_at`;
  }

  /** Advisor notes recorded for one turn, counted from storage because the guard reads storage. */
  harnessNotesForTurn(turnId: string): number {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM evolution_events
      WHERE type = 'advisor_note' AND json_extract(data, '$.turnId') = ${turnId}`[0]?.n ?? 0;
  }
  harnessSeedOrphanFiber(name: string, snapshot: JsonValue): string {
    return seedOrphanFiberRow(this.ctx.storage, name, snapshot);
  }
  /** One tool call's claim via core, unsettled: the state a still-executing turn
   *  leaves, which a turn-wide release must not walk over. */
  harnessClaimTool(turnId: string, callId: string): void {
    claimToolEffect(this.boundSql, this.actorHandle(), { turnId, callId, digest: 'harness-tool-digest' });
  }
  /** One turn's tool claims by call id (terminal rows: `harnessTerminalClaims`). */
  harnessToolClaims(turnId: string): string[] {
    return this.sql<{ call_id: string }>`
      SELECT normalized_call_id AS call_id FROM tool_effect_claims
      WHERE turn_id = ${turnId} AND normalized_call_id NOT LIKE 'terminal:response:%'
      ORDER BY normalized_call_id`.map((row) => row.call_id);
  }
  /** The per-step dynamic context, via core's assembler over this actor's stores. */
  observeDynamicContext(): DynamicContext {
    return this.dynamicContextSnapshot({ workMode: 'build', allowedTools: [] }, {}, undefined);
  }
}

/** The workspace's files as a fork reaches them: core's parent adapter over the object's public
 *  workspace RPC, so a suite reads and writes the object's own file plane through a door it has. */
export function workspaceFiles(agent: HarnessOrchestratorAgent): VFS {
  return createParentWorkspaceVfs({
    read: (path) => agent.readWorkspaceFile(path),
    write: (input) => agent.writeWorkspaceFile(input),
    list: (path) => agent.listWorkspaceFiles(path),
    stat: (path) => agent.statWorkspaceFile(path),
    delete: (path) => agent.deleteWorkspaceFile(path),
    exec: (command) => agent.execWorkspaceCommand(command),
  });
}

/** One event-loop turn, with no duration: queued I/O callbacks and detached continuations run first. */
export function nextTurn(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * Yields to the event loop, joining fibers each lap, until `holds()` reads true in what the object
 * stored. Detached work is observed by its effect, the way an operator would see it; a condition
 * that never holds fails by name after 1000 laps rather than hanging.
 */
export async function until(holds: () => boolean, what: string): Promise<void> {
  for (let lap = 0; lap < 1000; lap++) {
    if (holds()) {
      await joinHarnessFibers();

      return;
    }

    await joinHarnessFibers();
    await nextTurn();
  }

  throw new Error(`${what}: never held after 1000 event-loop laps`);
}

/**
 * Core's terminal ledger over the object's stored rows: a seed writes a claim the way a prior
 * activation left it, and `begin` on a closed sequence answers `done` without writing. The object's
 * own instance is never reached.
 */
export function ledgerOver(db: Database): TerminalTransitions {
  return new TerminalTransitions({
    actor: workspaceMainActor(db), sql: sqlOver(db), effects: {}, now: () => Date.now(),
    scheduleRetry: async () => {},
  });
}

/** The canonical conversation over the object's stored rows, for transcript a prior turn left. */
export function historyOver(harness: ActorHarness<HarnessOrchestratorAgent>): SessionHistory {
  return new SessionHistory({
    sql: sqlOver(harness.db), actor: workspaceMainActor(harness.db), transactionSync: (write) => write(),
    files: async () => ({ vfs: workspaceFiles(harness.agent), artifactDirectory: '/actor/.kinu/context' }),
  });
}

/** A settled response's improvement-lanes effect ran: its row completed, or the whole terminal
 *  sequence closed and pruned it. Other effects of the sequence may still be owed. */
export function improvementLanesRan(db: Database, messageId: string): boolean {
  const effect = db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM terminal_effects WHERE effect_name = 'improvement_lanes' AND sequence_id LIKE ? AND status = 'completed'",
  ).get(`%/${messageId}`)?.n === 1;

  const closed = db.query<{ n: number }, [string]>(
    'SELECT COUNT(*) AS n FROM tool_effect_claims WHERE normalized_call_id = ? AND result_json IS NOT NULL',
  ).get(`terminal:response:${messageId}`)?.n === 1;

  return effect || closed;
}

/** Loggers suites record with. A settle swaps in its own sink to catch close failures, and forwards to these. */
const diagnosticTaps = new Set<Logger>();

/** Records diagnostics into `logger` until the returned restore, across settles too. */
export function tapDiagnostics(logger: Logger): () => void {
  diagnosticTaps.add(logger);
  const restore = setDiagnosticsSink(logger);

  return () => {
    diagnosticTaps.delete(logger);
    restore();
  };
}

/** The workspace's main actor as its durable identity rows name it, read through core's directory. */
export function workspaceMainActor(db: Database): ActorHandle {
  return openWorkspaceMainActor(sqlOver(db));
}

/** A candidate under trial, seeded under `runtime.actor`: the pointer is per-actor. */
export function declareShadowCandidate(db: Database): void {
  const actor = workspaceMainActor(db);
  actor.config.setShadowSampleRate(0.5);
  void sqlOver(db)`INSERT OR REPLACE INTO scaffold_versions
    (actor_id, version, written_at, rationale, status)
    VALUES (${actor.actorId}, 1, ${Date.now()}, 'a harness candidate', 'pending')`;
}

/** An actor's stored naming state: the two rows `planWorkspaceTitle` decides from. */
export interface ObservedNaming {
  displayName: string | null;
  nameOrigin: 'user' | 'auto' | null;
}

/** A hosted actor as a suite drives it: the production `HostedActor` from the
 *  workspace's `ActorHost`, sharing its one database. */
export interface HostedActorHarness {
  readonly actor: HostedActor;
  readonly workspace: ActorHarness<HarnessOrchestratorAgent>;
}

/** The side model for routed work when the suite scripted none: one empty completion. */
const SILENT_SIDE_MODEL: LanguageModel = scriptedTurnModel({
  doGenerate: () => ({
    content: [{ type: 'text', text: '' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: 0, reasoning: undefined } },
    warnings: [],
  }),
});

interface RecordedCall {
  readonly request: ScriptedTurnOptions;
  readonly model: LanguageModel;
  readonly identity: SettledTurn;
  readonly tools: ToolSet;
  readonly history: readonly ModelMessage[];
}

function requestView({ request, model, identity, tools, history }: RecordedCall): PreparedRequest {
  const system = request.prompt.filter((message) => message.role === 'system')
    .map((message) => message.content).join('\n');

  return {
    identity,
    // The history the loop was started with, before the dynamic block is spliced in.
    messages: history,
    prompt: promptToModelMessages(request.prompt.filter((message) => message.role !== 'system')),
    system: system === '' ? undefined : system,
    model,
    tools,
    activeTools: request.tools?.map((tool) => tool.name),
    providerOptions: request.providerOptions,
  };
}

/** A message of the SDK prompt, system excluded (read via `system`). */
type PromptMessage = Exclude<ScriptedTurnOptions['prompt'][number], { role: 'system' }>;

function promptToModelMessages(prompt: readonly PromptMessage[]): ModelMessage[] {
  return prompt.flatMap((message): ModelMessage[] => {
    switch (message.role) {
      case 'user':
        return [{ role: 'user', content: message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('') }];

      case 'assistant': {
        const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');

        const calls = message.content.flatMap((part) => part.type === 'tool-call'
          ? [{ type: 'tool-call' as const, toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }]
          : []);

        return [calls.length === 0 ? { role: 'assistant', content: text } : { role: 'assistant', content: [{ type: 'text', text }, ...calls] }];
      }

      case 'tool':
        return [{
          role: 'tool',
          content: message.content.flatMap((part) => part.type === 'tool-result'
            ? [{ type: 'tool-result' as const, toolCallId: part.toolCallId, toolName: part.toolName, output: part.output }]
            : []),
        }];
    }
  });
}

/** One parked turn: its model request and the gate the scripted answer opens. */
interface ParkedTurn {
  readonly request: PreparedRequest;
  readonly answer: ReturnType<typeof Promise.withResolvers<ScriptedAnswer>>;
  readonly landed: Promise<SendLanding>;
  readonly identity: SettledTurn;
}

const parkedTurns = new WeakMap<HarnessOrchestratorAgent, ParkedTurn>();

/** The turn id the next admission runs under, when a suite named one. */
const openedTurns = new WeakMap<HarnessOrchestratorAgent, string>();

/** Model factories this seam installed, told apart from a suite's own. */
const seamFactories = new WeakSet<() => LanguageModel>();

/**
 * The turn seam over the root's real ChatSession: `prepare` admits a send and parks
 * at the first model call; `settle` scripts the answer. Rows read after are the loop's own.
 */
export function chatSessionTurns(agent: HarnessOrchestratorAgent): TurnHarness {
  /** Parks on its first call until scripted, then answers every call with the same text. */
  const parkingModel = (arrived: ReturnType<typeof Promise.withResolvers<ScriptedTurnOptions>>, answer: Promise<ScriptedAnswer>): LanguageModel => {
    let calls = 0;

    const usage: ScriptedTurnResult['usage'] = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };

    const script = async (options: ScriptedTurnOptions): Promise<ScriptedAnswer> => {
      calls += 1;

      if (calls === 1) arrived.resolve(options);
      const scripted = await answer;

      if ((scripted.status ?? 'completed') === 'error') throw new Error(scripted.error ?? 'scripted error');

      return scripted;
    };

    const textOf = (scripted: ScriptedAnswer): string =>
      scripted.text ?? scripted.parts?.flatMap((part) => part.type === 'text' ? [part.text] : []).join('') ?? '';

    return new MockLanguageModelV3({
      provider: 'fake',
      modelId: 'fake-model',
      doGenerate: async (options) => {
        const scripted = await script(options);

        if (scripted.status === 'aborted') {
          agent.harnessChatLoop.stop();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }

        return {
          content: [{ type: 'text', text: textOf(scripted) }],
          finishReason: { unified: scripted.finishReason ?? 'stop', raw: undefined },
          usage, warnings: [],
        };
      },
      // Streamed, so a cut answer is its streamed text followed by the abort.
      doStream: async (options) => {

        const scripted = await script(options);
        const text = textOf(scripted);
        const parts: ModelStreamPart[] = [{ type: 'stream-start', warnings: [] }];

        if (text !== '') parts.push({ type: 'text-start', id: 'p0' }, { type: 'text-delta', id: 'p0', delta: text }, { type: 'text-end', id: 'p0' });

        if (scripted.status !== 'aborted') {
          parts.push({ type: 'finish', finishReason: { unified: scripted.finishReason ?? 'stop', raw: undefined }, usage });

          return { stream: convertArrayToReadableStream(parts) };
        }

        return {
          stream: new ReadableStream<ModelStreamPart>({
            pull(controller) {
              const next = parts.shift();

              if (next !== undefined) {
                controller.enqueue(next);

                return;
              }

              // The cut a Stop makes, which keeps queued steers queued.
              return agent.harnessDelivered(text).then(() => {
                agent.harnessChatLoop.stop();
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              });
            },
          }),
        };
      },
    });
  };

  /** Admit a turn under the suite's named ids and park it at its first model call. */
  const admit = async (text: string, answerId: string | undefined, signal?: AbortSignal): Promise<ParkedTurn> => {
    const arrived = Promise.withResolvers<ScriptedTurnOptions>();
    const answer = Promise.withResolvers<ScriptedAnswer>();
    const model = parkingModel(arrived, answer.promise);
    const factory = () => model;
    seamFactories.add(factory);
    agent.modelFactory = factory;

    if (answerId !== undefined) agent.harnessNameNextAnswer(answerId);
    const driving = agent.harnessTakeDrivingMessage(openedTurns.get(agent));
    const turnId = openedTurns.get(agent) ?? driving?.id;
    openedTurns.delete(agent);
    const drivingMode = v.safeParse(v.string(), driving?.metadata?.kinuMode);
    const chosenMode = drivingMode.success && isWorkMode(drivingMode.output) ? drivingMode.output : undefined;

    // A stamped message (`kinuEvent`) is a programmatic turn admitted through the queue;
    // a client's message is admitted under its own id and mode.
    const waiter = Promise.withResolvers<SendLanding>();
    // A message to an in-flight turn is a steer: its admission is all a preparation sees.
    const steer = driving?.stamped !== true && agent.harnessChatLoop.turnInFlight();

    const admitted: Promise<void> = driving?.stamped === true
      ? agent.harnessEnqueueTurn({ text: driving.text, metadata: driving.metadata ?? {} }).then(() => agent.harnessChatLoop.pumpPromise).then(() => { waiter.resolve('turn'); })
      : agent.harnessChatLoop.admit(text, { ...(chosenMode !== undefined && { mode: chosenMode }), ...(turnId !== undefined && { id: turnId }) }, waiter);

    const landed: Promise<SendLanding> = admitted.then(() => waiter.promise);
    // A refused admission is an outcome the suite reads, not an unhandled rejection.
    const refused = (error: Error) => ({ refused: toKinuError({ doing: 'admitting the turn the suite asked for', cause: error, otherwise: 'unavailable' }) });
    const landing = landed.then((value) => ({ landing: value }), refused);

    const outcome = await Promise.race([
      arrived.promise.then((request) => ({ request })),
      ...(steer ? [admitted.then(() => ({ admitted: true as const }), refused)] : []),
      landing,
    ]);

    if ('refused' in outcome) throw outcome.refused;

    if ('landing' in outcome && outcome.landing === 'turn') {
      // No model call: a refused preparation surfaces as the rejection it was.
      await agent.harnessChatLoop.pumpPromise;
      const failure = agent.harnessTakePrepareFailure();

      if (failure !== null) throw failure;
    }

    const request = 'request' in outcome ? outcome.request : null;
    const started = agent.harnessLastTurnStart();
    const identity: SettledTurn = started ?? { turnId: turnId ?? '', messageId: answerId ?? '' };

    if (signal?.aborted) {
      // A cut admission: the prepared turn is refused and rejects with the cut's reason.
      answer.resolve({ messageId: identity.messageId, status: 'aborted' });
      await landing;
      await agent.harnessChatLoop.pumpPromise;
      throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'the preparation was cut'));
    }

    const parked = {
      request: request === null
        ? { identity, messages: [], prompt: [], system: undefined, model, tools: {}, activeTools: undefined, providerOptions: undefined }
        : requestView({ request, model, identity, tools: agent.harnessPreparedTools(), history: agent.harnessAdmittedHistory() }),
      answer, landed, identity,
    };

    parkedTurns.set(agent, parked);

    return parked;
  };

  /** Settle the parked turn and run the pump. A turn the loop could not close
   *  rejects (the loop names a close failure as a diagnostic); a scripted error answer settles. */
  const finish = async (parked: ParkedTurn, answer: ScriptedAnswer): Promise<SettledTurn> => {
    const closeFailures: string[] = [];

    // A fresh console logger, never the `diagnostics` proxy: it forwards to this composite. A suite's
    // tap still hears what the settle reports.
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), ...diagnosticTaps, {
      event: () => {},
      failure: (name, error) => {
        // The interrupted effect's cause, not the loop's wrapper.
        if (name === 'turn.persist_failed' || name === 'turn.finalization_failed') closeFailures.push(renderCauseChain(error));
      },
    }]));

    try {
      parked.answer.resolve(answer);
      await parked.landed;
      await agent.harnessChatLoop.pumpPromise;
    } finally {
      restore();
    }

    const failure = closeFailures[0];

    if (failure !== undefined) throw new Error(failure);

    return parked.identity;
  };

  return {
    async run(text, options) {
      const installed = agent.modelFactory;

      // A suite-installed model runs the turn; the seam scripts 'ok' only when none was supplied.
      if (installed !== undefined && !seamFactories.has(installed)) {
        const landing = await agent.harnessChatLoop.send(text);
        await agent.harnessChatLoop.pumpPromise;
        const last = (await agent.harnessTranscript.history()).at(-1);

        return { status: landing === 'turn' ? 'completed' : 'skipped', message: last?.role === 'assistant' ? last : undefined };
      }

      const parked = await admit(text, undefined, options?.signal);
      parked.answer.resolve({ messageId: parked.identity.messageId, text: 'ok' });
      const landing = await parked.landed;
      await agent.harnessChatLoop.pumpPromise;
      const last = (await agent.harnessTranscript.history()).at(-1);

      return { status: landing === 'turn' ? 'completed' : 'skipped', message: last?.role === 'assistant' ? last : undefined };
    },

    async enqueue(text, options) {
      await agent.harnessEnqueueTurn({
        text,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        ...(options?.metadata !== undefined && { metadata: options.metadata }),
      });
    },

    async drainEnqueued() {
      await agent.harnessChatLoop.pumpPromise;
    },

    async runQueuedMessage() {
      await agent.harnessChatLoop.pumpPromise;
    },

    async park() {
      const arrived = Promise.withResolvers<ScriptedTurnOptions>();
      const answer = Promise.withResolvers<ScriptedAnswer>();
      const model = parkingModel(arrived, answer.promise);
      const factory = () => model;
      seamFactories.add(factory);
      agent.modelFactory = factory;
      const request = await arrived.promise;
      const started = agent.harnessLastTurnStart();
      const identity: SettledTurn = started ?? { turnId: '', messageId: '' };
      const landed: Promise<SendLanding> = (agent.harnessChatLoop.pumpPromise ?? Promise.resolve()).then(() => 'turn' as const);

      const parked: ParkedTurn = {
        request: requestView({ request, model, identity, tools: agent.harnessPreparedTools(), history: agent.harnessAdmittedHistory() }),
        answer, landed, identity,
      };

      parkedTurns.set(agent, parked);

      return parked.request;
    },

    async resume() {
      const arrived = Promise.withResolvers<ScriptedTurnOptions>();
      const answer = Promise.withResolvers<ScriptedAnswer>();
      const model = parkingModel(arrived, answer.promise);
      const factory = () => model;
      seamFactories.add(factory);
      agent.modelFactory = factory;
      agent.harnessResumeChatLoop();
      const request = await arrived.promise;
      const started = agent.harnessLastTurnStart();
      const identity: SettledTurn = started ?? { turnId: '', messageId: '' };
      const landed: Promise<SendLanding> = (agent.harnessChatLoop.pumpPromise ?? Promise.resolve()).then(() => 'turn' as const);

      const parked: ParkedTurn = {
        request: requestView({ request, model, identity, tools: agent.harnessPreparedTools(), history: agent.harnessAdmittedHistory() }),
        answer, landed, identity,
      };

      parkedTurns.set(agent, parked);

      return parked.request;
    },

    async prepare(input) {
      const lastUser = input.messages.map((message) => message.role).lastIndexOf('user');
      const user = lastUser === -1 ? undefined : input.messages[lastUser];
      // Everything before the driving message is the working history the turn is admitted over.
      const prior = lastUser === -1 ? [...input.messages] : input.messages.slice(0, lastUser);

      if (prior.length > 0) await agent.harnessSeedHistory(prior);
      const content = user?.content ?? '';
      const text = v.is(v.string(), content) ? content : content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
      // The composer stamps `kinuMode` on the message it sends; `admit` reads it there only.
      agent.harnessSupplyTools(input.tools);
      const parked = await admit(text, undefined, input.signal);

      return parked.request;
    },

    async step(stepNumber, messages) {
      return agent.harnessStep(stepNumber, messages);
    },

    async settle(answer) {

      if (answer.persistFails === true) agent.harnessNextAnswerUndurable();
      // A prepared turn settles under the answer's name, an unprepared one runs its own;
      // either way the parked entry is consumed.

      if (answer.turnId !== undefined && !parkedTurns.has(agent) && !openedTurns.has(agent)) openedTurns.set(agent, answer.turnId);
      const parked = parkedTurns.get(agent) ?? await admit(answer.turnId ?? answer.messageId, answer.messageId);
      parkedTurns.delete(agent);

      return finish(parked, answer);
    },

    open(turnId) {
      openedTurns.set(agent, turnId);
    },

    async openInFlight(turnId) {
      openedTurns.set(agent, turnId);
      await admit('a live turn', undefined);
    },
  };
}

export interface ActorHarness<T> {
  readonly agent: T;
  readonly db: Database;
  tableNames: () => string[];
  /** Every prompt the scripted sleep-time model was asked, in order; only
   *  appended when {@link orchestratorHarness} was given `sleepTimeModel`. */
  readonly sleepTimePrompts: string[];
}


/** The Durable Object state every fixture here constructs; shared with
 *  `helpers/hosted-workspace.ts` so the platform surface cannot drift. */
export function makeCtx(db: Database, id = 'harness-actor'): AgentContext {
  const canonicalSql = makeSqlExec(db);

  const sqlExec = (query: string, ...bindings: SqlValue[]) => {
    const rows = canonicalSql.exec(query, ...bindings).toArray();

    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  };

  // Real KV storage: `_cf_initAsFacet` puts `cf_agents_parent_path` here and the
  // owner's inspection reads it back before traversing the hop.
  const kv = new Map<string, JsonValue>();

  const context = {
    storage: {
      sql: { exec: sqlExec },
      // Real: the durable filesystem's atomicity rests on it; Nimbus refuses to boot without it.
      transactionSync: <T>(closure: () => T): T => db.transaction(closure)(),
      get: async (key: string): Promise<JsonValue | undefined> => kv.get(key),
      put: async (key: string, value: JsonValue): Promise<void> => { kv.set(key, value); },
      // Nimbus's per-actor shell state; delete answers whether a row was there, as the platform's does.
      delete: async (key: string) => kv.delete(key),
      list: async (options: { prefix: string }): Promise<Map<string, JsonValue>> => {
        const entries = new Map<string, JsonValue>();

        for (const [key, value] of kv) {
          if (key.startsWith(options.prefix)) entries.set(key, value);
        }

        return entries;
      },
      transaction: async <T,>(body: (txn: {
        get(key: string): Promise<JsonValue | undefined>;
        put(key: string, value: JsonValue): Promise<void>;
        delete(key: string): Promise<boolean>;
      }) => Promise<T>): Promise<T> => body({
        get: async (key) => kv.get(key),
        put: async (key, value) => { kv.set(key, value); },
        delete: async (key) => kv.delete(key),
      }),
      sync: async () => undefined,
      deleteAll: async () => {
        // workerd's `storage.deleteAll()` empties both the KV pairs and every SQLite table.
        const tables = db.prepare<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        ).all();

        for (const { name } of tables) db.exec(`DROP TABLE "${name}"`);
        kv.clear();
      },
      setAlarm: async () => {},
      getAlarm: async () => null,
      deleteAlarm: async () => {},
    },
    id: { toString: () => id, name: id },
    waitUntil: () => {},
    blockConcurrencyWhile: <Result>(fn: () => Promise<Result>): Promise<Result> => fn(),
    getWebSockets: () => [],
    abort: () => {},
    // The supervisor entrypoint the hosted runtime requires; workerd hangs DO exports off ctx.
    exports: { SupervisorRPC },
  };

  const partialContext: Partial<AgentContext> = {};
  Object.assign(partialContext, context);

  // SAFETY: the Agent constructor contract stores this locally constructed
  // context, and actor schema initialization only calls the implemented SQL,
  // transaction, identity, alarm, and concurrency members above.
  return partialContext as AgentContext;
}

/**
 * Env with the bindings actor construction reaches. LOADER and UserDO are
 * present-but-inert: deps construction captures them; using them throws.
 * `parent` binds a real orchestrator under `OrchestratorAgent` for the parent hop.
 */

/** A recording owner-UserDO binding, in place of the refusing default. */
export interface RecordedUserPlaneCalls {
  warmConnections: UserCaller[];
  /** Set to make `userMcp_warmConnections` reject. */
  failWarm: Error | null;
  /** Set to make `userMcp_toolDescriptors` reject with this error; unset, the read is unreachable. */
  failDescriptors?: Error;
  /** How many times the object asked for its tool descriptors. */
  descriptorReads?: number;
  /** Set to make the egress-vault listing reject; unset, it answers empty. */
  failVault?: Error;
  /** The owner profile `getProfile` answers with. Null (no verified address) is
   *  refused by the email trust gate, distinct from an unauthorized sender. */
  profile?: { email: string } | null;
  titles: string[];
}

/** A real user plane: `userDO` is bound at `env.UserDO`; `workspace` is the DO name
 *  (`workspaceName()`). Set at construction: the runtime reads both once. */
export interface HarnessActorWorld {
  userDO?: UserDO;
  workspace?: string;
  ownerUserId?: string;
  /** The platform AI binding the gateway provider calls; a recording stub by default. */
  aiGateway?: StubbedAiBinding;
}

/** The one read the instruction-trust authority performs against a parent. */
interface HarnessInstructionAuthority {
  getWorkspaceInstructionApprovals(): Promise<readonly never[]>;
}

/** The parent DO namespace: a real parent agent or a deny-stub. */
interface HarnessParentNamespace {
  idFromName(name: string): string;
  get(id: string): HarnessOrchestratorAgent | HarnessInstructionAuthority;
}

export function makeEnv(
  parent?: HarnessOrchestratorAgent,
  userPlane?: RecordedUserPlaneCalls,
  world?: HarnessActorWorld,
  parentNamespace?: HarnessParentNamespace,
): Env {
  const bindings = {
    LOADER: {
      get: () => { throw new Error('harness LOADER: codemode is not executable under bun'); },
      load: () => { throw new Error('harness LOADER: a dynamic worker is not loadable under bun'); },
    },
    // The platform gateway is the harness's model provider, over a recording AI binding.
    ...platformGatewayEnv(world?.aiGateway),
    UserDO: {
      idFromName: (n: string) => ({ toString: () => n }),
      // Recording when asked, refusing otherwise, so an unannounced user-plane path fails
      // loudly. A claimed root's settle/open members (title registry, profile, MCP warm,
      // release board) answer; a suite-supplied real UserDO replaces this whole.
      get: () => {
        if (world?.userDO !== undefined) return world.userDO;

        const ownerPlane = {
          getWorkspaceTitle: async (): Promise<null> => null,
          setWorkspaceDisplayName: async (
            _caller: UserCaller, _workspace: string, displayName: string,
          ): Promise<{ applied: boolean }> => {
            userPlane?.titles.push(displayName);

            return { applied: true };
          },
          userMcp_warmConnections: async (caller: UserCaller): Promise<{ servers: number }> => {
            userPlane?.warmConnections.push(caller);

            if (userPlane?.failWarm) throw userPlane.failWarm;

            return { servers: 1 };
          },
          userMcp_toolDescriptors: async (): Promise<never> => {
            if (userPlane) userPlane.descriptorReads = (userPlane.descriptorReads ?? 0) + 1;
            throw userPlane?.failDescriptors
              ?? new Error('harness UserDO: userMcp_toolDescriptors is not reachable under bun');
          },
          getProfile: async (): Promise<{ email: string } | null> => userPlane?.profile ?? null,
          // Empty: `getWorkspaceTabPresence` gates the Releases tab on `changes.length`.
          getReleaseBoard: async (): Promise<ReleaseBoard> => ({
            bindings: [], changes: [], checks: [], approvals: [], deployments: [],
          }),
          // No stored egress secrets; `failVault` drives an unreadable vault.
          listEgressSecrets: async (): Promise<readonly EgressSecretBinding[]> => {
            if (userPlane?.failVault) throw userPlane.failVault;

            return [];
          },
          // A job holding no device commands: what the hub answers when nothing needs stopping.
          cancelDeviceRequestsForBackgroundJob: async (): Promise<[]> => [],
        };

        const owned = (prop: string | symbol): prop is keyof typeof ownerPlane => prop in ownerPlane;

        return new Proxy(ownerPlane, {
          get: (target, prop) => {
            if (prop === 'then') return undefined;

            if (owned(prop)) return target[prop];

            return async () => { throw new Error(`harness UserDO: ${String(prop)} is not reachable under bun`); };
          },
        });
      },
    },
  };

  if (parentNamespace) {
    Object.assign(bindings, { OrchestratorAgent: parentNamespace });
  } else if (parent) {
    Object.assign(bindings, {
      OrchestratorAgent: { idFromName: (n: string) => n, idFromString: (id: string) => id, get: () => parent },
    });
  }

  const env: Partial<Env> = {};
  Object.assign(env, bindings);

  // SAFETY: the ActorAgent dependency contract only reads the constructed
  // LOADER, UserDO, and gateway bindings in this harness; each
  // unsupported operation throws if schema composition begins invoking it.
  return env as Env;
}

interface ActorInstantiation {
  readonly db: Database;
  readonly parent?: HarnessOrchestratorAgent;
  readonly userPlane?: RecordedUserPlaneCalls;
  readonly world?: HarnessActorWorld;
  readonly parentNamespace?: HarnessParentNamespace;
  readonly env?: Env;
}

function instantiate<T extends object>(
  Actor: new (ctx: AgentContext, env: Env) => T,
  { db, parent, userPlane, world, parentNamespace, env }: ActorInstantiation,
): ActorHarness<T> {
  const builtEnv = env ?? makeEnv(parent, userPlane, world, parentNamespace);
  const agent = new Actor(makeCtx(db), builtEnv);

  if (env === undefined && parent === undefined && parentNamespace === undefined) {
    // This workspace answers its own standing-policy reads: a hosted actor's approval
    // gate fetches the root's policy through `env.OrchestratorAgent`.
    Object.assign(builtEnv, {
      OrchestratorAgent: { idFromName: (n: string) => n, idFromString: (id: string) => id, get: () => agent },
    });
  }

  Object.defineProperty(agent, 'name', { value: world?.workspace ?? 'harness-parent', configurable: true });

  return {
    agent,
    db,
    tableNames: () => db.prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND type='table' ORDER BY name",
    ).all().map((row) => row.name),
    sleepTimePrompts: [],
  };
}

/** The actor's schema half of an activation. Schema is in place synchronously on
 *  return; the async boot's promise is dropped (a failed boot classifies inside `onStart`). */
function ensureActorSchema(agent: InstanceType<typeof OrchestratorAgent>): void {
  const gate: unknown = OrchestratorAgent.prototype.onStart.call(agent);
  void gate;
}


/** A real OrchestratorAgent with a claimed owner, schema ensured. `userPlane`
 *  opts into a recording UserDO binding; `world` places it in a real owner's DO. */
export function orchestratorHarness(
  userPlane?: RecordedUserPlaneCalls,
  world?: HarnessActorWorld,
  env?: Env,
  opts?: {
    /** Leave the sleep-time lane on behind a scripted fast model answering this
     *  update; prompts land in `sleepTimePrompts`. Absent, the lane is off. */
    readonly sleepTimeModel?: SleepTimeUpdate;
  },
): ActorHarness<HarnessOrchestratorAgent> {
  const harness = instantiate(HarnessOrchestratorAgent, { db: new Database(':memory:'), userPlane, world, env });
  ensureActorSchema(harness.agent);
  harness.db.prepare(
    'UPDATE workspace_identity SET owner_user_id = ? WHERE id = ?',
  ).run(world?.ownerUserId ?? 'harness-owner', 'harness-actor');
  // Without the capability this root cannot reach its title registry, so every settle
  // would owe an auto title forever.
  harness.agent.harnessHoldsCapability('harness-capability');
  harness.agent.declareScaffoldPresent();

  if (opts?.sleepTimeModel) {
    harness.agent.harnessScriptSleepTimeModel(opts.sleepTimeModel, harness.sleepTimePrompts);
  } else {
    harness.agent.harnessDisableSleepTimeCompute();
  }

  return harness;
}

/** A half-born workspace: constructed, but `ensureSchema` never ran, so
 *  `workspace_identity` is absent and owner reads throw. */
export function halfBornOrchestratorHarness(
  world?: HarnessActorWorld,
): ActorHarness<HarnessOrchestratorAgent> {
  return instantiate(HarnessOrchestratorAgent, { db: new Database(':memory:'), world });
}

/** A fresh actor instance over surviving storage: the isolate reset, with every
 *  in-memory latch gone and every durable row intact. */
export async function reactivateOrchestratorHarness(
  db: Database,
  userPlane?: RecordedUserPlaneCalls,
  /** Armed before the activation's reconcile, which is the recovery under test. */
  opts?: {
    readonly clockSkewMs?: number;
    readonly fault?: [TerminalEffectName, TerminalEffectPhase];
    /** The recorded sleep-time answer replayed with the lane on; armed before the reconcile. */
    readonly sleepTimeAnswer?: readonly [key: string, update: SleepTimeUpdate];
    /** Which object this activation is, as {@link orchestratorHarness} takes it; the
     *  name is `workspaceName()`, so a restart must repeat it. */
    readonly world?: HarnessActorWorld;
    readonly env?: Env;
    readonly beforeStart?: (agent: HarnessOrchestratorAgent) => void;
  },
): Promise<ActorHarness<HarnessOrchestratorAgent>> {
  const harness = instantiate(HarnessOrchestratorAgent, { db, userPlane, world: opts?.world, env: opts?.env });

  // Before `onStart`, which starts the recovery under test.
  if (opts?.clockSkewMs !== undefined) harness.agent.harnessAdvanceTerminalClock(opts.clockSkewMs);

  if (opts?.fault) harness.agent.harnessArmTerminalFault(opts.fault[0], opts.fault[1]);

  if (opts?.sleepTimeAnswer) {
    harness.agent.harnessRecordSleepTimeAnswer(...opts.sleepTimeAnswer);
  } else {
    harness.agent.harnessDisableSleepTimeCompute();
  }

  opts?.beforeStart?.(harness.agent);
  ensureActorSchema(harness.agent);
  harness.agent.declareScaffoldPresent();

  // Join the detached reconcile on its in-flight set: it acquires each sequence it
  // recovers, so a second reconcile would be turned away. Unconditional laps first:
  // on return from `onStart` it has not yet acquired anything.
  for (let tick = 0; tick < 8; tick++) await joinHarnessFibers();

  for (let tick = 0; tick < 200 && harness.agent.harnessSequencesInFlight() > 0; tick++) {
    await joinHarnessFibers();
  }

  return harness;
}


/** A real hired subordinate, seeded through the parent's `SubordinateRuntime` and
 *  acquired from the workspace's `ActorHost`, in one process and one database. */
export async function hostedSubordinateHarness(
  workspace: ActorHarness<HarnessOrchestratorAgent>,
  identity: {
    readonly name: string;
    readonly displayName: string;
    readonly nameOrigin: 'user' | 'auto';
    readonly mission: string;
    readonly roleId?: string;
  },
): Promise<HostedActorHarness> {
  const seed: SubordinateSeed & { creationId: string } = {
    name: identity.name,
    displayName: identity.displayName,
    nameOrigin: identity.nameOrigin,
    // Durable: this stands in for a hire.
    lifetime: 'durable',
    mission: identity.mission,
    role: identity.roleId ?? 'task',
    // Absent, not null: null would pin "no tier", which the catalog cannot honour.
    creationId: crypto.randomUUID(),
  };

  const reference = await workspace.agent.observeSubordinateRuntime().spawn(seed);
  const actor = await workspace.agent.observeActorHost().acquire(reference);

  return { actor, workspace };
}

export async function hostedExplorationHarness(
  workspace: ActorHarness<HarnessOrchestratorAgent>,
  kind: 'head' | 'branch',
  id: string,
): Promise<HostedActorHarness> {
  const entry = await workspace.agent.actorDirectory({
    action: 'register', creationId: id, name: `exp:${id}`, kind, lifetime: 'task',
  });

  const actor = await workspace.agent.observeActorHost().acquire(entry.reference);

  return { actor, workspace };
}

export async function hostedMainActor(
  workspace: ActorHarness<HarnessOrchestratorAgent>,
): Promise<HostedActorHarness> {
  const host = workspace.agent.observeActorHost();
  const actor = await host.acquire(actorReferenceOf(workspace.agent.observeRuntime().actor));

  return { actor, workspace };
}
