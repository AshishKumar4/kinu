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
 * Boundaries stated honestly: nothing here can RUN a model turn (Think's loop
 * needs workerd) or execute codemode (env.LOADER is a stub that throws). This
 * harness is for observing composition output, not for driving inference.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { AgentContext, FiberRecoveryContext, FiberRecoveryResult } from 'agents';
import type { ToolSet } from 'ai';
import type { UserCaller } from '../../src/user/workspace-capability';
import type { UserDO } from '../../src/user/user-do';
import { shadowTrialPlan, claimToolEffect } from '@kinu.run/core';
import {
  BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC, profileCatalogDigest,
  type AgentOrchestrator, type AgentRuntime, type CompletedTurn, type DynamicContext,
  type IngressDescriptor, type ProfileCatalogEnvelope, type ProviderCatalogSnapshot,
  type RunEndReason, type SqlExecRow, type SqlValue, type SubordinateRosterStore,
  projectJsonValue,
  type BackgroundJobStore, type JsonValue,
  type DeviceConsentDecision, type DeviceConsentRequest, type DeviceStatus,
  type WorkMode, type JsonObject,
  startBranchHead, branchHeadId,
  type HeadInput, type HeadReport, type HeadRuntime,
  type ShellApprovalRequest,
  type FactsStore, type SleepTimeUpdate,
  type AgentSignal, type SignalOutcome, type ReleaseBoard,
} from '@kinu.run/core';
import { joinHarnessFibers, mockAgentsSdk, seedOrphanFiberRow } from './agents-sdk';
import { platformGatewayEnv } from './platform-gateway';
import {
  TerminalEffectInterrupt,
  type TerminalEffectName, type TerminalEffectPhase,
} from '@kinu.run/core';

mockAgentsSdk();

const { OrchestratorAgent } = await import('../../src/orchestrator');
const { SubordinateAgent } = await import('../../src/subordinate-agent');

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
  observeRawTools(): ToolSet { return this.getRawTools(); }
  /** The backend-agnostic per-turn logic, for suites asserting what the
   *  steering + opportunity ledger saw. */
  observeOrch(): AgentOrchestrator { return this.orch; }
  /** The assembled runtime, for the conformance observer's `producer` plane. */
  observeRuntime(): AgentRuntime { return this.rt; }
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
  protected override async profileInputs() {
    return { envelope: HARNESS_PROFILE_ENVELOPE, provider: HARNESS_PROVIDER_SNAPSHOT };
  }
  /** A cold activation: the owner row persists in SQL, in-memory latches do
   *  not — the state every claimOwner RPC meets on a freshly-activated DO. */
  forgetActivationLatches(): void { this._scaffoldReady = false; }
  /**
   * A further activation, through the ACTOR's own `onStart` — the sweep, the
   * wake reconcile, the stale-delivery unbind, exactly as the platform calls
   * them on a cold start.
   *
   * `agent.onStart()` is NOT that entry point and looks like it is: the vendor
   * chat base installs its own `onStart` ahead of this class's, and under the SDK
   * mock that one throws inside `_setupProtocolHandlers` (no sockets here) and is
   * swallowed as an unhandled rejection. A test that called it therefore
   * activated NOTHING while reading as an activation — which is how a suite
   * asserting the stale sweep could watch the row it seeded survive. Named here
   * because `ensureActorSchema` below already has to reach past the same shadow.
   */
  activateActor(): Promise<void> { return Promise.resolve(super.onStart()); }
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

  /** A candidate under trial, so sampling has something to sample against. */
  harnessDeclareShadowCandidate(): void {
    this.config.setShadowSampleRate(0.5);
    void this.sql`INSERT OR REPLACE INTO scaffold_versions
      (version, written_at, rationale, status)
      VALUES (1, ${Date.now()}, 'a harness candidate', 'pending')`;
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
    this.messages.push({
      id: `u-msg-${this.messages.length}`,
      role: 'user',
      parts: [{ type: 'text', text }],
      metadata,
    });
  }

  /** Start the durable pieces of a turn the model-free harness does not drive. */
  harnessBeginTurn(turnId: string): void {
    this.declareTurnCheckpoint(turnId);
    this.userSteer.beginTurn();
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
  harnessMarkTurnInFlight(): void { this._inFlight = true; }

  /** The persisted identity a fresh activation uses to stop old device work. */
  harnessPersistActiveTurn(turnId: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO active_durable_turn (id, turn_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET turn_id = excluded.turn_id',
      turnId,
    );
  }

  harnessClearTurnCheckpoint(): void { this._turnCheckpoint = null; }
  harnessDurableTurnId(): string | null { return this.durableTurnId(); }
  /** Replace the delivery seam for a terminal-effect test. The actor still runs
   *  the real signal policy and terminal ledger around this one external port. */
  harnessSetSignalDeliverer(
    deliver: (signal: AgentSignal) => Promise<SignalOutcome>,
  ): void {
    Object.defineProperty(this.orch.signals, 'deliver', {
      configurable: true,
      value: deliver,
    });
  }


  /** Rebuild the reset-lost steer drain from its SQL authority for one turn. */
  harnessRestorePendingSteers(turnId: string): void {
    this.userSteer.interrupt();
    const pending = this.sql<{ id: string; text: string }>`
      SELECT id, text FROM pending_steers WHERE turn_id = ${turnId} ORDER BY seq ASC`;
    this.userSteer.restorePending(pending);
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
   * The facet is registered too, because `spawnHeadFacet` registers one before it
   * runs anything and the reclamation sweep reads exactly that registry. The
   * facet's RPCs are workerd-only, so what stands in for the run is the report;
   * the registration is real.
   */
  async harnessSpawnBranchHead(
    id: string, task: string,
    report: Pick<HeadReport, 'status' | 'summary' | 'errorMessage'> | null,
  ): Promise<void> {
    const runtime: HeadRuntime = {
      spawnHead: async (input: HeadInput) => {
        await this.subAgent(this.explorationFacet(), input.id);
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

  /** The facet reclamation pass `onStart` detaches, AWAITED — the sweep that
   *  decides which exploration facet keeps its storage. */
  harnessReclaimSettledExplorationFacets(): Promise<void> {
    return this.reclaimSettledExplorationFacets();
  }

  /** The exploration facets this workspace still holds storage for, by name.
   *  Read through the SDK's own registry, which is what the sweep deletes from. */
  harnessExplorationFacets(): string[] {
    return this.listSubAgents(this.explorationFacet()).map((facet) => facet.name);
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
   *  them through — the compound spine that used to sit here has no production
   *  caller left. Returns whether the lanes were open, which is the one verdict
   *  the callers of the old method consumed. */
  async harnessSettleSpine(
    input: { status: RunEndReason; turn: CompletedTurn; workMode?: WorkMode },
  ): Promise<boolean> {
    const lanes = this.terminalEffectTable().improvement_lanes;
    if (lanes === undefined) return false;
    const outcome = await lanes.run({
      status: input.status,
      turn: projectJsonValue({ value: input.turn }),
      workMode: input.workMode ?? this.turnWorkMode(),
      advisor: projectJsonValue({ value: this.advisorSnapshotFor(input.turn) }),
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
    claimToolEffect(this.boundSql, { turnId, callId, digest: 'harness-tool-digest' });
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
  /** A live turn, which no test can produce without a model. */
  declareTurnInFlight(inFlight: boolean): void { this._inFlight = inFlight; }
  /** The per-step dynamic context, assembled exactly as a model step sees it —
   *  the shared core assembler over this actor's own stores. */
  observeDynamicContext(): DynamicContext { return this.dynamicContextSnapshot(); }
  /** Park one deferred shell approval, the way the run gate does. */
  harnessParkShellApproval(req: ShellApprovalRequest) {
    return this.deferrals.park(req);
  }
  /** Raise one device-consent prompt without awaiting its answer — the parked
   *  state a dynamic-context approval row names. The caller owns the promise. */
  harnessAwaitDeviceConsent(req: DeviceConsentRequest): Promise<DeviceConsentDecision> {
    return this.awaitDeviceConsent(req);
  }
}

/** An actor's stored naming state as a test reads it — the same two rows
 *  `planWorkspaceTitle` decides from. */
export interface ObservedNaming {
  displayName: string | null;
  nameOrigin: 'user' | 'auto' | null;
}

export class HarnessSubordinateAgent extends SubordinateAgent {
  /** The base join seam, surfaced for suites that assert the SETTLED
   *  post-activation world — same bridge the orchestrator harness carries. */
  harnessSettleBackgroundTasks(): Promise<void> { return this.settleBackgroundTasks(); }

  /** The production activation, same bridge the orchestrator harness carries. */
  activateActor(): Promise<void> { return Promise.resolve(super.onStart()); }

  observeRawTools(): ToolSet { return this.getRawTools(); }
  observeRuntime(): AgentRuntime { return this.rt; }
  declareScaffoldPresent(): void { this._scaffoldReady = true; }
  protected override async profileInputs() {
    return { envelope: HARNESS_PROFILE_ENVELOPE, provider: HARNESS_PROVIDER_SNAPSHOT };
  }
  /** One first-interaction titling pass — the call `onChatResponse` makes on an
   *  owner-driven turn. */
  titleFromFirstMessage(userText: string): Promise<void> { return this.maybeAutoTitle(userText); }
  /** Whose title this child believes it carries. The authority that decides
   *  whether a later auto-title may run at all. */
  observeNaming(): ObservedNaming {
    return { displayName: this.config.getDisplayName(), nameOrigin: this.config.getNameOrigin() };
  }
  /** The identity row its parent seeded, which is what its prompt reads. */
  observeIdentitySoul(): Promise<string> { return this.loadSoulText(); }
}

export interface ActorHarness<T> {
  readonly agent: T;
  readonly db: Database;
  /** All user tables currently in the actor's storage. */
  tableNames(): string[];
}

function nativeBindings(values: SqlValue[]): SQLQueryBindings[] {
  return values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

function makeCtx(db: Database): AgentContext {
  const sqlExec = (query: string, ...bindings: SqlValue[]) => {
    const stmt = db.prepare<SqlExecRow, SQLQueryBindings[]>(query);
    const bound = nativeBindings(bindings);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
      const rows = stmt.all(...bound);
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    }
    stmt.run(...bound);
    const rows: SqlExecRow[] = [];
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  };
  const context = {
    storage: {
      sql: { exec: sqlExec },
      // Real, not a callback passthrough: the durable filesystem's atomicity
      // rests on this, and a fake turns every atomic write into a torn one
      // that still reports success. Nimbus refuses to boot without it.
      transactionSync: <T>(closure: () => T): T => db.transaction(closure)(),
      get: async () => undefined,
      put: async () => {},
      // The durable per-actor shell state Nimbus's programmatic surface keeps,
      // and the delete it performs when a port capability is revoked.
      delete: async () => true,
      deleteAll: async () => {},
      setAlarm: async () => {},
      getAlarm: async () => null,
      deleteAlarm: async () => {},
    },
    id: { toString: () => 'harness-actor', name: 'harness-actor' },
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

function makeEnv(
  parent?: HarnessOrchestratorAgent,
  userPlane?: RecordedUserPlaneCalls,
  world?: HarnessActorWorld,
  parentNamespace?: HarnessParentNamespace,
): Env {
  const bindings = {
    LOADER: { get: () => { throw new Error('harness LOADER: codemode is not executable under bun'); } },
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
): ActorHarness<T> {
  const agent = new Actor(makeCtx(db), makeEnv(parent, userPlane, world, parentNamespace));
  if (world?.workspace !== undefined) {
    Object.defineProperty(agent, 'name', { value: world.workspace, configurable: true });
  }
  return {
    agent,
    db,
    tableNames: () => db.prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND type='table' ORDER BY name",
    ).all().map((row) => row.name),
  };
}

function ensureActorSchema(
  agent: InstanceType<typeof OrchestratorAgent> | InstanceType<typeof SubordinateAgent>,
): void {
  // The production override can simply be called: the SCHEMA half is in place
  // synchronously when it returns (DDL is the gate's synchronous prefix). The
  // orchestrator gate is async — the admitted workspace boot — and its
  // promise is deliberately dropped: a failed boot classifies inside onStart
  // and never throws, and suites that need the BOOTED workspace await the
  // memoized session through ordinary operations.
  if (agent instanceof OrchestratorAgent) {
    const gate: unknown = OrchestratorAgent.prototype.onStart.call(agent);
    void gate;
  } else {
    SubordinateAgent.prototype.onStart.call(agent);
  }
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
): ActorHarness<HarnessOrchestratorAgent> {
  const harness = instantiate(HarnessOrchestratorAgent, new Database(':memory:'), undefined, userPlane, world);
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
    /** Configure a fresh activation before its real onStart recovery runs. */
    readonly beforeStart?: (agent: HarnessOrchestratorAgent) => void;
  },
): Promise<ActorHarness<HarnessOrchestratorAgent>> {
  const harness = instantiate(HarnessOrchestratorAgent, db, undefined, userPlane);
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

/** A real SubordinateAgent with a claimed owner and a seeded identity (what
 *  the parent's setSubordinateIdentity RPC installs), schema ensured. */
export function subordinateHarness(): ActorHarness<HarnessSubordinateAgent> {
  // The parent namespace is part of the env the agent is BORN with: a stub that
  // answers the one instruction-trust authority read (no recorded approvals —
  // the default-deny truth) and the ONE shared-workspace hop, and refuses
  // everything else loudly. `workspaceBoxOp` is served by a REAL parent
  // orchestrator built lazily on first use, so a subordinate's file plane runs
  // the production dispatcher over real bytes instead of a fake — and a suite
  // that never touches the workspace never pays for the parent.
  let boxParent: ActorHarness<HarnessOrchestratorAgent> | undefined;
  const authority: HarnessInstructionAuthority = {
    getWorkspaceInstructionApprovals: async () => [],
  };
  const denyStubParent: HarnessParentNamespace = {
    idFromName: (name: string) => name,
    get: () => new Proxy(authority, {
      get: (target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'getWorkspaceInstructionApprovals') return target.getWorkspaceInstructionApprovals;
        if (prop === 'workspaceBoxOp') {
          return async (shellId: string, op: Parameters<HarnessOrchestratorAgent['workspaceBoxOp']>[1]) => {
            boxParent ??= orchestratorHarness();
            return await boxParent.agent.workspaceBoxOp(shellId, op);
          };
        }
        return async () => {
          throw new Error(`harness parent: ${String(prop)} is not reachable under bun`);
        };
      },
    }),
  };
  const harness = instantiate(
    HarnessSubordinateAgent, new Database(':memory:'), undefined, undefined, undefined, denyStubParent,
  );
  // A subordinate is a FACET: the SDK records who hired it, and the
  // instruction-trust authority reads that lineage before every turn. The bare
  // fixture hangs off a workspace root with NO recorded approvals — the
  // default-deny truth — served by a stub that answers exactly that one
  // authority read and refuses everything else loudly.
  Object.defineProperty(harness.agent, 'parentPath', {
    value: [{ className: 'OrchestratorAgent', name: 'harness-parent' }],
    configurable: true,
  });
  Object.defineProperty(harness.agent, 'messages', {
    value: [{ role: 'user', metadata: { kinuEvent: 'subordinate_task' } }],
    configurable: true,
  });
  ensureActorSchema(harness.agent);
  harness.db.prepare(
    "UPDATE workspace_identity SET owner_user_id = 'harness-owner' WHERE id = 'harness-actor'",
  ).run();
  harness.db.prepare(
    `INSERT OR REPLACE INTO subordinate_identity
       (id, name, mission, parent_workspace, owner_user_id, depth)
     VALUES (1, 'harness-sub', 'observe conformance', 'harness-parent', 'harness-owner', 1)`,
  ).run();
  harness.db.prepare(
    `INSERT OR REPLACE INTO agent_config (key, value) VALUES
      ('display_name', 'Harness Sub'),
      ('name_origin', 'user'),
      ('role_selection', '{"kind":"legacy","text":"specialist"}')`,
  ).run();
  harness.agent.declareScaffoldPresent();
  return harness;
}

/**
 * A real SubordinateAgent hanging off a real OrchestratorAgent, in one process.
 *
 * Nothing about the identity is pre-inserted: the child is seeded through the
 * production `setSubordinateIdentity`, which reaches back to the parent's
 * `getSubordinateBootstrapIdentity` for the owner, workspace and depth it is
 * not allowed to state itself. So the seeded row is the one production writes,
 * and the parent's roster is a real roster the child can reach.
 *
 * `parentPath` is what the SDK records at facet creation and the only thing
 * that says which agent hired this one; it is declared here because facets are
 * workerd-only, and it names the parent's CLASS so the production class check
 * runs rather than being bypassed.
 */
export async function hiredSubordinateHarness(
  parent: ActorHarness<HarnessOrchestratorAgent>,
  identity: {
    name: string;
    displayName: string;
    nameOrigin: 'user' | 'auto';
    role: string;
    roleId?: string;
    mission: string;
  },
): Promise<ActorHarness<HarnessSubordinateAgent>> {
  const harness = instantiate(HarnessSubordinateAgent, new Database(':memory:'), parent.agent);
  Object.defineProperty(harness.agent, 'name', { value: identity.name, configurable: true });
  Object.defineProperty(harness.agent, 'parentPath', {
    value: [{ className: 'OrchestratorAgent', name: 'harness-parent' }],
    configurable: true,
  });
  Object.defineProperty(harness.agent, 'messages', { value: [], configurable: true });
  ensureActorSchema(harness.agent);
  harness.agent.declareScaffoldPresent();
  const { roleId, role, ...seed } = identity;
  await harness.agent.setSubordinateIdentity({
    ...seed,
    // Durable unless a scenario says otherwise: the harness stands in for a
    // HIRE, and the temporary rung has its own tests.
    lifetime: 'durable',
    role: roleId === undefined
      ? { kind: 'legacy', text: role }
      : { kind: 'catalog', roleId },
  });
  // The parent addresses its children through `subAgent`, which needs a facet.
  // Resolve that ONE name to the real child instead, so both directions of the
  // handshake — the parent renaming a child, the child recording its title —
  // run as production code against production state. Every other name keeps
  // the SDK stub's honest refusal.
  const resolveFacet = harness.agent;
  type SubAgentArgs = Parameters<HarnessOrchestratorAgent['subAgent']>;
  const parentSubAgent = parent.agent.subAgent.bind(parent.agent);
  Object.defineProperty(parent.agent, 'subAgent', {
    value: async (cls: SubAgentArgs[0], name: SubAgentArgs[1]): Promise<object> => {
      const stub = await parentSubAgent(cls, name);
      return name === identity.name ? resolveFacet : stub;
    },
    configurable: true,
  });
  return harness;
}
