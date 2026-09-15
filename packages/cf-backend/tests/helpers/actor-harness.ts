/**
 * Instantiate a REAL cf actor class under bun — the platform mocked at its
 * genuine seams (agents SDK base class, DO storage over bun:sqlite, env
 * bindings), everything above them the production code itself.
 *
 * Until this harness existed, no test constructed an ActorAgent at all: the
 * cf turn pipeline was verified only by reading its own source, which is how
 * a composition root can be green in every unit test while a capability it
 * forgot to wire never exists in production. The conformance suite runs the
 * real `ensureSchema` and the real `getRawTools` through this and observes
 * what actually comes out.
 *
 * Think inference can run with an injected provider; codemode cannot execute
 * here (env.LOADER throws). The SDK base and DO storage remain platform doubles.
 */
import { Database } from 'bun:sqlite';
import { makeSqlExec } from '../../../core/tests/helpers';
import type { AgentContext, Connection, FiberRecoveryContext, FiberRecoveryResult, WSMessage } from 'agents';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import * as v from 'valibot';
import { scriptedTurnModel, type ModelStreamPart, type ScriptedTurnOptions, type ScriptedTurnResult } from '@kinu.run/test-utils/turn-model';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import type { PreparedRequest, ScriptedAnswer, SettledTurn, TurnHarness } from './turn-harness';
import type { UserCaller, SendLanding, ProgrammaticTurn, EnqueueTurnResult, SpendSource, BackendHost } from '@kinu.run/core';
import type { Refusal } from '@kinu.run/core/obs';
import type { AssistantMessagesTranscript } from '../../src/chat-transcript';
import { OwnedModelServices } from '../../src/owned-model-services';
import type { ChatTurnInput, ActorTurnLease, PreparedTurn, RunEventRecorder } from '@kinu.run/core';
import type { ChatWireTransport } from '../../src/chat-transport';
import { isWorkMode, workModeForTurnMetadata, ChatSession, ExtensionHost, PendingSendStore, type KinuExtension } from '@kinu.run/core';
import { createCompositeLogger, createConsoleLogger, renderCauseChain, setDiagnosticsSink, toKinuError } from '@kinu.run/core/obs';
import type { UserDO } from '../../src/user/user-do';
import type { SlateHost } from '../../src/slates/host';
import {
  shadowTrialPlan, claimToolEffect, actorReferenceOf, 
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
  type AgentSignal, type SendOutcome, type ReleaseBoard,
} from '@kinu.run/core';
import { joinHarnessFibers, mockAgentsSdk, seedOrphanFiberRow } from './agents-sdk';
import { fleetPlaneForTest, fleetStatsForTest, openAnalyticsWindowForTest, type FleetPoint } from './analytics-plane';
import { platformGatewayEnv } from './platform-gateway';
import {
  TerminalEffectInterrupt,
  type TerminalEffectName, type TerminalEffectPhase,
} from '@kinu.run/core';
import type { ExplorationHostSeams } from '../../src/exploration-hosting';
import type { HostedTaskProfile } from '../../src/subordinate-hosting';
import type { AgentProviderRegistry } from '../../src/providers/agent-registry';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';

mockAgentsSdk();

const { OrchestratorAgent } = await import('../../src/orchestrator');

const { runHostedTask } = await import('../../src/subordinate-hosting');

/** The scaffold precondition a turn checks, declared satisfied — the harness
 *  workspace is empty, so nothing has written one. The soul is not declared:
 *  `setObservedSoul` pre-fills the cache the SYNCHRONOUS prompt builders read,
 *  while a turn refreshes that cache from the workspace filesystem below. */
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

/** The orchestrator a test drives, named so suites import the contract instead
 *  of reaching through `ReturnType<typeof orchestratorHarness>`. */
export class HarnessOrchestratorAgent extends OrchestratorAgent {
  modelFactory?: () => LanguageModel;
  override getModel(): LanguageModel {
    return this.modelFactory?.() ?? super.getModel();
  }
  /** The one place a turn binds its model: the harness's scripted one when a
   *  suite supplied it, the resolver's otherwise. */
  protected override turnModel(spec: string): LanguageModel {
    return this.modelFactory?.() ?? super.turnModel(spec);
  }
  /** Every routed side model (the titler's 'fast', the advisor's, the judge's)
   *  the route cannot build is a silent scripted one: no harness actor holds
   *  provider credentials, and a terminal effect that reached a real provider
   *  would fail on auth rather than on what the suite is pinning. A route the
   *  suite DID script — its own resolver on the owned model services — is
   *  honoured, since that route is what the suite is pinning. Never the TURN
   *  model: the driver parks a turn at its first model call, and a titling
   *  call is not that. */
  sideModelFactory?: () => LanguageModel;
  protected override async modelForSource(source: SpendSource) {
    const routed = await super.modelForSource(source);
    // The suite scripted the route's own resolver: the model it built is the
    // one the route is pinned on. The production services are a class
    // instance; a scripted resolver is a plain object the suite assigned.
    const scriptedRoute = !(this.ownedModelServices instanceof OwnedModelServices);

    if (scriptedRoute) return routed;

    return { ...routed, model: this.sideModelFactory?.() ?? SILENT_SIDE_MODEL };
  }
  observeRawTools(): ToolSet { return this.getRawTools(); }
  /** A live turn, on the loop's own terms: `true` admits a turn and parks it
   *  at its first model call, `false` settles the parked one. What every
   *  reader of "is a turn running" then sees is the loop's answer. */
  async declareTurnInFlight(inFlight: boolean): Promise<void> {
    if (inFlight) await thinkTurns(this).prepare({ messages: [{ role: 'user', content: 'a live turn' }] });
    else await thinkTurns(this).settle({ messageId: 'a live turn', text: 'done' });
  }
  /** The loop and the transcript, for the turn seam's driver. */
  get harnessChatLoop(): ChatSession { return this.chatLoop; }
  /** The conversation a stated turn is admitted OVER — what the actor's
   *  working history holds before the turn's own message is appended, as a
   *  restored revision holds it on a live workspace. A suite's statement
   *  stands only where the actor holds NO conversation of its own yet: an
   *  actor whose working history has been written — by a turn it ran, by an
   *  authored edit — keeps it, since that history is what such a suite is
   *  asserting on. */
  harnessSeedHistory(messages: readonly ModelMessage[]): void {
    if (this.actorSession.history.length > 0) return;
    this.actorSession.restoreHistory(messages);
  }
  /** An observer on the actor's own extension host — the seam the loop's chat
   *  runner reports each tool call and result through, in the order the
   *  tools settled. A suite that watches completion order registers here. */
  harnessRegisterExtension(extension: KinuExtension): void { this.extensions.register(extension); }
  get harnessTranscript(): AssistantMessagesTranscript { return this.chatTranscript; }
  /** A programmatic turn admitted the way every producer admits one. */
  harnessEnqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> { return this.chatLoop.enqueueTurn(input); }
  /** The answer id the NEXT turn is persisted under, when a suite named one:
   *  the seam's `settle({ messageId })` is that name, so the rows the suite
   *  reads back are keyed as it wrote them. Consumed by the next admission. */
  private _nextAnswerId: string | null = null;
  harnessNameNextAnswer(messageId: string): void { this._nextAnswerId = messageId; }
  protected override mintAnswerId(): string {
    const named = this._nextAnswerId;
    this._nextAnswerId = null;

    return named ?? super.mintAnswerId();
  }
  /** The ids the loop started its last turn under — read off the same event
   *  stream the transport delivers, so a suite sees exactly what a client would. */
  private _lastTurnStart: { turnId: string; messageId: string } | null = null;
  harnessLastTurnStart(): { turnId: string; messageId: string } | null { return this._lastTurnStart; }
  protected override get chatTransport(): ChatWireTransport {
    const transport = super.chatTransport;

    if (!this._observedTransport) {
      this._observedTransport = true;
      const deliver = transport.deliver.bind(transport);

      transport.deliver = (event) => {
        if (event.type === 'turn-start') this._lastTurnStart = { turnId: event.turnId, messageId: event.messageId };
        deliver(event);
      };
    }

    return transport;
  }
  private _observedTransport = false;
  /** The next answer row is one the converter refuses — a tool-role message
   *  under the assistant's id. Production never writes one; the arm that pins
   *  what a refusal costs needs the row to exist, and this is the one seam
   *  the transcript reads the streamed answer through. */
  harnessNextAnswerUnreadable(role: 'tool'): void {
    // The loop's own construction installs the production source; built first
    // so this arm is the LAST installer, not the one it overwrites.
    this.resumeChatLoop();
    const transcript = this.harnessTranscript;
    let armed: string | null = null;

    const unreadable = (id: string) => {
      const message = { id, role: 'assistant', parts: [{ type: 'text', text: 'the answer' }] };
      // Past the type on purpose: the SDK forbids the shape and that is the
      // point of the arm that asks for it.
      Reflect.set(message, 'role', role);

      return message;
    };

    // The roster reads the answer first (streamed), the row spends it (answer):
    // both see the one unreadable message, so the recorded input and the stored
    // row are the same shape the converter refuses.
    transcript.answersFrom({
      streamed: (id) => {
        if (armed === null && this.chatTransport.streamed(id) !== null) armed = id;

        return armed === id ? unreadable(id) : this.chatTransport.streamed(id);
      },
      answer: (id) => {
        const real = this.chatTransport.answer(id);

        if (armed !== id) return real;
        armed = null;

        return unreadable(id);
      },
    });
  }

  /** The next assistant row fails to write — the one way a turn the model
   *  answered leaves no durable answer on the loop. The commit is one
   *  transaction, so nothing of the turn lands. */
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

  harnessAdmitChat(trigger = 'ws-chat'): void {
    this._emit('chat:turn:start', { requestId: 'harness-admitted', trigger, admission: 'queue' });
  }
  /** The head-stream broadcaster, which is `protected` because only this
   *  actor's own reporters call it — `reportNodeDelta` and the exploration
   *  seams' `publishDelta`. Exposed so a suite asserting what a client
   *  receives reaches the method that really carries the frames. */
  observePublishHeadStreamFrame(frame: HeadStreamFrame): void { this.publishHeadStreamFrame(frame); }
  /** The child substrate — how a subordinate is born and retired here — for
   *  suites that drive a lifecycle verb without a roster row in front of it. */
  observeSubordinateRuntime() { return this.subordinateRuntime(); }
  /** The backend-agnostic per-turn logic, for suites asserting what the
   *  steering + opportunity ledger saw. */
  observeOrch(): AgentOrchestrator { return this.orch; }
  /** The assembled runtime, for the conformance observer's `producer` plane. */
  observeRuntime(): AgentRuntime { return this.rt; }
  /** The slate host, so a suite can arm its one launch seam (`ensure`) as a tripwire. */
  observeSlateHost(): SlateHost { return this.slates; }
  /** The profile the last `beforeTurn` resolved, for suites asserting what the
   *  turn runs under. The accessor is `protected` because only the actor's own
   *  lanes read it — a suite reaches it through this observer. */
  observeResolvedTurnProfile(): ResolvedTurnProfile | null { return this.resolvedTurnProfile(); }
  /** The turn-start device-status refresh, AWAITED — the same entry point
   *  `beforeTurn` calls, so a connected device becomes visible to the mount
   *  table for a suite that has no turn to run. Production detaches the one at
   *  runtime construction, which is why the timing has to be asked for. */
  harnessRefreshDeviceStatus(): Promise<DeviceStatus> { return this.rt.deviceTransport.refreshStatus(); }
  setObservedSoul(text: string): void { this._cachedSoulText = text; }
  declareScaffoldPresent(): void { this._scaffoldReady = true; }
  /** The deployment secret a workspace signs its own delivery URL with —
   *  configuration rather than state, and absent from the harness env because
   *  most actors never mint one. Declared here so `createDurableWebhook` runs
   *  as production runs it instead of refusing for want of a binding. */
  declareWebhookRouteSecret(secret: string): void {
    Object.assign(this.env, { WEBHOOK_ROUTE_SECRET: secret });
  }
  /**
   * The CONTAINER this workspace's actors run commands in — absent from the
   * harness env for the same reason the webhook secret is: most actors never
   * build one, and `createCFRuntime` gates the whole handle on `if (env.Sandbox)`,
   * so every hosted actor's `sandboxHandle` is null without this.
   *
   * Declared rather than defaulted, because an env that always carried it would
   * make every suite in this directory reach the Sandbox SDK. A suite that wants
   * the container asks for it, pairs it with the shared stand-in in
   * `helpers/sandbox-sdk.ts`, and asks BEFORE the actor whose runtime it cares
   * about is acquired: `ActorHostDeps.runtimeFor` memoizes one runtime per
   * handle, so a binding declared afterwards arrives too late to be read.
   *
   * The namespace itself is inert on purpose. `getSandbox(env.Sandbox, id, …)`
   * only forwards it, and the SDK stand-in is what answers, so the binding's
   * job here is to exist and to carry the id the runtime derived.
   */
  declareContainerBinding(): void {
    Object.assign(this.env, { Sandbox: { idFromName: (name: string) => name, get: () => ({}) } });
  }
  protected override async profileInputs() {
    const overlay = this._catalogOverlay;

    if (overlay === null) return { envelope: HARNESS_PROFILE_ENVELOPE, provider: HARNESS_PROVIDER_SNAPSHOT };

    // An owner-authored catalog carries the builtins plus its own roles: merged,
    // not replaced, so a test names the role under test rather than restating
    // the workspace. The digest is recomputed over the merged catalog, which is
    // what the authority checks the envelope against. Models the overlay's
    // tiers name join the provider snapshot for the same reason: a tier naming
    // a model the listing does not offer is refused before routing, which is
    // real behavior but not the routing this overlay exists to set up.
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
  /** Install roles/tiers over the builtin catalog. The host resolves hosted
   *  actors' profiles through this agent's authority, so an installed role
   *  narrows a hosted child's surface exactly as production's does. */
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
  /** Run a shell command on the workspace box as an explicitly stamped
   *  credential — the test replacement for the removed `workspaceBoxOp` RPC in
   *  suites that arrange file ownership. Host-stamped, never agent-chosen, the
   *  same way production reaches `exec`. */
  harnessBoxExec(shellId: string, command: string, cred: VfsCred): Promise<NimbusExecResult> {
    return this.workspaceBox(shellId).exec(command, { cred });
  }
  /** A cold activation: the owner row persists in SQL, in-memory latches do
   *  not — the state every claimOwner RPC meets on a freshly-activated DO. */
  forgetActivationLatches(): void {
    this._scaffoldReady = false;
    this._ownerUserId = undefined;
    this._titleCache = null;
    this._titleHydrated = false;
  }
  /**
   * A further activation, through the ACTOR's own `onStart` — the sweep, the
   * wake reconcile, the stale-delivery unbind, exactly as the platform calls
   * them on a cold start.
   *
   * `agent.onStart()` is the vendor chat base's wrapper around this one. It
   * boots Think's session and transcript first and reaches the actor's
   * `onStart` after that, the activation the SDK runs before a facet's first
   * `@callable`. This bridge is the actor half
   * alone, for the suites that assert a sweep or a reconcile and nothing of
   * Think's, the same reach `ensureActorSchema` takes below.
   */
  activateActor(): Promise<void> { return Promise.resolve(super.onStart()); }
  /** The installed chat protocol gate, for suites that speak the hook's own
   *  frames: Think ran its `onStart` above and reached this actor's, which
   *  installed the gate over `onMessage`. */
  harnessChatGate(): (connection: Connection, message: WSMessage) => Promise<void> {
    const gate = this.onMessage.bind(this);

    return (connection, message) => Promise.resolve(gate(connection, message));
  }
  /** The parent-side roster the facet gate consults. Exposed rather than
   *  wrapped: the production store IS the API a test seeds a subordinate
   *  through, and a hand-written INSERT would be a second copy of its
   *  status policy. */
  harnessRoster(): SubordinateRosterStore { return this.subordinateRoster; }
  /** One auto-GEPA cadence tick — the call a completed turn makes
   *  (`orchestrator.ts` `onTurnComplete`). */
  /**
   * One cadence tick, under a named terminal tick — the durable identity the
   * non-replayable lanes key their attempt and completion on.
   *
   * `pass` stands in for the two real lanes: they drive candidate scaffolds
   * through the live tool surface, which a unit harness has none of, and what is
   * under test is how many times a cut pass is allowed to run.
   */
  harnessOncePerTick(scope: string, tick: string, pass: () => Promise<void>): Promise<void> {
    return this.oncePerTick(scope, tick, pass);
  }

  async tickAutoGepa(): Promise<void> { await this.maybeRunAutoGepa(); }

  /** The sampling plan this turn's declaration would record. */
  harnessShadowPlan(messageId: string): number | null {
    return shadowTrialPlan(this.scaffoldControl, messageId);
  }

  /** The activation's wake-row reconcile, AWAITED. Production detaches it —
   *  `onStart` runs inside the init gate and arming a row is I/O — so a test
   *  that wants its outcome rather than its timing calls it here. */
  reconcileWakeRow(): Promise<void> { return this.reconcileTimerRow(); }
  /** The cadence a tick reads, and the deliberate disable a tick must respect. */
  observeAutoGepaCadence(): number { return this.config.getAutoGepaEveryNTurns(); }
  setAutoGepaCadence(turns: number): void { this.config.setAutoGepaEveryNTurns(turns); }
  /** One auto-title round-trip — the shared `ActorAgent.suggestTitle` seam
   *  that `applyWorkspaceTitle`'s `suggest` slot wires into. */
  harnessSuggestWorkspaceTitle(mission: string): Promise<string | null> {
    return this.suggestTitle(mission);
  }
  /** Admit one event, through the only writer allowed to: `publish` is the
   *  single admitted author of `kind='event'` rows, so a test that wants an
   *  event in the log goes through it rather than around it with an INSERT. */
  publishHarnessEvent(descriptor: IngressDescriptor, now: number): void {
    this.eventLog.publish({ descriptor, now });
  }

  // ── Durable execution, as an eviction test observes it ──────────────
  // The lanes and the recovery hook are `protected`/`private` on the actor
  // because nothing in production calls them from outside; an eviction test has
  // to reach the SAME entry points the platform uses, so each is exposed by
  // name here rather than reconstructed.

  /** The background-job registry, so a test can seed the durable row an
   *  interrupted job leaves behind. The production store, not an INSERT: the
   *  lease epoch and the resume counter are its policy. */
  harnessJobs(): BackgroundJobStore { return this.jobs; }
  /** One post-turn evolution lane, started exactly as a completed turn does. */
  harnessSettleEvolution(): void { this.settleEvolutionInBackground(); }
  /** One activation's alarm housekeeping — the entry point that runs the
   *  interrupted-fiber scan when nothing is connected. The public half of the
   *  no-client recovery path, so a test drives what the platform drives. */
  harnessAlarmHousekeeping(): Promise<void> { return this._onAlarmHousekeeping(); }

  /**
   * The durable turn identity a turn opens on. Production sets it in
   * `beforeTurn`, which needs a model; a suite that drives `onChatResponse`
   * directly declares it, because it is the key the terminal transition claims
   * against and an absent one means "unclaimed" rather than "first".
   */
  declareTurnCheckpoint(turnId: string): void {
    this._turnCheckpoint = { turnId, sessionId: 'default' };
    this.declareTurnEvolutionGate();
  }

  /**
   * The other half of what a turn opening establishes: whether this session
   * records evolution state at all.
   *
   * Production reads it in `beforeTurn`, and the settled response carries it
   * into its recorded row so a recovering host cannot re-judge the turn. A
   * suite driving `onChatResponse` with no turn to open declares it here;
   * declaring a checkpoint already does.
   */
  declareTurnEvolutionGate(): void {
    this._turnEvolutionEnabled = this.turnRecordsEvolution();
  }

  /**
   * The user message this turn is running FOR, with the metadata production
   * reads its work mode off.
   *
   * Stated rather than stubbed: `turnWorkMode()` narrows the last durable user
   * message's metadata, so a suite that wants a Plan turn has to put one there —
   * asserting the mode any other way would test the assertion.
   */
  harnessDrivingUserMessage(text: string, metadata?: JsonObject): void {
    const id = `u-msg-${crypto.randomUUID().slice(0, 8)}`;
    const stamped = metadata !== undefined && Object.keys(metadata).some((key) => key !== 'kinuMode');

    // Nothing durable yet: the loop is the one writer of a user row, and it
    // writes this one when the driver admits the turn — a signal's as the
    // queue's row, a client's as the turn's opening row under this id.
    this._drivingMessage = { id, text, metadata, stamped };
  }
  /** The user message the next admitted turn runs FOR, when a suite stated
   *  one: the driver admits it under this id and metadata, the way the
   *  transport sends a client's message or a signal queues its own. */
  private _drivingMessage: { id: string; text: string; metadata: JsonObject | undefined; stamped: boolean } | null = null;
  harnessTakeDrivingMessage(turnId: string | undefined): { id: string; text: string; metadata: JsonObject | undefined; stamped: boolean } | null {
    const message = this._drivingMessage;
    this._drivingMessage = null;

    if (message === null || turnId === undefined || turnId === message.id || message.stamped) return message;

    // The suite named the turn after stating its message: the client's row IS
    // the turn's row, so it takes the name the turn runs under.
    return { ...message, id: turnId };
  }
  /** A stated message no turn has taken yet stands in, on an idle read, for
   *  the composer's last message — the mode the suite declared, as the loop
   *  will admit it. Production's idle read narrows off the last durable row,
   *  which the loop writes when the turn opens; a suite that lists tools
   *  BEFORE driving the turn reads the same mode off the statement. */
  protected override turnUserMetadata(): JsonObject | undefined {
    const stated = this._drivingMessage;

    return stated !== null && stated.metadata !== undefined ? stated.metadata : super.turnUserMetadata();
  }
  /** The tools the loop assembled for the last prepared turn — the executable
   *  set the model was handed, which the request's descriptors are not — and
   *  the history it was handed, as the assembly placed it: the conversation
   *  before the step pipeline splices the runtime's dynamic block in. */
  private _preparedTools: ToolSet = {};
  private _prepareFailure: Error | null = null;
  /** The prepared turn's per-step dynamic block, as core's step pipeline
   *  snapshots it: over the profile the turn bound and the tools it built.
   *  Null until a turn is prepared, and again once a preparation is refused. */
  private _preparedDynamic: ((profile: ResolvedTurnProfile, tools: ToolSet) => DynamicContext) | null = null;
  private _preparedExtensions: readonly KinuExtension[] = [];
  harnessPreparedTools(): ToolSet { return this._preparedTools; }
  /** One model step's messages, composed the way core's chat composes every
   *  step: the dynamic block woven over the prepared turn's snapshot. */
  async harnessStep(stepNumber: number, messages: readonly ModelMessage[]): Promise<ModelMessage[]> {
    const profile = this.resolvedTurnProfile();
    const dynamic = this._preparedDynamic;

    if (profile === null || dynamic === null) throw new Error('a model step requires a prepared profile and tool surface');
    // The turn's extension host, composed as the actor session composes it:
    // the backend's per-turn extensions, then the orchestrator's own — whose
    // prepareStep is the step boundary that takes the mid-turn steers in.
    const extensions = new ExtensionHost();

    for (const extension of this._preparedExtensions) extensions.register(extension);
    extensions.register(this.orch.turnExtension);

    const result = await composePrepareStep(
      {
        extensions,
        dynamic: { ledger: this.dynamicLedger, snapshot: () => dynamic(profile, this._preparedTools) },
        // The provider this request is bound for — the destination boundary a
        // replay from another provider is re-keyed at, read as the loop reads it.
        destinationProviderId: this.promptModelContext().provider,
      },
      { stepNumber, messages: [...messages], steps: [] },
    );

    return result?.messages ?? [...messages];
  }
  /** The conversation the admitted turn runs over — the context plane's
   *  resolution, which the claim names — read once the turn holds it. */
  harnessAdmittedHistory(): readonly ModelMessage[] { return [...this.actorSession.history]; }
  /** What refused the last preparation, when one was refused: the loop ends
   *  such a turn as an error, and the driver hands the refusal back as the
   *  preparation's own rejection. */
  harnessTakePrepareFailure(): Error | null {
    const failure = this._prepareFailure;
    this._prepareFailure = null;

    return failure;
  }
  /** Told each lease the loop hands a preparation: the turn's ids and its
   *  abort signal, which a suite that stops the turn reads the cause off. */
  private _leaseObservers: Array<(lease: ActorTurnLease) => void> = [];
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
      // Handed to ONE turn: the next surface the actor builds is its own.
      this._suppliedTools = null;
    }
  }
  /** The tool surface a suite hands the next turns IN PLACE of the actor's
   *  own for the mode the turn was asked in, the way a suite once handed
   *  Think's `beforeTurn` the surface the turn ran on. A surface the assembly
   *  rebuilds for ANOTHER mode — a role imposing Plan on a Build request — is
   *  the actor's own, as it was then. Absent, the actor builds every one. */
  private _suppliedTools: ToolSet | null = null;
  harnessSupplyTools(tools: ToolSet | undefined): void { this._suppliedTools = tools ?? null; }
  protected override getRawToolsForWorkMode(mode: WorkMode, claimScope?: string): ToolSet {
    // The REQUESTED mode is the message's, never the operation a role bound
    // over it: that rebuild is the actor's own surface.
    if (this._suppliedTools !== null && mode === workModeForTurnMetadata(this.turnUserMetadata())) return this._suppliedTools;

    return super.getRawToolsForWorkMode(mode, claimScope);
  }

  /** Start the durable pieces of a turn the model-free harness does not drive. */
  harnessBeginTurn(turnId: string): void {
    this.declareTurnCheckpoint(turnId);
    this.orch.inbox.beginTurn(false);
  }
  /** The model the next turns run on, scripted: the one override point a
   *  suite that runs a turn end to end scripts, instead of the platform's
   *  provider. Held, not consumed by one turn. */
  harnessSupplyTurnModel(model: LanguageModel): void {
    const factory = () => model;
    Object.defineProperty(this, 'modelFactory', { configurable: true, value: factory });
    const turn = () => model;
    Object.defineProperty(this, 'turnModel', { configurable: true, value: turn });
  }
  /** The title the operator chose, so the turn's auto-title effect plans
   *  nothing: persisting it stamps `name_origin`, which stops the naming
   *  policy from matching. For suites that pin the turn, not the title. */
  harnessNameWorkspace(displayName: string): void {
    this.config.setDisplayName(displayName);
    this.config.setDisplayNameOrigin(displayName, 'user');
  }
  /** The analytics plane's write stats: what the writer accepted, refused, or
   *  skipped — the second half of what `harnessFleetTurnRows` pins. */
  harnessFleetStats(): { written: number; refused: number; skipped: number } {
    return fleetStatsForTest(this.env);
  }
  /** A run the loop opened and a dead activation never closed: openTurnRun's
   *  run_start with no run_end, written the way the loop writes one. For
   *  suites that reconcile what the last process left.
   *
   *  The run id is stated, not minted, so the assertion reads the exact run
   *  the reconcile seals. */
  harnessOpenDanglingRun(runId: string): void {
    this.eventRecorder.emit(runId, {
      type: 'run_start', agentId: this.actorHandle().actorId, caused_by: 'chat',
      userMessage: 'the turn the last process died inside',
    });
  }
  /** The wake reconcile's own entry for interrupted runs: what seals a run a
   *  dead activation left open, beside the fork journal it also sweeps. Runs
   *  synchronously, as the wake runs it — no alarm, no fork journal needed
   *  for the seal the fleet gate reads. */
  harnessReconcileInterruptedRuns(): void {
    // The reconcile's own first act, alone: seal the runs a dead activation
    // left open. The fork-journal half needs no run for this; the seal is
    // what the fleet gate reads.
    const open = this.eventRecorder.unterminatedRuns(undefined, Date.now());

    for (const runId of open) this.eventRecorder.emit(runId, { type: 'run_end', reason: 'interrupted' });
  }
  /** The fleet dataset's turn rows, in write order: what observeFleetRows
   *  recorded. Empty in this harness unless a suite installs the plane. */
  harnessFleetTurnRows(): FleetPoint[] {
    return fleetPlaneForTest(this.env).agent.points.map((point) => ({ ...point }));
  }
  /** Open the plane's write window and subscribe the fleet observer, for
   *  suites that pin fleet rows. No-op unless the suite built this actor over
   *  the fleet env: the plane memoises on the env object, so the capture must
   *  be the env the actor was constructed over. Suites that pin fleet rows
   *  pass `fleetEnvForTest(makeEnv())` as the harness env; the window
   *  production opens at the invocation seam is opened here, since without it
   *  the writer refuses every row and the suite would pin refusal, not the
   *  gate. */
  harnessObserveFleetPlane(): void {
    openAnalyticsWindowForTest(this.env);
    this.observeFleetRows();
  }
  /** The live turn's step boundary, for a suite that splices the loop's own
   *  admission into it: the extension host production composes, so a steer's
   *  drain commits the row a real step landing would. */
  async harnessStepInto(stepNumber: number, messages: readonly ModelMessage[]): Promise<ModelMessage[]> {
    return this.harnessStep(stepNumber, messages);
  }

  /**
   * The turn is RUNNING, as the delivery seam asks the question.
   *
   * `BackendHost.turnInFlight` reads this flag, and it is what routes a signal
   * into the live turn's next step instead of into a queued turn of its own. A
   * suite that needs the SPLICED route has to say so, because production sets
   * the flag inside `beforeTurn`, which needs a model this harness cannot
   * drive. `settleTurnEvents` clears it exactly as a real turn does.
   */

  /** The persisted identity a fresh activation uses to stop old device work. */
  harnessPersistActiveTurn(turnId: string): void {
    // A durable CLAIM, which is what a real `beforeTurn` writes: a fresh
    // activation identifies old device work through the claim ledger.
    this.claims.admit({
      runId: `harness-${turnId}`, turnId, workMode: 'build',
      program: { kind: 'builtin', version: 0, digest: null, build: null },
      context: [],
      // Zero, and honest: this harness drives no context plane, so the actor
      // has no recorded working revision for the claim to name.
      workingRevision: 0,
    });
  }

  harnessClearTurnCheckpoint(): void { this._turnCheckpoint = null; }
  harnessDurableTurnId(): string | null { return this.durableTurnId(); }
  /** Replace the delivery seam for a terminal-effect test. The actor still runs
   *  the real signal policy and terminal ledger around this one external port. */
  harnessSetSignalDeliverer(
    deliver: (signal: AgentSignal) => Promise<SendOutcome>,
  ): void {
    Object.defineProperty(this.orch.inbox, 'send', {
      configurable: true,
      value: deliver,
    });
  }



  /** The terminal transition bracket, at the two entry points production uses.
   *  Named rather than reached into, because a suite must claim and settle
   *  through the same methods `onChatResponse` does or it is testing its own
   *  fixture. A transition names the durable turn AND the response being
   *  settled, so a Think auto-continuation gets its own sequence. */
  harnessBeginTerminalTransition(turnId: string | null, messageId = 'a-1') {
    return this.terminal.begin(turnId === null ? null : { turnId, messageId });
  }

  harnessEndTerminalTransition(turnId: string | null, messageId = 'a-1'): void {
    this.terminal.end(turnId === null ? null : { turnId, messageId });
  }

  /** Rows of the effect-claim ledger for a terminal transition — a null result
   *  is an interrupted sequence, no row at all is a released one. */
  harnessTerminalClaims(): Array<{ turn_id: string; call_id: string; result_json: string | null }> {
    // The TERMINAL TRANSITION rows only. The same table also holds tool claims
    // and the keyed markers individual effects use for their own once-only
    // boundaries, and a reader that returned all of them would make every
    // assertion about the transition depend on what the effects wrote.
    return this.sql<{ turn_id: string; call_id: string; result_json: string | null }>`
      SELECT turn_id, normalized_call_id AS call_id, result_json
      FROM tool_effect_claims WHERE normalized_call_id LIKE 'terminal:response:%'
      ORDER BY turn_id, normalized_call_id`;
  }

  /** Every per-effect disposition row of one sequence, in declared order — the
   *  oracle for "which effect actually happened". */
  harnessTerminalEffects(turnId: string, messageId = 'a-1'): Array<{
    effect_key: string; status: string; outcome: string | null; attempts: number;
  }> {
    return this.sql<{ effect_key: string; status: string; outcome: string | null; attempts: number }>`
      SELECT effect_key, status, outcome, attempts FROM terminal_effects
      WHERE sequence_id = ${this.terminal.sequenceId({ turnId, messageId })}
      ORDER BY seq, effect_key`;
  }

  /** Arm a deterministic cut in the terminal sequence: the effect to stop at and
   *  whether to stop before or after its side effect. */
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

  /** Move the ledger's clock past a pending row's backoff, so a replay is due.
   *  The clock, not a sleep: the assertion is about the due-check, and a test
   *  that waited five real seconds would be measuring the schedule. */
  harnessAdvanceTerminalClock(ms: number): void { this._terminalClockSkewMs += ms; }

  /** Turn off the between-turn compute lane this harness cannot run.
   *
   *  Its terminal effect now propagates failure so the row stays OWED until the
   *  compute actually lands — which is the fix under test elsewhere, and which
   *  here would leave every sequence permanently owed because there is no model
   *  behind the harness at all. Disabled through the production config switch, so
   *  what runs is the real "operator turned it off" path rather than a stub. */
  harnessDisableSleepTimeCompute(): void { this.config.setSleepTimeComputeEnabled(false); }

  /**
   * Turn the lane back on with its ANSWER already recorded, so the effect runs
   * for real without a model behind it.
   *
   * That is a production path, not a stub: the compute persists its update before
   * applying it precisely so a replay applies the same answer, and `key` is the
   * effect scope the terminal row carries. Seeding the row is therefore the same
   * state a first attempt leaves, and what runs afterwards is the apply-and-
   * tombstone boundary this exists to test.
   */
  harnessRecordSleepTimeAnswer(key: string, update: SleepTimeUpdate): void {
    this.config.setSleepTimeComputeEnabled(true);
    void this.sql`INSERT INTO sleep_time_updates (effect_key, update_json, created_at)
      VALUES (${key}, ${JSON.stringify(update)}, ${Date.now()})
      ON CONFLICT(effect_key) DO NOTHING`;
  }

  /** The world-model store, through its own API: a hand-written INSERT would be
   *  a second copy of its confidence and provenance policy. */
  harnessFacts(): FactsStore { return this.facts; }
  /** The scaffold's tool bridge for one rollout — what a queued shadow trial's
   *  candidate dispatches through, with the trial's own scope. */
  harnessScaffoldCallTool(callScope?: string) {
    return this.makeScaffoldCallTool(callScope);
  }

  /** Declare one steer branch as in flight, the way `steerAsBranch` does. The
   *  handle never settles: what is under test is the CLAIM shape, and a branch
   *  whose head never reports is exactly the case the durable journal path
   *  exists for. A REJECTED handle would be an unhandled rejection the moment it
   *  was created, before any effect ever read it. */
  /**
   * Spawn one branch head THROUGH ITS OWN PRODUCER — `startBranchHead` over a
   * HeadRuntime that stands in for the facet transport and nothing else.
   *
   * The journal rows are therefore production's, including the one thing a
   * hand-written row cannot get right: a branch run's single head is journalled
   * under a DERIVED id (`branchHeadId(runId)`), not under the run id. Seeding
   * `id: runId` normalised that away, and a cold replay reading the wrong id
   * passed against the fake exactly as it failed against production.
   *
   * `report` null leaves the head RUNNING — spawned, with no report — which is
   * the state an eviction mid-flight really leaves. Otherwise the head reports it
   * at once, whatever status it carries.
   *
   * The head ACTOR is registered too, because `hostHead` registers one before it
   * runs anything and the reclamation sweep reads exactly that roster. What
   * stands in for the run is the report; the registration is real.
   */
  async harnessSpawnBranchHead(
    id: string, task: string,
    report: Pick<HeadReport, 'status' | 'summary' | 'errorMessage'> | null,
  ): Promise<void> {
    const runtime: HeadRuntime = {
      spawnHead: async (input: HeadInput) => {
        // The `exp:`-marked name `hostHead` registers. No second object is
        // created: registering the row IS the whole of a head's existence — it
        // has no database of its own to bring up.
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

  /** Record one branch head as having REPORTED, the way its own run does. The
   *  journal is the authority a cold replay reads, so a settlement test needs a
   *  head that reported rather than one that merely existed. */
  async harnessRecordBranchReport(id: string, task: string, summary: string): Promise<void> {
    await this.harnessSpawnBranchHead(id, task, { status: 'completed', summary });
  }

  /** Land the report of a head spawned by {@link harnessSpawnBranchHead} with
   *  none — the journal write its own run makes when it finishes, addressed by
   *  the same derived head id the spawn used. */
  harnessReportBranchHead(id: string, summary: string): void {
    this.headJournal.recordReport({
      id: branchHeadId(id), status: 'completed', summary,
      evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
      toolCalls: [], stepCount: 1, usage: {}, wallClockMs: 1,
    });
  }

  /** The journalled status of a branch run's single head, or null when no row
   *  exists — the authority a cold replay reads, under the id it reads it by. */
  harnessBranchHeadStatus(id: string): string | null {
    return this.headJournal.readHeadView(branchHeadId(id))?.status ?? null;
  }

  /** Mark every head spawned so far `interrupted`, through the journal's own
   *  cold-activation transition — the non-terminal status a reconciliation
   *  writes before the resume gate decides anything. The bound is what keeps it
   *  from touching a head seeded after this call. */
  harnessMarkHeadsInterrupted(): void {
    this.headJournal.markInterrupted({ spawnedBefore: Date.now() + 1 });
  }

  /** The exploration reclamation pass `onStart` detaches, AWAITED — the sweep
   *  that decides which exploration ACTOR is finished with. It retires roster
   *  rows now rather than deleting databases, so a late sweep costs nothing. */
  harnessReclaimSettledExplorationActors(): Promise<void> {
    return this.reclaimSettledExplorationActors();
  }

  /** The exploration actors this workspace still holds, by registered name.
   *  Read through the DIRECTORY, which is what the sweep retires from — no SDK
   *  sub-agent registry is in play, and the directory is the one authority on
   *  which actors exist. */
  harnessExplorationActors(): string[] {
    return this.actorDirectoryStore().list()
      .filter((record) => record.kind === 'head' || record.kind === 'branch')
      .map((record) => record.name);
  }

  /** The workspace's ONE actor host, for suites that acquire a hosted actor
   *  directly instead of driving a hire. */
  observeActorHost(): ActorHost { return this.actorHost(); }
  /** What an exploration runner needs of this workspace — the same seams the
   *  production head runtime and node seat factory are built from, so a suite
   *  that drives `hostHead`/`hostNodeSeat` runs the workspace's own wiring
   *  rather than a re-declaration of it. */
  observeExplorationSeams(): ExplorationHostSeams { return this.explorationSeams(); }

  /** A hired child's DELEGATED-turn profile, as the runner received it: the
   *  ToolSet it may call and the framing it was told it runs under.
   *
   * The same profile a delegated turn runs: the full-agent surface over the
   * child's own runtime plus the report lane, and the assigned-turn framing
   * rendered from it. Suites that assert the subordinate's model-facing profile
   * (conformance, tool confinement, framing) read this rather than
   * re-declaring the wiring — a re-declaration would agree with itself while
   * the product drifted.
   *
   * OBSERVED THROUGH THE PRODUCTION RUNNER rather than built beside it.
   * `runHostedTask` is where a delegated turn's `HeadInput` is built, and it
   * hands that ONE value to `taskProfile` and to the runner together; what this
   * captures at that seam is therefore the profile the turn really got.
   * Building an input here to build a profile from would be the
   * two-shapes-for-one-turn the builder exists to end, and it would keep
   * agreeing with itself after production's shape moved. The runtime narrowing
   * moved with it: the runner recovers the concrete `CFRuntime` at the one
   * place that needs it.
   *
   * The turn behind the observation reaches the model and fails there — the
   * harness resolves a provider it cannot call under bun — which costs the
   * observation nothing, because the profile is built before the first request.
   * A suite that wants the turn itself injects a model and drives
   * `runHostedTaskTurn` below.
   */
  async observeHostedTaskProfile(child: HostedActor, task: string): Promise<HostedTaskProfile> {
    const seams = this.subordinateSeams();
    // Collected rather than assigned to a nullable: one delegated turn builds
    // one profile, and an EMPTY array is the honest reading of "the runner never
    // reached its profile seam" — which is a broken observation, not an empty one.
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

  /** Drive one delegated task turn for a hired child through the production
   *  runner — admission, confined tools, report relay. For suites that need a
   *  full turn with an injected model rather than the built surface alone.
   *
   *  No `input` member: the runner builds its HeadInput from the one builder
   *  beside the budget, so a second literal here would reintroduce the
   *  two-shapes-for-one-turn the builder exists to end. */
  async runHostedTaskTurn(child: HostedActor, task: string) {
    return runHostedTask(this.subordinateSeams(), child.reference, {
      body: task,
      mode: 'build',
      sequenceId: crypto.randomUUID(),
    });
  }

  /** Instance-level seam override: production resolves models through the
   *  owned model services, which under bun have no provider to resolve.
   *  Everything downstream of resolution — the LLM construction, both sinks —
   *  is the real production path. Stated once here because the services object
   *  is protected: a test cannot reach past it without this. */
  overrideProviderRegistry(registry: AgentProviderRegistry): void {
    Object.assign(this.ownedModelServices, { providerRegistry: (): AgentProviderRegistry => registry });
  }

  /** Forget the live handles, leaving only the durable journal — the state a
   *  fresh activation meets, and the one the settlement key is for. */
  harnessDropPendingBranches(): void { this._pendingBranches.length = 0; }

  harnessDeclarePendingBranch(id: string, task: string): void {
    this._pendingBranches.push({
      id, task,
      handle: new Promise(() => { /* the harness runs no branch heads */ }),
    });
  }

  /** A branch whose head has ALREADY answered — the live path, which settles
   *  through the handle rather than through the journal. What the settlement key
   *  has to cover on both sides: an unkeyed live write and a keyed journal replay
   *  are two take sets for one branch. */
  harnessDeclareLiveBranch(id: string, task: string, summary: string): void {
    this._pendingBranches.push({
      id, task,
      handle: Promise.resolve({
        id, task,
        // The report a real head resolves with carries the HEAD's id, which a
        // branch derives from the run id — the same shape the journal holds.
        result: Promise.resolve({
          id: branchHeadId(id), status: 'completed' as const, summary,
          evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
          toolCalls: [], stepCount: 1, usage: {}, wallClockMs: 1,
        }),
        abort: async () => { await Promise.resolve(); },
      }),
    });
  }

  /** The most recent terminal sequence's own join — resolved once its
   *  disposition is written. Awaited rather than approximated: the detached
   *  effects each await real work, so a fixed number of ticks would assert
   *  against whatever had happened by then rather than against the outcome. */
  harnessTerminalReported(): Promise<void> { return this._terminalReported; }
  /** Every programmatic turn the loop was asked to admit through the host —
   *  a wake, a drain, the rerun of the operator's leftovers — as the seam
   *  handed it over. The turn still runs; this is the observation beside it. */
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
  /** Script the loop's NEXT programmatic admissions, one answer per call, in
   *  order — a thrown admission, a refusal, a durable status — the outcomes a
   *  producer's retry policy is pinned on. Exhausted, the loop's own admission
   *  answers again. Every admission asked, scripted or not, is recorded. */
  private _scriptedAdmissions: Array<() => Promise<EnqueueTurnResult>> = [];
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
  /** The one refusal the loop answers a send with: this process may not
   *  drive. Armed, every admission is refused with it until disarmed. */
  private _driverRefusal: Refusal | null = null;
  harnessRefuseDriving(refusal: Refusal | null): void { this._driverRefusal = refusal; }
  protected override driverGate(): Refusal | null { return this._driverRefusal; }

  /** The wake's arm that resumes the loop, driven by a suite that restarted
   *  the actor: the interrupted turn continues, acknowledged sends rerun. */
  harnessResumeChatLoop(): void { this.resumeChatLoop(); }

  /** Rebuild the reset-lost user queue from its SQL authority for one turn —
   *  the loop's own restore (`restorePendingSends`), which a fresh activation
   *  runs for the turn it re-opens, invoked here on the live actor: the
   *  in-memory queue is dropped first, the way a reset loses it. */
  harnessRestorePendingSteers(turnId: string): void {
    this.orch.inbox.interrupt();

    const store = new PendingSendStore(this.boundSql, this.actorHandle().actorId);

    const pending = store.forTurn(turnId).map((row) => {
      const files = store.files(row.id);

      return files.length > 0 ? { ...row, files } : row;
    });

    this.orch.inbox.restorePending(pending);
  }

  /** The run ledger, so a suite can state the shape the loop's own recovery
   *  reads: an open run is a response that started and has not finished. */
  get harnessEventRecorder(): RunEventRecorder { return this.eventRecorder; }

  /** How many terminal sequences this activation currently owns. The join
   *  condition for an activation's own detached recovery: it acquires each
   *  sequence it recovers and releases it through the close. */
  harnessSequencesInFlight(): number { return this.terminal.inFlightCount; }

  /** The activation pass that finishes what an interrupted terminal transition
   *  still owed, AWAITED — production detaches it from `onStart`. */
  harnessResumeTerminalTransitions(): Promise<void> {
    return this.terminal.resumeAll();
  }

  /** The activation's OWN classification: does this workspace owe a wake?
   *  Production reads exactly this in `onStart` and arms one schedule row on
   *  true, dispatching nothing — so a suite that wants the verdict (and wants
   *  to prove nothing was dispatched with it) asks here. */
  harnessOwedWorkExists(): boolean {
    return this.owedWorkExists();
  }

  /** The budget-first interrupted-fiber prune, exactly as `onStart` runs it. */
  harnessSweepUnrecoverableFibers(): void {
    this.sweepUnrecoverableFiberRows();
  }

  /** The recovery hook, for the one thing the scan hides: what it decided. */
  harnessRecoverFiber(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    return this.onFiberRecovered(ctx);
  }

  /** The improvement lanes, driven through the CLAIMED effect production drives
   *  them through, so a suite cannot settle them by a route production has no
   *  caller for. Returns whether the lanes were open, which is the one verdict
   *  the callers consume. */
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

  /** Switch the advisor on the way an owner does (durable config row) and
   *  replace the reviewer with a scripted one, so a lane assertion observes
   *  recorded notes rather than a live model. */
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

  /**
   * Script the review model and run ONE turn review, the way the deferred review
   * lane runs it.
   *
   * The classifier and the reflection are both `fastLlm` completions, so one
   * scripted responder covers the whole review. Driven directly because the
   * property under test is what a SECOND run of the same review appends — a
   * retry after a refusal — and that is the engine's own boundary.
   */
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

  /** Advisor rows on the audit stream — what a fed lane leaves behind. */
  harnessAdvisorNotes(): number {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM evolution_events
      WHERE type = 'advisor_note'`[0]?.n ?? 0;
  }

  /**
   * Drive the post-turn MCP warm lane, and give it its own capability gate as
   * a real durable row rather than an override.
   *
   * The lane is `protected` on ActorAgent, like every other post-turn lane, so
   * it gets the same kind of seam. What it reads is NOT stubbed: the token
   * comes from an INSERT into `workspace_capability`, which is the table
   * `workspaceCapabilityToken` actually selects from, and the hub comes from the
   * `env.UserDO` binding the production path resolves. Nothing here asserts a
   * type it has not established.
   *
   * The JOIN is harness-local: production never waits on the warm (the next
   * turn finds the connections), so ActorAgent carries no settlement accessor —
   * only the lane's own owner field, which stays protected for exactly this
   * kind of subclass seam.
   */
  async harnessWarmUserMcp(): Promise<void> {
    this.warmUserMcpInBackground();
    await (this._mcpWarmTask?.promise ?? Promise.resolve());
  }

  /** Give this workspace the capability token every user-plane call is gated
   *  on, the way a claim does: one row in the table the reader reads. */
  harnessHoldsCapability(token: string): void {
    void this.sql`INSERT OR REPLACE INTO workspace_capability (id, token) VALUES (1, ${token})`;
  }

  /** The pre-claim state: a workspace whose capability has not been issued. */
  harnessHoldsNoCapability(): void {
    void this.sql`DELETE FROM workspace_capability`;
  }

  /** Join the durable lanes a completed turn detaches, so an assertion reads
   *  settled storage rather than racing a fire-and-forget fiber. */
  harnessJoinDetachedFibers(): Promise<void> { return joinHarnessFibers(); }

  /** Join the activation's own detached tasks (timer, event-delivery and
   *  fork-journal reconciles, facet reclaim). Every one is fenced or
   *  idempotent, so production never waits on them — a test snapshotting state
   *  those sweeps also touch must. */
  harnessSettleBackgroundTasks(): Promise<void> { return this.settleBackgroundTasks(); }

  /** When the ledger would next wake, given the sequences a live activation
   *  claims to be running. The re-arm's own input, read directly. */
  harnessNextRetryAt(inFlight: ReadonlySet<string>): number | null {
    return this.terminal.ledger.nextRetryAt(inFlight);
  }

  /** The ledger's name for one transition — the key the in-flight set holds. */
  harnessSequenceId(turnId: string, messageId: string): string {
    return this.terminal.sequenceId({ turnId, messageId });
  }

  /** Durable fiber rows this activation would hand to recovery. */
  harnessOpenFiberRows(): { id: string; name: string }[] {
    return this.sql<{ id: string; name: string }>`SELECT id, name FROM cf_agents_runs ORDER BY created_at`;
  }

  /** Advisor notes durably recorded for one turn — the row a re-entered lane
   *  guards on, counted from storage rather than from a spy, because the guard
   *  reads storage. */
  harnessNotesForTurn(turnId: string): number {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM evolution_events
      WHERE type = 'advisor_note' AND json_extract(data, '$.turnId') = ${turnId}`[0]?.n ?? 0;
  }
  /** The row a dead activation left, in this actor's own storage. */
  harnessSeedOrphanFiber(name: string, snapshot: JsonValue): string {
    return seedOrphanFiberRow(this.ctx.storage, name, snapshot);
  }
  /**
   * One ordinary tool call's claim, through core's own function — the row an
   * external effect is admitted behind, and the row a turn-wide release drops.
   *
   * Claimed rather than settled: a claim with no result is what a turn that was
   * still executing the call left behind, which is the state the release must
   * not walk over.
   */
  harnessClaimTool(turnId: string, callId: string): void {
    claimToolEffect(this.boundSql, this.actorHandle(), { turnId, callId, digest: 'harness-tool-digest' });
  }
  /** One turn's TOOL claims, by call id — the terminal-transition rows beside
   *  them are `harnessTerminalClaims`, and mixing the two would make every
   *  assertion about the release depend on the sequence's own bookkeeping. */
  harnessToolClaims(turnId: string): string[] {
    return this.sql<{ call_id: string }>`
      SELECT normalized_call_id AS call_id FROM tool_effect_claims
      WHERE turn_id = ${turnId} AND normalized_call_id NOT LIKE 'terminal:response:%'
      ORDER BY normalized_call_id`.map((row) => row.call_id);
  }
  /** The per-step dynamic context, assembled exactly as a model step sees it —
   *  the shared core assembler over this actor's own stores. */
  observeDynamicContext(): DynamicContext {
    return this.dynamicContextSnapshot({ workMode: 'build', allowedTools: [] }, {}, undefined);
  }
}

/** A candidate under trial, so sampling has something to sample against.
 *  Seeded under `runtime.actor` — the pointer is per-actor and that is the handle
 *  every reader under test scopes by, so a row filed anywhere else is
 *  invisible to the gate this is arming. */
export function declareShadowCandidate(runtime: AgentRuntime): void {
  runtime.actor.config.setShadowSampleRate(0.5);
  void runtime.storage.sql`INSERT OR REPLACE INTO scaffold_versions
    (actor_id, version, written_at, rationale, status)
    VALUES (${runtime.actor.actorId}, 1, ${Date.now()}, 'a harness candidate', 'pending')`;
}

/** An actor's stored naming state as a test reads it — the same two rows
 *  `planWorkspaceTitle` decides from. */
export interface ObservedNaming {
  displayName: string | null;
  nameOrigin: 'user' | 'auto' | null;
}

/**
 * A HOSTED ACTOR as a suite drives it.
 *
 * What a suite gets is the production object: a `HostedActor` acquired from the
 * workspace's ONE `ActorHost`, over the ONE database its parent already owns.
 * Its handle, stores, runtime and session are the same ones a real hire runs
 * on, so nothing here needs overriding and there is nothing to keep in step
 * with the SDK.
 *
 * Acquire the production `HostedActor` from the workspace's `ActorHost` so its
 * handle, stores, runtime and session share the workspace database. A fixture
 * that simulates separate child storage cannot establish that the production
 * actors share one physical database.
 */
export interface HostedActorHarness {
  /** The hosted actor itself — handle, stores, runtime, session. */
  readonly actor: HostedActor;
  /** The workspace that hosts it. Named because almost every assertion about a
   *  child is really an assertion about ONE database, and this is where it is. */
  readonly workspace: ActorHarness<HarnessOrchestratorAgent>;
}

/** The side model a harness actor answers routed work with when the suite
 *  scripted none: one empty completion, no provider. */
const SILENT_SIDE_MODEL: LanguageModel = scriptedTurnModel({
  doGenerate: () => ({
    content: [{ type: 'text', text: '' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: 0, reasoning: undefined } },
    warnings: [],
  }),
});

/** What one turn's model call was given, read off the recorded request. */
function requestView(request: ScriptedTurnOptions, model: LanguageModel, identity: SettledTurn, tools: ToolSet, history: readonly ModelMessage[]): PreparedRequest {
  const system = request.prompt.filter((message) => message.role === 'system')
    .map((message) => message.content).join('\n');

  return {
    identity,
    // The history the assembly handed the loop, not the prompt the model saw:
    // the step pipeline splices the runtime's dynamic block into the latter,
    // and the suites read what the turn was started WITH.
    messages: history,
    prompt: promptToModelMessages(request.prompt.filter((message) => message.role !== 'system')),
    system: system === '' ? undefined : system,
    model,
    tools,
    activeTools: request.tools?.map((tool) => tool.name),
    providerOptions: request.providerOptions,
  };
}

/** The SDK prompt a model was called with, as the ModelMessages the loop
 *  assembled — user and assistant text read back the way
 *  `convertToModelMessages` wrote them; tool messages by their call ids. */
function promptToModelMessages(prompt: ScriptedTurnOptions['prompt']): ModelMessage[] {
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

      default:
        return [];
    }
  });
}

/**
 * The turn seam over the root's real loop — core's ChatSession.
 *
 * `prepare` admits the input as a user send and PARKS the turn at its first
 * model call, answering with the request the loop assembled; `settle` scripts
 * what that parked call answers and lets the loop commit it. Between the two
 * the turn is in flight exactly as production's is, so a send routes into it
 * and every row a suite reads after `settle` is the loop's own write. `run`
 * is a send to completion on the harness's model; `enqueue` admits a
 * programmatic turn and `drainEnqueued` lets the pump run it.
 *
 * A suite moved onto this driver sees only what production leaves — the rows,
 * the events, the request the model was handed — and fabricates no state.
 */
export function thinkTurns(agent: HarnessOrchestratorAgent): TurnHarness {
  return chatSessionTurns(agent);
}

/** One parked turn: the request its model call was given, and the gate the
 *  scripted answer opens. */
interface ParkedTurn {
  readonly request: PreparedRequest;
  readonly answer: ReturnType<typeof Promise.withResolvers<ScriptedAnswer>>;
  readonly landed: Promise<SendLanding>;
  readonly identity: SettledTurn;
}

const parkedTurns = new WeakMap<HarnessOrchestratorAgent, ParkedTurn>();

/** The turn id the next admission runs under, when a suite opened one by
 *  name; the loop admits a send under the id the client minted. */
const openedTurns = new WeakMap<HarnessOrchestratorAgent, string>();

/** The model factories this seam installed itself — so a factory a SUITE
 *  installed is told apart from them, and a run over it is a real turn on the
 *  suite's model rather than one the seam scripts. */
const seamFactories = new WeakSet<() => LanguageModel>();

export function chatSessionTurns(agent: HarnessOrchestratorAgent): TurnHarness {
  /** A model that parks on its first call until the answer is scripted, then
   *  answers every later call at once with the same text. */
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
      // The stream, so a CUT answer is what a cut answer is on the loop: the
      // text it streamed before the interrupt, then the abort.
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
              // Everything the answer had streamed is out; the turn is cut
              // here — the cut a Stop makes, which keeps queued steers queued.

              agent.harnessChatLoop.stop();
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            },
          }),
        };
      },
    });
  };

  /** Admit a turn under the ids the suite named (the opened turn, the answer
   *  it will settle with) and park it at its first model call. */
  const admit = async (text: string, mode: WorkMode | undefined, answerId: string | undefined, signal?: AbortSignal): Promise<ParkedTurn> => {
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
    const chosenMode = mode ?? (drivingMode.success && isWorkMode(drivingMode.output) ? drivingMode.output : undefined);

    // A stamped driving message (a signal's `kinuEvent`) is a programmatic
    // turn, admitted through the queue with its metadata; a client's message
    // is sent under its own id and mode, as the transport sends one.
    const landed: Promise<SendLanding> = driving?.stamped === true
      ? agent.harnessEnqueueTurn({ text: driving.text, metadata: driving.metadata ?? {} }).then(() => agent.harnessChatLoop.pumpPromise).then(() => 'turn' as const)
      : agent.harnessChatLoop.send(text, { ...(chosenMode !== undefined && { mode: chosenMode }), ...(turnId !== undefined && { id: turnId }) });
    // A refused send is an outcome the suite reads, not a rejection nobody
    // handles: it lands here as its own arm.

    const refused = (error: Error) => ({ refused: toKinuError({ doing: 'admitting the turn the suite asked for', cause: error, otherwise: 'unavailable' }) });
    const landing = landed.then((value) => ({ landing: value }), refused);

    const outcome = await Promise.race([arrived.promise.then((request) => ({ request })), landing]);

    if ('refused' in outcome) throw outcome.refused;

    if ('landing' in outcome && outcome.landing === 'turn') {
      // The turn ended without a model call: a refused preparation is the
      // suite's to see as the rejection it was.
      await agent.harnessChatLoop.pumpPromise;
      const failure = agent.harnessTakePrepareFailure();

      if (failure !== null) throw failure;
    }

    const request = 'request' in outcome ? outcome.request : null;
    const started = agent.harnessLastTurnStart();
    const identity: SettledTurn = started ?? { turnId: turnId ?? '', messageId: answerId ?? '' };

    if (signal?.aborted) {
      // An admission the suite cut short: the prepared turn is refused — cut
      // at its model call, ended, its preparation gone — and the preparation
      // rejects with the cut's own reason.
      answer.resolve({ messageId: identity.messageId, status: 'aborted' });
      await landing;
      await agent.harnessChatLoop.pumpPromise;
      throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'the preparation was cut'));
    }

    const parked = {
      request: request === null
        ? { identity, messages: [], prompt: [], system: undefined, model, tools: {}, activeTools: undefined, providerOptions: undefined }
        : requestView(request, model, identity, agent.harnessPreparedTools(), agent.harnessAdmittedHistory()),
      answer, landed, identity,
    };

    parkedTurns.set(agent, parked);

    return parked;
  };

  /** Let the parked turn settle with the answer, then the whole pump run —
   *  the answer's commit and the terminal sequence it owes. A turn the loop
   *  could not CLOSE rejects with that failure, as a settle always did; an
   *  answer that is itself an error (an overflow, a provider refusal) is the
   *  modelled outcome the suite scripted and settles like any other. The two
   *  are told apart the way an operator tells them apart: the loop names a
   *  close failure as a diagnostic, and a scripted error is not one. */
  const finish = async (parked: ParkedTurn, answer: ScriptedAnswer): Promise<SettledTurn> => {
    const closeFailures: string[] = [];

    // A fresh console logger beside the listener, never the `diagnostics`
    // proxy: the proxy forwards to the CURRENT sink, which is this composite.
    const restore = setDiagnosticsSink(createCompositeLogger([createConsoleLogger(), {
      event: () => {},
      failure: (name, error) => {
        // The cause is what the suite named: the effect that was interrupted,
        // not the loop's wrapper around it.
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

      // A suite that installed its own model runs the turn ON that model: the
      // tool calls it scripts are the turn's, and the answer is whatever it
      // streams. The seam scripts 'ok' only when nobody supplied a model.
      if (installed !== undefined && !seamFactories.has(installed)) {
        const landing = await agent.harnessChatLoop.send(text);
        await agent.harnessChatLoop.pumpPromise;
        const last = agent.harnessTranscript.history().at(-1);

        return { status: landing === 'turn' ? 'completed' : 'skipped', message: last?.role === 'assistant' ? last : undefined };
      }

      const parked = await admit(text, undefined, undefined, options?.signal);
      parked.answer.resolve({ messageId: parked.identity.messageId, text: 'ok' });
      const landing = await parked.landed;
      await agent.harnessChatLoop.pumpPromise;
      const last = agent.harnessTranscript.history().at(-1);

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
        request: requestView(request, model, identity, agent.harnessPreparedTools(), agent.harnessAdmittedHistory()),
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
        request: requestView(request, model, identity, agent.harnessPreparedTools(), agent.harnessAdmittedHistory()),
        answer, landed, identity,
      };

      parkedTurns.set(agent, parked);

      return parked.request;
    },

    async prepare(input) {
      const lastUser = input.messages.map((message) => message.role).lastIndexOf('user');
      const user = lastUser === -1 ? undefined : input.messages[lastUser];
      // Everything before the driving message is the conversation the turn
      // is admitted over: the actor's working history, as a restored
      // revision holds it.
      const prior = lastUser === -1 ? [...input.messages] : input.messages.slice(0, lastUser);

      if (prior.length > 0) agent.harnessSeedHistory(prior);
      const content = user?.content;
      const text = content === undefined ? '' : v.is(v.string(), content) ? content : content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
      const mode = v.safeParse(v.object({ kinuMode: v.string() }), input.body);
      agent.harnessSupplyTools(input.tools);
      const parked = await admit(text, mode.success && isWorkMode(mode.output.kinuMode) ? mode.output.kinuMode : undefined, undefined, input.signal);

      return parked.request;
    },

    async step(stepNumber, messages) {
      return agent.harnessStep(stepNumber, messages);
    },

    async settle(answer) {
      if (answer.unreadableRole !== undefined) agent.harnessNextAnswerUnreadable(answer.unreadableRole);

      if (answer.persistFails === true) agent.harnessNextAnswerUndurable();
      // A prepared turn is parked at its model call and settles under the
      // answer's name; an unprepared settle runs a turn of its own, named by
      // the suite's opened turn and this answer. Either way the parked entry
      // is consumed, so the next settle starts a new turn.

      if (answer.turnId !== undefined && !parkedTurns.has(agent) && !openedTurns.has(agent)) openedTurns.set(agent, answer.turnId);
      const parked = parkedTurns.get(agent) ?? await admit(answer.turnId ?? answer.messageId, undefined, answer.messageId);
      parkedTurns.delete(agent);

      return finish(parked, answer);
    },

    open(turnId) {
      openedTurns.set(agent, turnId);
    },

    async openInFlight(turnId) {
      openedTurns.set(agent, turnId);
      await admit('a live turn', undefined, undefined);
    },
  };
}

export interface ActorHarness<T> {
  readonly agent: T;
  readonly db: Database;
  /** All user tables currently in the actor's storage. */
  tableNames(): string[];
}


/**
 * THE Durable Object state this directory constructs, for every fixture in it.
 *
 * Exported because `helpers/hosted-workspace.ts` needs the same object and a
 * second hand-rolled one is a second answer to "which platform members does a
 * constructed actor actually reach" — the two would drift the moment one grew
 * a member the other lacked, and the drift would surface as a fixture passing
 * over a surface production does not have. `id` names the object, which is what
 * `ctx.id.toString()` answers to everything that files a row under an agent id.
 */
export function makeCtx(db: Database, id = 'harness-actor'): AgentContext {
  const canonicalSql = makeSqlExec(db);

  const sqlExec = (query: string, ...bindings: SqlValue[]) => {
    const rows = canonicalSql.exec(query, ...bindings).toArray();

    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  };

  // The KEY-VALUE half of Durable Object storage, beside the SQL half. Real for
  // the same reason `transactionSync` is: the SDK records a facet's own lineage
  // here — `_cf_initAsFacet` puts `cf_agents_parent_path` — and the owner's
  // existing-only inspection reads that row back before it will traverse the hop
  // it names. An inert `get` answered `undefined` for every key, so that read
  // could only ever fail, and a lineage check that always refuses is
  // indistinguishable from one that always admits. A key nobody wrote still
  // resolves `undefined`, which is the platform's answer too.
  const kv = new Map<string, JsonValue>();

  const context = {
    storage: {
      sql: { exec: sqlExec },
      // Real, not a callback passthrough: the durable filesystem's atomicity
      // rests on this, and a fake turns every atomic write into a torn one
      // that still reports success. Nimbus refuses to boot without it.
      transactionSync: <T>(closure: () => T): T => db.transaction(closure)(),
      get: async (key: string): Promise<JsonValue | undefined> => kv.get(key),
      put: async (key: string, value: JsonValue): Promise<void> => { kv.set(key, value); },
      // The durable per-actor shell state Nimbus's programmatic surface keeps,
      // and the delete it performs when a port capability is revoked — which
      // answers whether a row was there, as the platform's does.
      delete: async (key: string) => kv.delete(key),
      // The facet manager's launch journal and port reservations: listed by
      // prefix, claimed inside a transaction, synced after a release.
      list: async <T,>(options: { prefix: string }): Promise<Map<string, T>> => {
        const entries = new Map<string, JsonValue>();

        for (const [key, value] of kv) {
          if (key.startsWith(options.prefix)) entries.set(key, value);
        }

        // SAFETY: the storage list contract types each row by the caller's T,
        // which the untyped stand-in rows cannot name; `never` keeps the Map
        // assignable to every T.
        return entries as Map<string, never>;
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
        // workerd's `storage.deleteAll()` empties BOTH halves — the KV pairs
        // and every SQLite table. Clearing only the map would leave a
        // "destroyed" object whose tables a test can still read.
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
 *
 * `parent` binds a REAL orchestrator instance under the `OrchestratorAgent`
 * name, which is how a subordinate reaches the agent that hired it
 * (`getAgentByName(env.OrchestratorAgent, …)`). Both halves of the parent↔child
 * handshake — seeding an identity, recording a title on the parent's roster —
 * then run as production code against a production roster, in one process. The
 * facet itself is still workerd-only, so this is the parent hop and nothing
 * else.
 */

/** What the owner's UserDO was asked for, and what it answers with, when a test
 *  supplies a recording binding instead of the refusing default. */
export interface RecordedUserPlaneCalls {
  warmConnections: UserCaller[];
  /** Set to make `userMcp_warmConnections` reject, the way an unreachable
   *  third-party server makes it. */
  failWarm: Error | null;
  /** Set to make the turn's `userMcp_toolDescriptors` read reject with exactly
   *  this error, so a suite can drive the failure CLASS the turn tolerates and
   *  the class it must not. Unset, the read is unreachable like every other
   *  undeclared owner-plane member. */
  failDescriptors?: Error;
  /** The owner profile `getProfile` answers with. Null is a claimed workspace
   *  whose owner carries no verified address, which the email trust gate
   *  refuses on — a different refusal from an unauthorized sender. */
  profile?: { email: string } | null;
  /** Every display name this root committed through the owner's registry. */
  titles: string[];
}

/**
 * The world a harness actor is placed in, for a suite that drives the user
 * plane FOR REAL rather than describing it.
 *
 * `userDO` is the owner's own Durable Object, bound at `env.UserDO` — so the
 * device transport, the capability gate and the consent chokepoint the runtime
 * builds are the production ones over real state. `workspace` is the actor's
 * DO name, which IS `workspaceName()`: the key device consent and the exec
 * planes are scoped by. Both must be set before the runtime is first read,
 * which is why they are construction options rather than later mutations.
 */
export interface HarnessActorWorld {
  userDO?: UserDO;
  workspace?: string;
  /** The owner claim written into `workspace_identity`. */
  ownerUserId?: string;
}

/** The one read the instruction-trust authority performs against a parent. */
interface HarnessInstructionAuthority {
  getWorkspaceInstructionApprovals(): Promise<readonly never[]>;
}

/** The parent DO namespace an actor's env carries: what `idFromName`/`get`
 *  answer. A harness passes a real parent agent or a deny-stub namespace. */
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
    // The platform gateway is the harness's model provider: a parseable gateway
    // URL plus a recording AI binding, since the transport is the binding now.
    ...platformGatewayEnv(),
    UserDO: {
      idFromName: (n: string) => ({ toString: () => n }),
      // Recording when a test asked for it, refusing otherwise. The refusing
      // default is the point: a path that reaches the user plane without saying
      // it would fails loudly rather than silently succeeding against a double.
      // What a CLAIMED root's owner plane actually answers on a settled turn or
      // an OPEN: the title registry, the owner profile, the MCP warm, and the
      // release board the workspace-open payload reads for tab presence. The
      // harness declares an owner and holds a capability, so refusing these
      // would make every settle owe a title it can never land, file a failure for
      // a connect nobody asked about, and fail the mount round trip outright.
      // Everything else still refuses, which is what keeps a path that reaches
      // the user plane unannounced from passing against a double.
      //
      // A suite that supplies a REAL UserDO gets that instead, whole: the point of
      // `world.userDO` is to drive production code over production state.
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
            throw userPlane?.failDescriptors
              ?? new Error('harness UserDO: userMcp_toolDescriptors is not reachable under bun');
          },
          getProfile: async (): Promise<{ email: string } | null> => userPlane?.profile ?? null,
          // An EMPTY board, which is the honest answer for a workspace no test
          // has bound a release source to: `getWorkspaceTabPresence` gates the
          // Releases tab on `changes.length`, so an empty board is a tab the
          // surface correctly does not show.
          getReleaseBoard: async (): Promise<ReleaseBoard> => ({
            bindings: [], changes: [], checks: [], approvals: [], deployments: [],
          }),
        };

        return new Proxy(ownerPlane, {
          get: (target, prop) => {
            if (prop === 'then') return undefined;

            if (prop in target) {
              // SAFETY: the `prop in target` guard makes the key one of the owner plane's own members.
              return target[prop as keyof typeof target];
            }

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
      OrchestratorAgent: { idFromName: (n: string) => n, get: () => parent },
    });
  }

  const env: Partial<Env> = {};
  Object.assign(env, bindings);

  // SAFETY: the ActorAgent dependency contract only reads the constructed
  // LOADER, UserDO, and gateway bindings in this harness; each
  // unsupported operation throws if schema composition begins invoking it.
  return env as Env;
}

function instantiate<T extends object>(
  Actor: new (ctx: AgentContext, env: Env) => T,
  db: Database,
  parent?: HarnessOrchestratorAgent,
  userPlane?: RecordedUserPlaneCalls,
  world?: HarnessActorWorld,
  parentNamespace?: HarnessParentNamespace,
  /** A suite's own env, whole, in place of the harness one: the parent
   *  namespace a facet reaches over RPC, the sandbox binding its runtime reads. */
  env?: Env,
): ActorHarness<T> {
  const builtEnv = env ?? makeEnv(parent, userPlane, world, parentNamespace);
  const agent = new Actor(makeCtx(db), builtEnv);

  if (env === undefined && parent === undefined && parentNamespace === undefined) {
    // This workspace answers its own standing-policy reads: a hosted actor's
    // runtime shares this env, and its approval gate fetches the ROOT's policy
    // through the OrchestratorAgent namespace — which, with no parent hop to
    // reach across, is this object. Without it every shell exec dies in the
    // gate on `env.OrchestratorAgent.get`, a harness gap rather than a refusal.
    Object.assign(builtEnv, {
      OrchestratorAgent: { idFromName: (n: string) => n, get: () => agent },
    });
  }

  Object.defineProperty(agent, 'name', { value: world?.workspace ?? 'harness-parent', configurable: true });

  return {
    agent,
    db,
    tableNames: () => db.prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND type='table' ORDER BY name",
    ).all().map((row) => row.name),
  };
}

/**
 * The actor's own schema half of an activation.
 *
 * ONE arm: a hosted actor has no activation of its own to run — its schema IS
 * the workspace's, ensured here once — so there is no actor class for this
 * function to discriminate on.
 *
 * The production override can simply be called: the SCHEMA half is in place
 * synchronously when it returns (DDL is the gate's synchronous prefix). The
 * boot itself is async — the admitted workspace boot — and its promise is
 * deliberately dropped: a failed boot classifies inside `onStart` and never
 * throws, and suites that need the BOOTED workspace await the memoized session
 * through ordinary operations.
 */
function ensureActorSchema(agent: InstanceType<typeof OrchestratorAgent>): void {
  const gate: unknown = OrchestratorAgent.prototype.onStart.call(agent);
  void gate;
}

/** A real OrchestratorAgent with a claimed owner, schema ensured.
 *
 *  `userPlane` opts into a RECORDING owner-UserDO binding. Without it the
 *  binding refuses every method, which is what keeps a path that reaches the
 *  user plane unannounced from passing against a double. `world` goes further:
 *  it places the actor in a real owner's Durable Object under a real workspace
 *  name, for suites that drive device consent and capability tokens rather
 *  than describing them. */
export function orchestratorHarness(
  userPlane?: RecordedUserPlaneCalls,
  world?: HarnessActorWorld,
  env?: Env,
): ActorHarness<HarnessOrchestratorAgent> {
  const harness = instantiate(HarnessOrchestratorAgent, new Database(':memory:'), undefined, userPlane, world, undefined, env);
  ensureActorSchema(harness.agent);
  harness.db.prepare(
    'UPDATE workspace_identity SET owner_user_id = ? WHERE id = ?',
  ).run(world?.ownerUserId ?? 'harness-owner', 'harness-actor');
  // The capability a claimed workspace holds. Without it this root cannot reach
  // its title registry, so every settle would owe an auto title forever — a
  // property of the harness, not of the sequence under test.
  harness.agent.harnessHoldsCapability('harness-capability');
  harness.agent.declareScaffoldPresent();
  harness.agent.harnessDisableSleepTimeCompute();

  return harness;
}

/**
 * A HALF-BORN workspace object: named at the platform, dead before its schema.
 *
 * The state a creation that threw between `idFromName` and `onStart` leaves —
 * the constructor ran (the SDK's own `cf_agents_schedules` and the capability
 * tables exist) but `ensureSchema` never did, so `workspace_identity` is
 * absent and every owner read against it throws. Deliberately nothing is
 * claimed: there is no owner row to seed.
 */
export function halfBornOrchestratorHarness(
  world?: HarnessActorWorld,
): ActorHarness<HarnessOrchestratorAgent> {
  return instantiate(HarnessOrchestratorAgent, new Database(':memory:'), undefined, undefined, world);
}

/**
 * A FRESH activation over storage that survived — the eviction, as the platform
 * performs it.
 *
 * A new actor instance on the same Database is exactly what an isolate reset
 * leaves: every in-memory latch gone, every durable row intact. A test that
 * re-drove the same instance would be measuring a second call, not a recovery,
 * and every RAM-held guard would still be holding.
 */
export async function reactivateOrchestratorHarness(
  db: Database,
  userPlane?: RecordedUserPlaneCalls,
  /** Armed BEFORE the activation's own reconcile runs, because that reconcile is
   *  the recovery under test: a clock skew or fault applied afterwards would
   *  arrive too late to affect it. */
  opts?: {
    readonly clockSkewMs?: number;
    readonly fault?: [TerminalEffectName, TerminalEffectPhase];
    /** The recorded sleep-time answer this activation replays with the lane ON.
     *  Armed here for the same reason as the skew: the reconcile below IS the
     *  replay, so a lane re-enabled after it arrives too late. */
    readonly sleepTimeAnswer?: readonly [key: string, update: SleepTimeUpdate];
    /**
     * WHICH OBJECT this activation is, in the same shape
     * {@link orchestratorHarness} takes it.
     *
     * A restart does not rename a Durable Object, so a suite whose first
     * activation named its workspace has to name the second one too — and the
     * name is not decoration. It IS `workspaceName()`, which the exec planes,
     * device consent and the fork publication's own fence are keyed by, so an
     * eviction that came back as `harness-parent` is a different object than
     * the one that died. Passed to the constructor rather than assigned
     * afterwards for the reason {@link HarnessActorWorld} states: the runtime
     * reads it once.
     */
    readonly world?: HarnessActorWorld;
    /** Configure a fresh activation before its real onStart recovery runs. */
    readonly beforeStart?: (agent: HarnessOrchestratorAgent) => void;
  },
): Promise<ActorHarness<HarnessOrchestratorAgent>> {
  const harness = instantiate(HarnessOrchestratorAgent, db, undefined, userPlane, opts?.world);

  // BEFORE `onStart`, because `onStart` is what starts the recovery under test:
  // a skew or fault armed after it would arrive too late to affect the pass it
  // is meant to steer.
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

  // The activation's OWN reconcile, JOINED on its observable end state. `onStart`
  // detaches it (it sends mail) and it ACQUIRES each sequence it recovers, so a
  // suite that called a second reconcile would be turned away by the first's
  // ownership and would read the rows as untouched. Waiting on the in-flight set
  // waits on the thing that actually decides, and is bounded so a recovery that
  // genuinely never finishes fails the test instead of hanging it.
  // Unconditional laps first: the reconcile is DETACHED, so at the moment this
  // returns from `onStart` it has not yet acquired anything and an in-flight
  // check would read zero and let the suite assert into the middle of it.
  for (let tick = 0; tick < 8; tick++) await joinHarnessFibers();

  for (let tick = 0; tick < 200 && harness.agent.harnessSequencesInFlight() > 0; tick++) {
    await joinHarnessFibers();
  }

  return harness;
}


/**
 * A real hired subordinate, hosted by a real workspace, in one process and one
 * database.
 *
 * Seeded through the PRODUCTION path — the parent's own `SubordinateRuntime` —
 * so the row that exists is the row a hire writes. The child is then acquired
 * from the workspace's one `ActorHost`, which is what binds its stores, builds
 * its runtime over its own `.kinu/agents/<storage-key>/` subtree and its own
 * home credential, and seeds its loop pointer.
 *
 * Nothing about the identity is stated by the fixture. There is no owner,
 * workspace or depth for a child to claim and be checked against: those are
 * columns on its `workspace_actors` row, written by the directory under the
 * parent's authority, so the whole `getSubordinateBootstrapIdentity`
 * round-trip — and the class-name lineage check it existed to defend — has
 * nothing left to verify.
 */
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
    // Durable unless a scenario says otherwise: this stands in for a HIRE, and
    // the temporary rung has its own tests.
    lifetime: 'durable',
    mission: identity.mission,
    role: identity.roleId ?? 'task',
    // Absent, not null: the parent pinned no tier, so the child's role derives
    // one. A literal null would be a pin on "no tier", which is a different
    // instruction and one the catalog cannot honour.
    creationId: crypto.randomUUID(),
  };

  const reference = await workspace.agent.observeSubordinateRuntime().spawn(seed);
  const actor = await workspace.agent.observeActorHost().acquire(reference);

  return { actor, workspace };
}

/**
 * One exploration actor of the given kind, hosted and acquired.
 *
 * Head and rollout-branch fixtures use the same directory registration
 * and `acquire` sequence. Their registered kind is the one differing argument.
 */
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

/** The workspace's own main actor, as a hosted actor — so a suite can assert
 *  the four kinds through one shape instead of special-casing the root. */
export async function hostedMainActor(
  workspace: ActorHarness<HarnessOrchestratorAgent>,
): Promise<HostedActorHarness> {
  const host = workspace.agent.observeActorHost();
  const actor = await host.acquire(actorReferenceOf(workspace.agent.observeRuntime().actor));

  return { actor, workspace };
}
