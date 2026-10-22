import { Cause, Effect, Exit } from 'effect';
import { ComputerProcessEnds, jobState } from '@kinu.run/core';
import type { VfsDirent, VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
import { type SlateCaller, type SlateCallerHop } from '@kinu.run/core/slates';
/**
 * Actor-agnostic substrate beneath every full-loop Kinu actor on the Cloudflare backend.
 * Tool gating is structural: a profile with no `team` deps gets no hiring actions on `agents`.
 */

import {
  Agent, callable, getCurrentAgent,
  type AgentContext, type Connection, type ConnectionContext,
} from "agents";
import {
  objectNamed,
  inspectSubagentStorage, writeActivityLog, backgroundJobNotice, recordServingJobs, REAL_CLOCK,
  type BackgroundJob, type BackgroundJobRunnerDeps, type Clock, type WorkspaceJobPorts, WorkspaceJobAuthorities, type JobAuthority,
  actorConnectionTag, actorFromConnectionTags, hostedActorRoute, HOSTED_ACTOR_ID_HEADER, actorReadHandle,
  durableStamps, readStamp, repairSchema, SCHEMA_TABLES, StoragePredatesReleaseError, writeStamp, LiveWorkers, type Repair,
  type RunEventInput, type SubagentInspectionAuthority, type ConversationRecall,
  isSubagentOrigin, WORKSPACE_ROOT, PLATFORM_CATALOG, ProgramsInFlight, type OwedIntent, type OwedOwnerIntent, cardWords,
} from '@kinu.run/core';
import type { EnqueueTurnResult, MailDeps, OwnerWaitsHost, PanelAgent, ProgrammaticTurn, RecordedTurn, SendState, SubagentInspectionRequest, SubagentInspectionResult } from '@kinu.run/core';
import type { SubagentActivityEvent } from '@kinu.run/core';
import type { Fact } from '@kinu.run/core';
import type { SubagentView } from '@kinu.run/core/protocol';
import { MessageType } from "agents/chat";
import {
  ActorChatRooms, ChatWireTransport, type ChatWire,
} from './chat-transport';
import {
  CLI_BEARER_HEADER,
  CLI_SCOPES_HEADER,
  SESSION_BEARER_HEADER,
  SESSION_AUTHORITY_REVOKED,
  CLI_AUTHORITY_REVOKED,
  WEBSOCKET_POLICY_CLOSE,
  cliBearerConnectionTag,
  cliBearerFromTags,
  cliScopesConnectionTag,
  sessionBearerConnectionTag,
  sessionBearerFromTags,
} from "./cli/rpc-gate";
import { codemodeSurface, HeldReads, PAGE_KEEPALIVE, readsWrittenBy, ROSTER_READS, type LiveRead, type SqlExec } from "@kinu.run/core";
import { createWorkersTracer } from "./obs/cf-tracer";
import { attemptInItsWords, createAgentTracing, hold, recording, renderThrownChain, type AgentTracing, settle, settleSync, settleLoggedSync, settleLogged } from "@kinu.run/core/obs";
import {
  createActorCompaction, type CompactionExtension,
  createCompactionStateStore,
  type CompactionStateStore, type Logger as CompactionLogger,
} from "@kinu.run/compaction";
import { convertToModelMessages } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";

import {
  EvolutionEngine, recoverSubagentLifecycles, actorReferenceOf,
  type ActorHandle, type ActorHost, type ActorReference, type ChildActorOperation,
  type ActorDirectoryResult, type WorkspaceActorDirectory,
  type ScaffoldRunOptions,
  initActorClaimTables, ActorClaimStore, initPendingSendTables,
  createScaffoldCandidateSurface, createScaffoldHistory, type ScaffoldCandidateBinding,
  type ScaffoldControl,
  refinementPass, type RefinementDeps,
  type CompletedTurn, type TurnContinuity,
  buildBuiltinTools,
  buildMcpToolSet, McpToolSurfaceCache,
  type WebSearchProvider,
  type BrowserSessions,
  browserSessions,
  type PromptIdentity,
  currentDateForPrompt,
  turnTags, authoredTurnMetadata, answerDrawsPages,
  type DynamicContext, type DynamicApproval, type DynamicContextInput, type MissingCapability,
  // Public extension seam — the SAME host contract runChat drives on the CLI
  ExtensionHost,
  type PromptFile, PromptFileSchema, type SentWords,
  // Shared turn lifecycle and run_end classifier, so neither backend chooses the string
  // (see turn-failure.ts).
  type AgentOrchestrator, type AgentOrchestratorDeps, actorTerminalEffects, DynamicContextLedger, actorPolicy, actorReach, type ActorReach, type BackendHost,
  EvolutionLanes, drainPendingEvents, ActorAdvisor, standingFileLedger, turnLedgers, type TurnLedgers, type BoundActor, type SeatedActor, type DynamicDelegate,
  builtinStoreDeps, serveStores, type BuiltinStoreInputs, type ServedStores,
  type ComposedRequest,
  type AgentsToolDeps,
  type AgentsSwarmDeps,
  BUILTIN_TOOLS,
  type PromptModelContext,
  type WorkMode, isWorkMode,
  nanoid,
  type HeadJournal, LiveHeadJournal,
  type HeadStreamFrame,
  type HeadId, type HeadInput, type HeadReport,
  type SerializedMessage, type HeadRuntime, type HeadGrounding,
  type RunEventRecorder,
  // Spend governor is opt-in: no label means no cap.
  MissionGovernor, type MissionSeam, type MissionBudgetRefusal,
  priceCall, type Usage,
  WORKSPACE_RUN_ID, signalCardId, TurnReplies, type ModelCallReport, type ModelOperationSink,
  recordModelOperations, type ModelAttemptInfo, type ProviderWaitInfo,
  // Prices a model_call row only when the rate belongs to that call's own model.
  pricedModelCallEvent,
  type FactsStore,
  createAgentStores, type AgentConfigStore, type SetModelDeps, collectDynamicContext, dynamicReads, type DynamicReads, subagentDelegatesOf,
  agentArtifactDirectory, agentHome, MAIN_AGENT,
  type SessionTranscript,
  type SqlExecutor,
  betaSwarms,
  // Background-job system (#173: auto-background past the surface threshold)
  BackgroundJobRunner, type JobResumer, type InvocationSurface, InvocationSurfaceSchema, RESUMED_SURFACE,
  invocationBackgroundPolicy,
  type BackgroundJobStore, type TaskListStore,
  resumeBackgroundJob, resumableBackgroundJob, computerProcessJob, computerProcessResume, stopComputerProcessJob, harvestBackgroundJob, type ActorToolsets,
  isWorkspaceProcessJob, stopWorkspaceProcessJob, workspaceProcessJobRuns,
  cancelCurrentWork, getStoredModelSpec,
  type CancelWorkOutcome, type ChatHistoryPage, type Page, type PageRequest, PositionPageRequestSchema, type PositionPageRequest,
  type MctsSearchStore, readSearchTree, isSteerBranchRunId,
  EventLog,
  type ActiveSkillSet, type TurnReads,
  type PlanDecisionOutcome,
  type PlanReview, type ReviewAnnotation,
  type PlanReviewDecision, type PlanReviewResult, type AskingAgent, type OwnerAnswer,
  answerParentRpc,
  type ParentExecResult,
  type ParentRpcWrite,
  type TeamToolDeps,
  type SubagentRuntime, type TemporaryAgentPort,
  SubagentRosterStore, subagentTitle,
  // One minting rule, depth walk and clock for every subagent, on either backend
  teamToolDepsFor, temporaryPortFor,
  readSoul, bootstrapScaffold,
  applyWorkspaceTitle, suggestWorkspaceTitle, type NameOrigin,
  parseModelSpec, specModelInfo, assembleActorTurn,
  type ModelWindow, type AgentsMdSources,
  ModelCatalogSession, resolveEffectiveModelSpec, type ModelCatalogRead, type ModelInfo,
  // Shared turn-context assembly: the same ordering runChat runs on the CLI
  // AGENTS.md discovery, and the trust authority deciding whether discovered bytes earn system placement.
  collectWorkspaceAgentsMd,
  InstructionApprovalStore, type InstructionTrustResolver,
  InstructionApprovalDesk, type AdmittedInstructionDecision,
  type InstructionSourceRow, type InstructionSourceView,
  JsonObjectSchema, JsonValueSchema, changeRoleAsOwner,
  loadProfileAuthorityInputs,
  resolveTurnProfile, resolveRoutingProfile, ownProfileChoices, ancestorPins, createAgentConfigStore, type PinnedProfile,
  activeOperationProfile, captureOperationProfile, currentOperationProfile, runOperationProfile, withOperationProfile,
  providerAccounts, type ProviderAccounts,
  inTurnSurface, scopedTurnSurface, TurnSurface,
  type OperationProfile,
  toolsNamespace, runWorkModeInvocation, actorNamespaces, hostedSurfaceActor, SURFACE_POLICY, type SurfaceActor, type AgentSelfHost,
  resolveModelRoute, completeOnRoute, routedLlm, tierRefusals, type TierRefusals, type ModelRouteResolution,
  narrowToolSurface, codemodeCapabilitiesFor, slateToolReach, callCodemodeMember, requireCodemodeMember, inWorkMode,
  toolSurfaceTokens, McpToolSurfaceSchema, GITHUB_MCP_PRESET, recognizeGitHubMcp, recordGitHubActivity, type SerializableToolDescriptor,
  OwnerAnswersSchema, REPORT_TOOL,
  type ActiveRoster, type JsonObject, type JsonValue, type ProfileAuthorityInputs, type ProfileCatalogEnvelope,
  toolsInWorkMode, type TaskPlan, withTaskPlan, providersInWorkMode, providersWithoutOwnerSecrets, withholdingOwnerSecrets, currentWorkMode, requireWorkModePermission,
  type ResolvedTurnProfile, type ModelCallSpend, type ToolSurfaceNarrowing,
  type AgentInbox,
  childContextResolver,
} from "@kinu.run/core";
import {
  bindAgentSql, createCFRuntime, isCFRuntime, MODEL_SETTINGS,
  type CFRuntime, type CFRuntimeHooks, type WorkspaceBoxUse,
} from "./runtime";
import {
  hostNodeSeat, nodeCodemodeTool, hostedSubagentRuntime,
  type ActorSurface, type HostedActorSeams, type SurfaceTurn,
} from "./hosted-actors";
import type { CFSeat } from "./actor-hosting";
import {
  // Shared retry pace for notice carrier, this tick's re-arm and the job runner's deferral.
  recoveryBackoffMs,
  // Once-only lifecycle for one settled response; both backends drive this state machine.
  TerminalTransitions, initTerminalEffectTable,
  terminalEffect, turnRecordingEffects, type AgentAnswer,
  type TerminalEffectFault, type TerminalEffectTable,
} from "@kinu.run/core";
import { createCodemodeToolFactory, type CodemodeFactory, type CodemodeScope } from "./codemode-tool";
import { BROWSER_PRELUDE } from './browser-prelude';
import { codemodeLauncher, jobContextAnswers, type ProgramLaunch } from "./codemode-sandbox";
import { createHeadRuntime } from "./head-runtime";
import type { AgentProviderRegistry } from "./providers/agent-registry";
import { initSlateUsageTable, slateAiAnswer } from '@kinu.run/core/slates';
import { OwnedModelServices } from "./owned-model-services";
import { AgentStoreBroker } from "./agent-facets";
import type { AgentFacetCalls } from "./agent-facet/agent-facet";
import type { AgentSnapshot } from "@kinu.run/core";
import type { CodemodeProvider, DeferredApprovalChannel, SlateRoute, SlateCallResult, SlateOperation, SlateReadModel, SlateSurfaceValue } from "@kinu.run/core";
import { workspaceOwner } from "./workspace-owner-rpc";
import { CRED_SESSION_USER } from "@nimbus-sh/core/runtime/os-contracts.js";
import type { SlateDispatchContext } from "./slates/host";
import { diagnostics, KinuError, refusalOf, toKinuError, type ErrorCode, type Refusal } from "@kinu.run/core/obs";
import type { McpToolSurface } from "./user/mcp-servers";
import { AccountReads, type UserHubClient } from "./account-reads";
import { gatedClientHandlers } from "./client-socket-gate";
import { isWorkspaceTerminal } from "@kinu.run/core";
import type { HostedBox, HostedWorkspace, WorkspaceTerminal } from "./workspace-host";
import type { UserCaller } from "@kinu.run/core";
import { ensureIdentityTable, initMissionBudgetTable, JOB_STAMP_ENV, sha256Hex, webSearchChainOf } from '@kinu.run/core';
import { initWorkspaceGenerationTable } from '@kinu.run/core/workspace';
import { attributeWorkspace, installAnalyticsDiagnostics } from "@kinu.run/core/analytics";
import {
  recordModelRow, recordToolRow, recordTtftRow, recordTurnRow, type AgentKind,
} from "@kinu.run/core/analytics";
import * as v from 'valibot';
import { AdviceJobs } from './advice-jobs';
import { KINU_TIMER_JOB, TERMINAL_RETRY_JOB, WakeJobs, type WakePace } from './wake-jobs';
import { callUserMcpTool } from './user-mcp-call';

/** Named contract so the analytics writer and the actor agree which half is the provider. */
interface ModelDimensions {
  readonly provider: string;
  readonly model: string;
}

/** No model resolved. Empty rather than a plausible default, so unknowns are not misattributed. */
const UNRESOLVED_MODEL: ModelDimensions = { provider: '', model: '' };

const RUN_EVENT_EMIT_FAILED = {
  tool_call_end: 'event.tool_call_end_emit_failed',
  step_finish: 'event.step_finish_emit_failed',
  budget_exhausted: 'event.budget_exhausted_emit_failed',
} as const;

interface AsyncTaskOwner {
  promise: Promise<Exit.Exit<void>> | null;
}

/** One actor's half of its job runner. */
type ActorJobSeams = Pick<BackgroundJobRunnerDeps,
  'store' | 'policy' | 'fiber' | 'inbox' | 'resume' | 'harvest' | 'scheduleResume'> & {
  readonly notifySettled?: (job: BackgroundJob) => void;
};

/**
 * How long an alarm waits for the programs in flight, from its start: nine tenths of the wall an alarm handler is
 * given (do.alarm.wall_ms), so the platform never ends the handler mid-wait. A handler ended at its wall resets the
 * object and closes every socket (warm-forge-4d6acc02, 2026-09-25).
 */
const ALARM_PROGRAM_WAIT_MS = Math.floor(PLATFORM_CATALOG['do.alarm.wall_ms'].limit.value * 9 / 10);



/** Text-only: attachment parts are dropped here but still reach the model via
 * `host.defaultInference()` (see _transformInferenceResult). */
function extractLastUserText(messages: ReadonlyArray<ModelMessage>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];

    if (m.role !== 'user') continue;
    const c = m.content;

    if (v.is(v.string(), c)) return c;

    if (Array.isArray(c)) {
      return c
        .map((part) => {
          const parsed = v.safeParse(v.looseObject({ text: v.optional(v.string()) }), part);

          return parsed.success ? parsed.output.text ?? '' : '';
        })
        .filter(Boolean)
        .join('\n');
    }

    return '';
  }

  return '';
}

function readCliCwd(body?: JsonObject): string | null {
  const cwd = body?.cwd;

  return v.is(v.string(), cwd) && cwd.trim() ? cwd.trim() : null;
}

/** CLI one-shot surfaces (`kinu exec`/`kinu run`) stamp `oneShot`: each is an independent
 * task, not a verdict on the previous turn. Everything else is a conversation. */
export function readTurnContinuity(body?: JsonObject): TurnContinuity {
  return body?.oneShot === true ? 'independent_task' : 'conversation';
}

const CompactionDetailSchema = v.optional(JsonValueSchema);

type CompactionDetail = v.SafeParseResult<typeof CompactionDetailSchema>;

/** Event names are shared verbatim with `cli-backend/src/local-session.ts` so one query
 * reads both. */
const COMPACTION_OUTCOMES = {
  warn: { event: 'compaction.degraded', code: 'unavailable', activity: 'compaction_warn' },
  error: { event: 'compaction.failed', code: 'io', activity: 'compaction_error' },
} as const;

function compactionLogDetail(message: string, detail: CompactionDetail): string {
  if (!detail.success) {
    // An unserializable detail (cycle, BigInt) must not drop the log line; ship the message alone.
    diagnostics.event('actor.compaction_detail_unserializable', { message });

    return message;
  }

  return detail.output === undefined ? message : `${message} ${JSON.stringify(detail.output)}`;
}

/** Agents' questions to the owner, each in its own isolate (D9), the workspace agent's included: answered by the asking
 *  agent's id. */
export interface HostedOwnerQuestions {
  list(): Promise<AskingAgent[]>;
  /** Owed when the crossing did not reach the agent: its wake delivers the answers. */
  answer(actorId: string, id: string, answers: readonly OwnerAnswer[]): Promise<OwedIntent | null>;
  dismiss(actorId: string, id: string): Promise<number>;
}

export interface HostedPlanReviews {
  active(): Promise<PlanReview | null>;
  saveAnnotations(id: string, revision: number, annotations: ReviewAnnotation[]): Promise<PlanReviewResult>;
  dismiss(id: string, revision: number): Promise<PlanReviewResult>;
  /** Owed when the crossing did not reach the agent: its wake delivers the decision. */
  decide(id: string, revision: number, decision: PlanReviewDecision, feedback?: string): Promise<PlanDecisionOutcome | OwedIntent>;
}

/**
 * Ledgers that can owe work with no instant and nothing else to watch it. A live background job has its `bg:` fiber;
 * activation arms one ledger recovery pass even if that row expired, and a deferred job is timed (`nextOwedAt`).
 */
export interface UntimedArms {
  readonly openDrainLease?: boolean;
  readonly terminalIncomplete?: boolean;
  readonly unfinishedHeads?: boolean;
  readonly runningSwarms?: boolean;
  readonly retirements?: boolean;
  readonly pendingBirths?: boolean;
  readonly pendingDeletions?: boolean;
  readonly agentTurns?: boolean;
  readonly chatLoop?: boolean;
  readonly changeNotes?: boolean;
}

export interface ActorDynamicContextExtras {
  readonly approvals?: () => ActiveRoster<DynamicApproval>;
  readonly failingSlates?: () => readonly string[];
  readonly extraMissingCapabilities?: () => readonly MissingCapability[];
}

interface WorkspaceTitleInputs {
  readonly displayName: string | null;
  readonly nameOrigin: NameOrigin | null;
}

/** Failure classes under which a turn runs on builtins alone because the MCP catalog was
 * unreachable; every other class is the turn's own fault. */
const MCP_CATALOG_READ_FAILURES: ReadonlySet<ErrorCode> = new Set(['unavailable', 'timeout', 'io']);

/**
 * A namespace member a slate calls: run it, or, when the host asks only whether it may, refuse as running it would. A
 * viewer's call is admitted (`context.admit`) at the last moment before it acts: an authorization is the act of a member
 * the class runs itself.
 */
async function slateMember(
  providers: readonly CodemodeProvider[], route: Extract<SlateRoute, { kind: 'namespace' }>, context: SlateDispatchContext,
): Promise<JsonValue> {
  if (!context.authorizeOnly) {
    context.admit?.();

    return await callCodemodeMember(providers, route.namespace, route.member, route.args) ?? null;
  }

  requireCodemodeMember(providers, route.namespace, route.member);
  context.admit?.();

  return null;
}

/** What one turn read once for every step's dynamic context: MEMORY.md's tail, its skills, the account's facts, its mail. */
interface TurnMemoryReads {
  readonly memoryTail: string | undefined;
  /** Absent: the actor's own active skills for the turn. */
  readonly activeSkills?: ActiveSkillSet | null;
  readonly accountFacts?: readonly Fact[];
  readonly mail?: TurnReads['mail'];
}

/** What a slate binding call runs with: the mode its actor's role leaves it, and that role's tool reach. */
interface SlateAuthority {
  readonly mode: WorkMode;
  readonly reach: ToolSurfaceNarrowing;
  /** The profile a call runs under: the turn's when one is live, else this one resolved now, as a hire reads its role. */
  readonly operation?: OperationProfile;
}

/** `use` over the namespaces and tools an authority reaches, in its mode; each tool is reached through its record. */
async function reachedIn<A>(
  authority: SlateAuthority, providers: CodemodeProvider[], tools: ToolSet, use: (reached: readonly CodemodeProvider[]) => Promise<A>,
): Promise<A> {
  const reachedTools = Object.fromEntries(Object.entries(toolsInWorkMode(authority.mode, tools)).filter(([name]) => authority.reach.allowsTool(name)));
  const narrowed = authority.reach.narrowProviders(providersInWorkMode(authority.mode, providers));

  return await runWorkModeInvocation(authority.mode, () => use([...narrowed, toolsNamespace(reachedTools, undefined)]));
}

/** The evolution lane's `fibers` row name. */
export const EVOLUTION_LANE_FIBER = 'evolution:settle';

/** What a call already holds when it builds an agent's own tools again: its ledgers, and the store operations its other
 *  projections run, which the tools project rather than serving their own. */
export interface OwnToolsHeld {
  readonly ledgers: TurnLedgers;
  readonly stores?: ServedStores;
}

/** No one has claimed this workspace yet: every path only an owner can take refuses it in these words. */
export function unownedWorkspace(): KinuError {
  return new KinuError('unavailable', 'This workspace has no owner yet: open it from the app or the CLI first.');
}

export abstract class ActorAgent extends Agent<Env> {
  // Actor profile: these members are the whole difference between actor kinds.

  protected abstract getOwnerUserId(): string | null;
  protected abstract actorHandle(): ActorHandle;
  abstract actorDirectory(operation: ChildActorOperation): Promise<ActorDirectoryResult>;

  private actorRuntimeRefusal(): Refusal | null {
    if (this.storageRefusal !== undefined) return refusalOf(this.storageRefusal);

    try {
      this.actorHandle();

      return null;
    } catch (cause) {
      if (cause instanceof KinuError && cause.code === 'missing') return refusalOf(cause);
      throw cause;
    }
  }

  /** False for a Nimbus sibling, whose alarm is the SDK's. */
  protected hostsActor(): boolean {
    return true;
  }

  override alarm(): Promise<void> {
    if (!this.hostsActor()) return super.alarm();

    // Returned, not thrown: the platform retries a thrown alarm.
    if (this.storageRefusal !== undefined) return Promise.resolve();
    const refusal = this.actorRuntimeRefusal();

    if (refusal) return settle(Effect.fail(new KinuError(refusal.reason, refusal.error)));

    return this.heldAlarm();
  }

  /** The alarm's work, a job it re-drives or a turn a wake admits, launches programs that end with the alarm. */
  private async heldAlarm(): Promise<void> {
    const began = Date.now();
    const programs = new ProgramsInFlight();

    try {
      await programs.run(async () => {
        await this.recoverLostJobs();
        await super.alarm();
      });
    } finally {
      await this.awaitPrograms(programs, began);
    }
  }

  /**
   * The alarm's last act: the programs its work launched stay open while it does, so it waits until none runs, at most
   * until `ALARM_PROGRAM_WAIT_MS` past `began`. A program still running then ends with it, as before.
   */
  private async awaitPrograms(programs: ProgramsInFlight, began: number): Promise<void> {
    const running = programs.size;

    if (running === 0) return;
    diagnostics.event('alarm.programs_awaited', { workspace: this.name, running });
    const deadline = Promise.withResolvers<void>();
    const timer = setTimeout(deadline.resolve, Math.max(0, began + ALARM_PROGRAM_WAIT_MS - Date.now()));

    try {
      const left = await programs.settled(deadline.promise);

      if (left > 0) diagnostics.event('alarm.programs_outlived', { workspace: this.name, running: left, waitedMs: Date.now() - began });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Each alarm, the keepAlive heartbeat a running job's fiber holds among them, asks whether a job's work went silent. */
  private async recoverLostJobs(): Promise<void> {
    await settleLogged('jobs.lost_recovery_failed', { doing: 'recover the background jobs whose work stopped answering', otherwise: 'io' },
      () => this.jobAuthorities.recoverLost(), { workspace: this.name });
  }
  /** Actor kind for the operational dataset's `agentKind` dimension. Abstract because a
   * bundler may rewrite `constructor.name`. */
  protected abstract actorKind(): AgentKind;
  /** The workspace agent's newest answered turns, which a pending scaffold is replayed against. */
  abstract recordedTurns(limit?: number): Promise<RecordedTurn[]>;
  /** The workspace's agents as the person's sidebar reads them, released hires too when `retained`: `agents.list` shows
   *  a subtree of it. */
  protected abstract workspaceAgents(retained: boolean): Promise<PanelAgent[]>;

  /** The workspace whose exec planes this actor rides; a facet actor overrides with its parent's. */
  protected workspaceName(): string { return this.name; }

  protected shellId(): string { return `agent:${this.name}`; }

  /** One Durable Object owns the workspace bytes: a top-level workspace DO serves from its own
   * storage; a facet actor returns a client onto that object. */
  protected abstract workspaceBox(shellId: string): HostedBox;
  protected abstract workspaceServing(): ReturnType<HostedWorkspace['serving']>;

  protected scaffoldPath(): string { return 'scaffold/agent.js'; }

  /** Workspace identity token for the owner's UserDO; facets hold a pushed copy of the parent's.
   * Null before claim. Kept out of actor_config and never readable via RPC. */
  protected workspaceCapabilityToken(): string | null {
    // The constructor owns the table, so a failure here is real, never "no token".
    this.capabilityToken ??= this.sql<{ token: string }>`SELECT token FROM workspace_capability LIMIT 1`[0]?.token || null;

    return this.capabilityToken;
  }

  /** Read once: {@link installWorkspaceCapability} is the row's only writer, and a destroy ends the isolate. */
  private capabilityToken: string | null | undefined;

  /** Hash of the held token, or null. Safe to share; lets the UserDO detect a mismatch. */
  protected async workspaceCapabilityHash(): Promise<string | null> {
    const token = this.workspaceCapabilityToken();

    return token ? sha256Hex(token) : null;
  }

  /** Worker-side DO RPC only, deliberately not `@callable`. Hosted actors read the one capability row through their
   *  runtime, so a reissue applies on their next call: there are no per-actor copies to push to. */
  installWorkspaceCapability(token: string): Promise<{ ok: true }> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!token) return yield* new KinuError('denied', 'capability token required');
      void this.sql`INSERT INTO workspace_capability (id, token) VALUES (1, ${token})
               ON CONFLICT(id) DO UPDATE SET token = excluded.token`;
      this.capabilityToken = token;
      this.invalidateModelCaches();
      // The first tile, so a workspace nobody opens still shows.
      this.overviewChanged();

      return { ok: true } as const;
    }));
  }

  /**
   * Created in the constructor: the only point guaranteed to precede every access on both cf roots
   * (`onStart` may follow an RPC). Per-root by design; `test-utils/src/conformance/manifest.ts` marks it
   * absent for cli. The storage is asked its stamp first (identity/schema-stamp.ts): storage a release left behind gets
   * no init here, and the subclass's constructor repairs it with the whole root's init ({@link repairStorage}).
   */
  private initCapabilitySchema(): void {
    const stamps = durableStamps(this.ctx.storage.kv);
    const stamp = readStamp(stamps, this.ctx.storage.sql, 'workspace');

    if (stamp === 'behind') return;

    this.initBaseTables();

    if (stamp === 'unmade') writeStamp(stamps, 'workspace');
  }

  /** Storage a release left behind brought to this build by `init`, the root's whole init, before any event reads it
   *  (core state/schema-repair.ts); one its repair cannot bring up answers every call with why. */
  protected repairStorage(init: () => void): void {
    const { storage } = this.ctx;

    const execRaw = (ddl: string) => { storage.sql.exec(ddl); };

    this.schemaRepair = repairSchema(storage.sql, {
      schema: 'workspace', tables: SCHEMA_TABLES.workspace, stamps: durableStamps(storage.kv),
      transactionSync: (write) => storage.transactionSync(write), init,
      // Made on first use: the boot's agent identities, the hosted workspace's generation, a ledger, the slates.
      later: () => {
        ensureIdentityTable(storage.sql);
        initWorkspaceGenerationTable(storage.sql);
        initMissionBudgetTable(execRaw);
        initSlateUsageTable(execRaw);
      },
    }, `workspace ${this.name}`);

    if (this.schemaRepair?.refused == null) return;
    this.storageRefusal = new StoragePredatesReleaseError('workspace', this.schemaRepair.refused);
    diagnostics.failure('workspace.storage_refused', this.storageRefusal);
  }

  /** The tables a root makes before anything reads it; a repair runs this again once it rebuilt the storage. */
  protected initBaseTables(): void {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);

    execRaw(`CREATE TABLE IF NOT EXISTS workspace_capability (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL
    )`);
    // Pending-send ledger is declared once in core (`initPendingSendTables`) because the CLI
    // backend shares the table names with a nullable `turn_id`; one writer keeps creation order
    // from picking the shape.
    initPendingSendTables(execRaw);
    // Per-actor admission ledger (one workspace-wide pointer cannot distinguish concurrent actors).
    // In the base constructor: the SDK's fiber recovery reads it before any subclass constructor body.
    initActorClaimTables(execRaw);
    // Same reason.
    initTerminalEffectTable(execRaw);
  }

  /** `agent.*`, its own lifecycle: only the workspace's main actor has one. */
  protected agentSelf(): AgentSelfHost | null { return null; }

  protected abstract get engine(): EvolutionEngine;

  protected abstract notifyOwner(subject: string, body: string): void;

  private addressedActor(): string | null {
    const { connection } = getCurrentAgent();

    return connection === undefined ? null : actorFromConnectionTags(connection.tags);
  }

  /** Every window reviews its agent's plans, in that agent's own isolate: the workspace's own window, main's (D9). */
  private windowPlans(): Effect.Effect<HostedPlanReviews, KinuError> {
    const window = this.addressedActor() ?? this.actorHandle().actorId;
    const plans = this.hostedPlanReviews(window);

    return plans === null ? Effect.fail(new KinuError('missing', `${window} is not an agent of this workspace`)) : Effect.succeed(plans);
  }

  @callable()
  async getActivePlanReview(): Promise<PlanReview | null> {
    return await settle(Effect.flatMap(this.windowPlans(), (plans) => Effect.promise(async () => await plans.active())));
  }

  @callable()
  async savePlanReviewAnnotations(
    id: string,
    revision: number,
    annotations: ReviewAnnotation[],
  ): Promise<PlanReviewResult> {
    return await settle(Effect.flatMap(this.windowPlans(), (plans) => Effect.promise(async () => await plans.saveAnnotations(id, revision, annotations))));
  }

  @callable()
  async dismissPlanReview(id: string, revision: number): Promise<PlanReviewResult> {
    return await settle(Effect.flatMap(this.windowPlans(), (plans) => Effect.promise(async () => await plans.dismiss(id, revision))));
  }

  @callable()
  async decidePlanReview(
    id: string,
    revision: number,
    decision: PlanReviewDecision,
    feedback?: string,
  ): Promise<PlanDecisionOutcome | OwedIntent> {
    return await settle(Effect.flatMap(this.windowPlans(), (plans) => Effect.promise(async () => await plans.decide(id, revision, decision, feedback))));
  }

  /** Recent questions to the owner, every agent's from its own isolate, the workspace agent's included: the open ones for
   *  the attention stack, each for its call's record. */
  @callable()
  async listOwnerQuestions(): Promise<AskingAgent[]> {
    return await this.hostedQuestions().list();
  }

  /** The owner's answer: the asking call's result, and the turn that continues from it, in the agent that asked
   *  (`actor`; null for the workspace agent). */
  @callable()
  async answerOwnerQuestions(id: string, answers: readonly OwnerAnswer[], actor: string | null = null): Promise<OwedIntent | null> {
    // Typed as a page sends them; read as the wire may carry anything.
    const parsed = v.safeParse(v.tuple([OwnerAnswersSchema, v.nullable(v.string())]), [answers, actor]);

    return settle(Effect.suspend(() => {
      if (!parsed.success) return Effect.fail(new KinuError('bad_input', `answers: ${parsed.issues[0].message}`));
      const [answered, asker] = parsed.output;

      return attemptInItsWords('unavailable', () => this.hostedQuestions().answer(asker ?? this.actorHandle().actorId, id, answered));
    }).pipe(Effect.tap(() => Effect.sync(() => { this.overviewChanged(); }))));
  }

  /** The owner's decisions, answers and Retries on their way to an agent whose crossing did not reach it: each shown
   *  where it was made until the agent's wake delivers it. `actor` is null for the workspace's own agent. */
  @callable()
  async listOwedIntents(): Promise<readonly OwedOwnerIntent[]> {
    return this.owedIntents();
  }

  protected owedIntents(): readonly OwedOwnerIntent[] {
    return [];
  }

  /** Closed unanswered; the agent reads that at its next turn, and what waited behind the questions runs. */
  @callable()
  async dismissOwnerQuestions(id: string, actor: string | null = null): Promise<{ readonly closed: number }> {
    const asker = v.safeParse(v.nullable(v.string()), actor);

    if (!asker.success) return settle(Effect.fail(new KinuError('bad_input', 'actor: an agent id, or null for the workspace agent')));

    const closed = await this.hostedQuestions().dismiss(asker.output ?? this.actorHandle().actorId, id);

    // A tile counts the open questions as decisions waiting.
    this.overviewChanged();

    return { closed };
  }

  /** The workspace's one actor host; every logical actor is acquired from it over this object's SQL.
   * Abstract because it is built from root state this base class does not hold. */
  protected abstract actorHost(): ActorHost<CFSeat>;

  /** A hire's `agent.*` of what waits on its owner from its own work; null for an actor that holds none. */
  protected abstract hireOwnerWaits(actor: SeatedActor): OwnerWaitsHost | null;

  /** The workspace agent's stores, bound as its root actor. */
  protected rootBound(): BoundActor {
    return this.actorHost().bindStores(actorReferenceOf(this.actorHandle()));
  }

  /** Read directly by the inspection path and slate descent, which resolve actors by name. */
  protected abstract actorDirectoryStore(): WorkspaceActorDirectory;

  protected abstract hostedSeams(): HostedActorSeams;

  /**
   * Each actor's home is provisioned in this isolate by the host (`actor-hosting.ts` →
   * `hostedHomeName`); its identity is its `workspace_actors` row, so there is no facet port.
   */

  private _subagentRoster: SubagentRosterStore | null = null;

  /** Reads held between this object's statements: `sql` and {@link watchedExec}, its two executors, drop them. */
  // Lazy: this object's statements run before its fields are initialised (its base's constructor).
  private _held: HeldReads | undefined;

  protected get held(): HeldReads {
    return this._held ??= new HeldReads();
  }

  /** Before each statement either executor runs. */
  protected heldWritten(query: string | TemplateStringsArray): void {
    this._held?.written(query);
  }

  protected get watchedExec(): SqlExec {
    return {
      exec: (query, ...bindings) => {
        this.heldWritten(query);
        const cursor = this.ctx.storage.sql.exec(query, ...bindings);
        this.liveReadsMoved(readsWrittenBy(query));

        return cursor;
      },
    };
  }

  protected get subagentRoster(): SubagentRosterStore {
    if (!this._subagentRoster) {
      this._subagentRoster = new SubagentRosterStore(this.watchedExec, this.actorHandle());
      this._subagentRoster.ensureSchema();
    }

    return this._subagentRoster;
  }

  protected subagentDelegates() {
    return subagentDelegatesOf(this.subagentRoster.list());
  }

  /**
   * One roster row as a chat surface draws it: lifecycle from the roster, title and role from config.
   * Config is read via the presence-fenced handle, not by name: a kept dismissal releases the name.
   */
  protected async subagentView(name: string): Promise<SubagentView> {
    const entry = this.subagentRoster.get(name);

    if (entry === null) throw new KinuError('missing', `Subagent "${name}" is not in the roster`);
    const reference = entry.actorReference;

    if (reference === null) return { ...entry, actorId: null, ...subagentTitle(entry, null) };

    const record = this.actorDirectoryStore().retained(reference.actorId);

    if (record === null) throw new KinuError('missing', `Subagent "${name}" names an actor this workspace does not hold.`);

    return { ...entry, actorId: reference.actorId, ...subagentTitle(entry, actorReadHandle(this.boundSql, record).config) };
  }

  protected async subagentViews(): Promise<SubagentView[]> {
    return Promise.all(this.subagentRoster.listAll().map(
      async (entry) => this.subagentView(entry.name),
    ));
  }

  protected broadcastSubagentEvent(
    event: Omit<SubagentActivityEvent, 'type' | 'id'> & { id?: string },
  ): void {
    this.broadcastToActor(null, JSON.stringify({
      type: 'subagent_event',
      id: event.id ?? nanoid(),
      kind: event.kind,
      subagent: event.subagent,
      status: event.status,
      content: event.content,
      task: event.task,
      timestamp: event.timestamp,
    } satisfies SubagentActivityEvent));
  }

  /**
   * Hosted actors have no facet hop: `agent-routing.ts` refuses `sub` publicly and
   * `resolveHostedActorRoute` checks the directory and roster before the request reaches an actor.
   */
  private _subagentRuntime: SubagentRuntime | null = null;

  /** Memoized so the durable roster and the temporary register address the same actors. */
  protected subagentRuntime(): SubagentRuntime {
    this._subagentRuntime ??= hostedSubagentRuntime(
      this.hostedSeams(),
      () => this.rootBound(),
    );

    return this._subagentRuntime;
  }

  protected stopSubtree(_actorId: string): void {}

  protected async agentTurnSettled(_actor: ActorReference): Promise<void> {}

  protected temporaryAgentPort(reference: ActorReference = actorReferenceOf(this.actorHandle())): TemporaryAgentPort {
    return this.actorHost().temporary(reference, (bound) => {
      const seams = this.hostedSeams();
      const roster = seams.roster(bound);
      roster.ensureSchema();

      return temporaryPortFor({
        roster, runtime: hostedSubagentRuntime(seams, () => bound), directory: this.actorDirectoryStore(),
        afterTurn: (child, work) => {
          this.detachOwned(Effect.promise(async () => {
            await this.agentTurnSettled(child);
            await this.actorHost().run(child, { kind: 'actor' }, () => Promise.resolve());
            await work();
          }));
        },
      });
    });
  }

  protected getTeamToolDeps(): TeamToolDeps {
    return teamToolDepsFor({
      record: this.rootBound().record,
      directory: this.actorDirectoryStore(),
      roster: this.subagentRoster,
      runtime: this.subagentRuntime(),
      temporary: this.temporaryAgentPort(),
      inheritedContext: () => this.readInheritedContext(),
      originContext: () => this.mainWorkingContext(),
      ownMission: () => this.ownMission(),
      rosterMoved: () => { this.liveReadsMoved(ROSTER_READS); },
      broadcastTask: (event) => this.broadcastSubagentEvent({
        kind: 'task',
        ...event,
      }),
      workspaceAgents: () => this.workspaceAgents(true),
      events: this.eventLog,
    });
  }

  protected activeRoleLabel(): string {
    return this.config.getRoleSelection();
  }

  /** Protected: the workspace root builds every hosted actor's model seams from this one
   *  owner-scoped service, so a head's spend resolves against the turn's provider snapshot. */
  protected readonly ownedModelServices = new OwnedModelServices({
    env: this.env,
    agentName: () => this.actorHandle().name,
    workspaceId: () => this.actorHandle().workspaceId,
    workspaceName: () => this.workspaceName(),
    appTitle: 'Kinu',
    ownerRequired: true,
    getOwnerUserId: () => this.getOwnerUserId(),
    getUserCaller: () => this.userCaller(),
    // Asked of the same UserDO the registry reads; held as `accountSettingsAtOpen` keeps it current.
    getCredentialsRevision: () => this.account.credentialsRevision(),
    onProviderWait: (info) => { this.noteProviderWait(info); },
    onModelAttempt: (info) => { this.noteModelAttempt(info); },
    accounts: () => this.providerAccounts(),
    // A cold workspace serves the account's last listing swept under the same keys, and sweeps behind its turn.
    storedListing: {
      read: (accounts) => this.account.storedProviderListing(accounts),
      keep: (revision, accounts, listing) => this.account.keepProviderListing(revision, accounts, listing),
      detach: (work) => { this.detachOwned(work); },
    },
    reportModelCall: (report) => { this.reportModelCall(report); },
    webSearchChain: async () => webSearchChainOf((await this.profileCatalog()).catalog),
    currentTurn: (reference) => this.currentTurnOf(reference),
  });

  // The bare prototype must read as sound.
  protected storageRefusal?: StoragePredatesReleaseError;

  /** What this activation's repair did, for the deploy's walk; null where the storage was at this build. */
  protected schemaRepair: Repair | null = null;

  /** Kinu's two durable wakes; see wake-jobs.ts. */
  protected readonly wakes = new WakeJobs({
    [KINU_TIMER_JOB]: () => this._kinuTimerTick(),
    [TERMINAL_RETRY_JOB]: (pace) => this.terminalRetryPass(pace),
  });

  /** An advisor answer's delivery; see advice-jobs.ts. */
  protected readonly advice = new AdviceJobs((actorId) => this.deliverAdviceFor(actorId));

  /** The workspace timer's pass: every source a subclass folds into its next wake. */
  abstract _kinuTimerTick(): Promise<void>;

  /** An agent's held advisor answers, into its own isolate; the subclass that hosts agents delivers them. */
  protected deliverAdviceFor(_actorId: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.wakes);
    this.lifecycle.use(this.advice);
    // Must precede any read or write of it; see initCapabilitySchema.
    this.initCapabilitySchema();
    // A Durable Object is a DIFFERENT ISOLATE from the Worker that routes to it,
    // with its own module-level state — so the diagnostics sink installed at the
    // Worker's fetch entry does not exist in here, and every `diagnostics` line
    // an actor produces would reach Workers Logs and no dataset. Installed in the
    // constructor because that is the one point guaranteed to precede every RPC
    // (`onStart` is not — see `OrchestratorAgent.claimOwner`), and idempotent per
    // isolate, so a re-activation costs nothing.
    // The workspace comes from the invocation, not the isolate: `setDiagnosticsSink` is module-global
    // and Cloudflare co-locates Durable Objects, so an install-time default would attribute every
    // co-located actor to the first. The SDK's per-invocation context names the running agent.
    installAnalyticsDiagnostics(this.env, { workspace: ctx.id.name ?? '' });
    attributeWorkspace(ActorAgent.invocationWorkspace);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PAGE_KEEPALIVE.ping, PAGE_KEEPALIVE.pong));
  }

  /**
   * Total only while every subclass fixes its name at construction or refuses to exist, as
   * OrchestratorAgent does; one that does not brings PartyServer's throwing `name` into the logger.
   */
  private static invocationWorkspace(this: void): string {
    const { agent } = getCurrentAgent();

    return agent instanceof ActorAgent ? agent.workspaceName() : '';
  }
  /** Puts the client gate (client-socket-gate.ts) in front of the Agent base's socket and request handlers. */
  protected installClientMessageGate(): void {
    const gated = gatedClientHandlers({
      storageRefusal: () => this.storageRefusal,
      runtimeRefusal: () => this.actorRuntimeRefusal(),
      terminalFor: (connection) => this.terminalFor(connection),
      hostedWindowName: (actorId) => this.hostedWindowName(actorId),
      chatRoomFor: (connection) => this.chatRoomFor(connection),
      seed: async (hosted) => (await (hosted === null ? this.chatTransport.wire.seed() : this.hostedChatWire(hosted)?.seed()))?.messages,
      media: async (actorId, ref) => await (actorId === this.actorHandle().actorId ? this.chatTransport.wire : this.hostedChatWire(actorId))?.media(ref),
      overviewChanged: () => { this.overviewChanged(); },
      connectionOpened: () => { this.connectionOpened(); },
      lastConnectionClosed: () => { this.lastConnectionClosed(); },
      turnClaimFrame: () => this.turnClaimFrame(),
      connections: () => this.getConnections(),
      ownerHub: () => this.requireOwnerUserDO(),
      caller: () => this.userCaller(),
      workspace: () => this.name,
    }, {
      onMessage: this.onMessage.bind(this), onConnect: this.onConnect.bind(this), onClose: this.onClose.bind(this), onRequest: this.onRequest.bind(this),
    });

    this.onMessage = gated.onMessage;
    this.onConnect = gated.onConnect;
    this.onClose = gated.onClose;
    this.onRequest = gated.onRequest;
  }
  /** Lazy: `actorHandle()` resolves the directory row the constructor creates, after field init. */


  // A durable turn ends once; its effects are claimed in `tool_effect_claims` keyed on the
  // durable turn id, written before the first effect and settled after the last.
  // Not exactly-once externally: each external effect relies on its own idempotency key.

  /** Effect bodies shared by every actor; per-actor effects live in each actor's own table. Main's turn is recorded and
   *  its events drained here, where its evolution tables and event log are; its answer is read from its own isolate. */
  protected sharedTerminalEffects(): TerminalEffectTable {
    return {
      ...turnRecordingEffects({ orchestrator: () => this.recording, engine: this.engine }),
      turn_end_extensions: terminalEffect({
        input: v.object({ messageId: v.string() }),
        // Replayed from the recorded message, not a live tree; the row stops a second announcement.
        // Convert inside the durable effect so an eviction leaves an owed announcement.
        run: async ({ messageId }) => {
          const answer = await this.mainAnswer(messageId);

          if (answer === null) throw new KinuError('missing', 'terminal effect has no canonical answer');
          const { message, content: text } = answer;
          // A refusal, not a retry: the stored message is fixed, so a part tree the converter rejects
          // never parses later and an owed row would retry forever. The announcement still fires.
          let responseMessages: ModelMessage[] = [];
          let refusal: string | undefined;

          try {
            responseMessages = await convertToModelMessages(
              [message], { ignoreIncompleteToolCalls: true },
            );
          } catch (err) {
            const failure = toKinuError({
              doing: "reading the recorded assistant message this turn's extensions announce",
              cause: err,
              otherwise: 'bad_input',
            });

            diagnostics.failure('turn.turn_end_messages_unreadable', failure);
            refusal = failure.message;
          }

          await this.extensions.emitTurnEnd({ text, responseMessages });

          return refusal === undefined
            ? { status: 'completed' }
            : { status: 'completed', detail: refusal };
        },
      }),
      // Its lanes read durable queues on re-entry (per-turn snapshots do not survive).
      ...actorTerminalEffects({
        hireAdvisor: (advisor) => this.advisor.hire(advisor),
        applyTitle: async (subject, standIn) => {
          const unreachable = await this.titlingRefusal();

          if (unreachable !== null) return unreachable;
          await this.applyAutoTitle(subject, standIn);

          return null;
        },
        startEvolution: () => { this.settleEvolutionInBackground(); },
      }),
    };
  }

  /** The effects this actor's terminal sequence can owe; both actor kinds spread in {@link
   *  sharedTerminalEffects}. */
  protected terminalEffectTable(): TerminalEffectTable {
    return {};
  }

  private _terminalTransitions: TerminalTransitions | null = null;

  /** Every settled turn's close this activation began has ended; an activation that began none has none to wait for. */
  protected async terminalClosed(): Promise<void> {
    await this._terminalTransitions?.idle();
  }

  protected get terminal(): TerminalTransitions {
    this._terminalTransitions ??= new TerminalTransitions({
      actor: this.actorHandle(),
      standing: async () => this.actorDirectoryStore().standing(this.actorHandle().actorId),
      sql: this.boundSql,
      holds: this.held,
      effects: this.terminalEffectTable(),
      now: () => Date.now(),
      fault: () => this.terminalEffectFault,
      // A synchronous DO run is already atomic; transactionSync keeps the claim and roster one unit
      // regardless of what core later puts between them.
      transaction: (body) => this.ctx.storage.transactionSync(body),
      // Release must not run while an auto-continuation is calling tools under this turn before it
      // has its own terminal claim.
      turnIsLive: (turnId) => this.mainChatTurn() === turnId,
      scheduleRetry: async (atMs: number) => { await this.scheduleTerminalRetry(atMs); },
      settled: async () => {},
      // Kept alive, not recovered: the ledger row is the obligation and the terminal wake replays it. Rests once the
      // close has left the held set, so of a close's end and a quiet pump, whichever comes last rests the actor.
      hold: (close) => this.holdLane(async () => {
        await close();
        await this.restWhenIdle();
      }).finally(() => { this.overviewChanged(); }),
    });

    return this._terminalTransitions;
  }

  /** Set by the last maintenance pass. */
  protected maintenanceUnfinished = false;

  /** Nothing owed: a turn's arm goes. */
  protected async restWhenIdle(): Promise<void> {
    if (this.mainChatTurn() === null && !this.owedWorkExists()) await this.wakes.cancel(TERMINAL_RETRY_JOB);
  }

  /** One soonest-wins wake per actor. */
  protected scheduleTerminalRetry(atMs: number, pace?: WakePace): Promise<void> {
    return this.wakes.arm(TERMINAL_RETRY_JOB, atMs, pace);
  }

  /** `prior`: the firing job's streak. */
  async terminalRetryPass(prior: WakePace = { laps: 0, arms: null }): Promise<void> {
    // Arm first, drain second: the next-lap wake is durable before any pass runs, so a kill
    // inside this frame leaves a future row. A tick that finds nothing owed releases it at the end.
    const lapAt = Date.now() + recoveryBackoffMs(prior.laps + 1);
    await this.scheduleTerminalRetry(lapAt, { laps: prior.laps + 1, arms: prior.arms });

    // Owed deliveries run every tick; unfinished maintenance re-arms at the shared capped backoff,
    // so a pass that keeps answering unfinished settles at the ceiling, not a one-second loop.
    const sweepsUnfinished = this.maintenanceSweeps();
    const recoveryUnfinished = await this.maintenanceWork();
    this.maintenanceUnfinished = sweepsUnfinished || recoveryUnfinished;
    await this.owedDeliveryWork();
    // Re-entered here because `maintenanceWork` is activation-scoped: later ticks in a warm
    // isolate never reach the job sweep, and a deferred job's wake would find nothing to recover.
    await this.jobRunner.recoverDueResumes();

    // Untimed owed work names no instant, so the lap-paced row is kept (a missing row sleeps until
    // an external event). Only timed work: arm at its instant, soonest-wins. Nothing owed: sleep.
    const nextOwed = this.nextOwedAt();

    const arms = { sweeps: sweepsUnfinished, recovery: recoveryUnfinished, ...this.owedUntimedArms() };
    const named = Object.entries(arms).filter(([, owed]) => owed).map(([arm]) => arm).join(',');

    if (named !== '') {
      if (named !== prior.arms) diagnostics.event('wake.unfinished_arms', { ...arms, workspace: this.name, source: named });

      await this.scheduleTerminalRetry(lapAt, { laps: prior.laps + 1, arms: named });

      if (nextOwed !== null) await this.scheduleTerminalRetry(nextOwed);
    } else {
      await this.wakes.cancel(TERMINAL_RETRY_JOB);

      if (nextOwed !== null) await this.scheduleTerminalRetry(nextOwed, { laps: 0, arms: null });
      // A lap or an owed effect's retry that found its arm already gone: a wake nothing else may log.
      else diagnostics.event('wake.nothing_owed', { workspace: this.name, laps: prior.laps, arms: prior.arms ?? 'none' });
    }

    // A turn a deploy cut short reads right by the next tick of the wake it armed.
    this.overviewChanged();
  }

  /**
   * Runs every tick regardless of maintenance's answer, so owed replies never queue behind a sweep.
   * Subclasses prepend extra owed lanes here so all ride one durable wake.
   */
  protected async owedDeliveryWork(): Promise<void> {
    // Detached effects close in their own fiber: a title in its provider's backoff must not hold the wake's job.
    await this.terminal.replayOwedAndRearm();
  }

  protected owedWorkExists(): boolean {
    return this.maintenanceUnfinished || this.owedUntimedWork() || this.nextOwedAt() !== null;
  }

  /** While true, the tick keeps its lap-paced row. Base owns no rosters; subclasses override. */
  protected owedUntimedWork(): boolean {
    return Object.values(this.owedUntimedArms()).some(Boolean);
  }

  protected owedUntimedArms(): UntimedArms {
    return {};
  }

  /** Earliest timed obligation instant, or null when only untimed work (or nothing) remains.
   *  Subclasses that own the ledgers override. */
  protected nextOwedAt(): number | null {
    return null;
  }

  /** Test-only deterministic cut point in the terminal sequence. Null in production. */
  protected terminalEffectFault: TerminalEffectFault | null = null;

  /** The turn an agent runs now, as its isolate's room heard it open; null between its turns. */
  protected abstract currentTurnOf(reference: ActorReference): string | null;

  /** Uses `effectiveModelSpec`: the stored spec can be null or an un-normalized alias. */
  private analyticsModel(): ModelDimensions {
    return this.analyticsModelOf(this.effectiveModelSpec());
  }

  /**
   * `parseModelSpec` throws on unknown shapes and `report.spec` comes from many producers, so a
   * malformed spec costs the row its dimensions rather than the caller its turn.
   */
  protected analyticsModelOf(spec: string): ModelDimensions {
    if (!spec) return UNRESOLVED_MODEL;

    try {
      const { provider, modelId } = parseModelSpec(spec);

      return { provider, model: modelId };
    } catch (error) {
      diagnostics.event('actor.model_spec_unparseable', {
        workspace: this.name, error: renderThrownChain({ cause: error }),
      });

      return UNRESOLVED_MODEL;
    }
  }

  /** Cost at the model's current catalog rate; undefined when the catalog has no rate. */
  private priceAt(usage: Usage): number | undefined {
    const pricing = this.modelCatalog.pricing();

    return pricing ? priceCall(usage, pricing) : undefined;
  }

  /** Lazy: resolves this actor's handle, whose directory row the subclass constructor creates after
   *  this field initializes. */
  private _compactionState: CompactionStateStore | null = null;
  protected get compactionState(): CompactionStateStore {
    return (this._compactionState ??= createCompactionStateStore(this.boundSql, this.actorHandle()));
  }

  /** Shared by the per-turn extension and swarm ladder so outcome names cannot drift. */
  private readonly compactionLogger: CompactionLogger = {
    info: (message, data) => this.logActivity('compaction', compactionLogDetail(message, v.safeParse(CompactionDetailSchema, data))),
    debug: (message) => diagnostics.event('compaction.debug', { message }),
    warn: (message, data) => { this.reportCompaction('warn', message, v.safeParse(CompactionDetailSchema, data)); },
    error: (message, data) => { this.reportCompaction('error', message, v.safeParse(CompactionDetailSchema, data)); },
  };

  private reportCompaction(outcome: keyof typeof COMPACTION_OUTCOMES, message: string, detail: CompactionDetail): void {
    const { event, code, activity } = COMPACTION_OUTCOMES[outcome];

    diagnostics.failure(event, new KinuError(code, message));
    this.logActivity(activity, compactionLogDetail(message, detail));
  }

  /** Handed to every turn (core adds the inbox's own turn extension itself), and to the swarm for its shared prefix. */
  private _compaction: CompactionExtension | null = null;

  protected compaction(): CompactionExtension {
    this._compaction ??= createActorCompaction({
      files: () => this.rt,
      state: this.compactionState,
      // The workspace's own compactions (a swarm's shared prefix) freeze nothing of a conversation: every agent's is its
      // own isolate's, which compacts it there.
      ledger: new DynamicContextLedger(true),
      logger: this.compactionLogger,
      summarizer: () => this.getModel(),
      spend: { report: (report) => this.reportModelCall(report), operations: this.modelOperations },
    });

    return this._compaction;
  }

  protected registerCompactionExtension(): void {
    this.extensions.register(this.compaction());
  }

  /** Tags ride the WebSocket attachment, so the rpc gate, both identities and the pane's chat room
   *  survive DO hibernation (edge-set headers, see appendIdentityHeaders). */
  override async getConnectionTags(connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const tags = await super.getConnectionTags(connection, ctx);
    const scopeTag = cliScopesConnectionTag(ctx.request.headers.get(CLI_SCOPES_HEADER));
    const bearerTag = cliBearerConnectionTag(ctx.request.headers.get(CLI_BEARER_HEADER));
    const sessionTag = sessionBearerConnectionTag(ctx.request.headers.get(SESSION_BEARER_HEADER));
    const actorId = ctx.request.headers.get(HOSTED_ACTOR_ID_HEADER);
    const actorTag = actorId === null || hostedActorRoute(new URL(ctx.request.url).pathname) === null ? null : actorConnectionTag(actorId);

    return [
      ...tags,
      ...(scopeTag === null ? [] : [scopeTag]),
      ...(bearerTag === null ? [] : [bearerTag]),
      ...(sessionTag === null ? [] : [sessionTag]),
      ...(actorTag === null ? [] : [actorTag]),
    ];
  }

  /**
   * Close every CLI websocket admitted before `generation`; called by the owner's UserDO on revocation.
   * A silent client sends no frames but keeps receiving the stream; unreadable bearers are closed.
   */
  async closeRevokedCliSockets(generation: number): Promise<{ closed: number }> {
    let closed = 0;

    for (const connection of this.getConnections()) {
      const bearer = cliBearerFromTags(connection.tags);

      if (bearer === null) continue;

      if (bearer.readable && bearer.generation >= generation) continue;
      connection.close(WEBSOCKET_POLICY_CLOSE, CLI_AUTHORITY_REVOKED);
      closed += 1;
    }

    if (closed > 0) {
      diagnostics.event('auth.cli_sockets_closed', { outcome: 'denied', closed, generation });
    }

    return { closed };
  }

  /**
   * Close every websocket authenticated on the named browser session; called by UserDO on logout.
   * A silent socket never reaches the frame-time check, so revocation has to push.
   */
  async closeRevokedSessionSockets(sessionTokenHash: string): Promise<{ closed: number }> {
    let closed = 0;

    for (const connection of this.getConnections()) {
      const session = sessionBearerFromTags(connection.tags);

      if (session === null) continue;

      if (!('tokenHash' in session) || session.tokenHash !== sessionTokenHash) continue;
      connection.close(WEBSOCKET_POLICY_CLOSE, SESSION_AUTHORITY_REVOKED);
      closed += 1;
    }

    if (closed > 0) {
      diagnostics.event('auth.session_sockets_closed', { outcome: 'denied', closed });
    }

    return { closed };
  }

  /** Scoped access-token connections may chat but never write agent state. */
  override shouldConnectionBeReadonly(connection: Connection, ctx: ConnectionContext): boolean {
    return this.actorRuntimeRefusal() !== null || super.shouldConnectionBeReadonly(connection, ctx)
      || ctx.request.headers.get(CLI_SCOPES_HEADER) !== null;
  }

  private _rt: CFRuntime | null = null;

  /** The workspace agent's evolution lanes, the workspace's own: its turns run in its isolate, which keeps their
   *  accounting, and are recorded and judged here. */
  private _lanes: EvolutionLanes | null = null;

  protected get lanes(): EvolutionLanes {
    this._lanes ??= new EvolutionLanes({
      engine: this.engine, budget: this.budget,
      // Runs on the single off-turn cadence pass, after the session chain.
      refinementLane: async () => { await refinementPass(this.refinementDeps); },
    });

    return this._lanes;
  }

  /** What the workspace agent's settled turns owe its lanes: their record, and the drain of the events they bound. */
  private get recording(): Pick<AgentOrchestrator, 'recordTurn' | 'drainPendingEvents'> {
    return {
      recordTurn: (turn, continuity, opts) => { this.lanes.recordTurn(turn, continuity, opts); },
      drainPendingEvents: (opts) => drainPendingEvents({ eventLog: this.eventLog, deliveries: this.workspaceAgentDeliveries() }, opts),
    };
  }

  /** The workspace agent's advisor, hired through this object's port and judged by the workspace's engine. */
  private _advisor: ActorAdvisor | null = null;

  protected get advisor(): ActorAdvisor {
    this._advisor ??= new ActorAdvisor({
      actor: this.actorHandle(), vfs: () => this.rt.agentStateVfs, notes: () => this.engine,
      port: () => this.temporaryAgentPort(), reviewed: this.actorDirectoryStore().describe(this.actorHandle()).input,
      send: (signal) => this.workspaceAgentDeliveries().signals.send(signal),
      profile: () => this.operationProfile()?.profile ?? null, scoped: (turn) => this.lanes.scopedTurn(turn),
    });

    return this._advisor;
  }

  /** Each slate `agent.ask` reply, fed by main's own turns as they reach this object's room. */
  protected readonly replies = new TurnReplies();

  private _chatTransport: ChatWireTransport | null = null;
  protected get chatTransport(): ChatWireTransport {
    this._chatTransport ??= new ChatWireTransport({ ...this.mainChatWire(), replies: this.replies });

    return this._chatTransport;
  }

  /**
   * One actor's windows; `null` is the workspace's, which alone get the root's own frames, while one every window may
   * read (device consents, device availability) goes to all. Built on `broadcast`, the only send that reaches hibernated sockets.
   */
  protected broadcastToActor(actor: string | null, message: string, exclude?: readonly string[]): void {
    const elsewhere: string[] = [];

    for (const connection of this.getConnections()) {
      if (actorFromConnectionTags(connection.tags) !== actor) elsewhere.push(connection.id);
    }

    this.broadcast(message, [...new Set([...(exclude ?? []), ...elsewhere])]);
  }

  /** The runtime shell a socket addresses, or null for a chat or RPC socket; the base always returns null. */
  protected terminalFor(_connection: Pick<Connection, 'tags'>): Promise<WorkspaceTerminal | null> {
    return Promise.resolve(null);
  }

  /** Excludes terminal sockets: they carry only shell frames, not the actor protocol. */
  override broadcast(message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void {
    const terminals: string[] = [];

    for (const connection of this.getConnections()) {
      if (isWorkspaceTerminal(connection.tags)) terminals.push(connection.id);
    }

    super.broadcast(message, terminals.length === 0 ? without : [...(without ?? []), ...terminals]);
  }

  private _chatRooms: ActorChatRooms | null = null;
  protected get chatRooms(): ActorChatRooms {
    return this._chatRooms ??= new ActorChatRooms(this.actorHandle().actorId, () => this.chatTransport, (actorId) => this.hostedChatWire(actorId));
  }

  /** Null when the addressed actor is no longer hosted here. */
  protected chatRoomFor(connection: Connection): ChatWireTransport | null {
    return this.chatRooms.for(actorFromConnectionTags(connection.tags));
  }

  /** Null when this workspace hosts no such actor; only the workspace root knows its directory. */
  protected abstract hostedChatWire(actorId: string): ChatWire | null;

  /** The workspace's own room: main's chat, in main's own isolate. */
  protected abstract mainChatWire(): ChatWire;

  /** Main's programmatic turns are handed to its chat, in its own isolate (D9). */
  protected abstract enqueueMainTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;

  /** The workspace agent's deliveries: its signals, and its events bound to a turn, committed then crossed. */
  protected abstract workspaceAgentDeliveries(): AgentOrchestratorDeps['deliveries'];

  /** The owner's Stop of an agent: nothing it was owed or had queued runs after it. */
  protected abstract stopAgent(actorId: string): Promise<void>;

  /** The owner's Clear of main's chat; answers why the emptied request went unmeasured, if it did. */
  protected abstract clearMainConversation(): Promise<string | null>;

  /** One of main's answers whole, from its own isolate; null for an id that names none. */
  protected abstract mainAnswer(messageId: string): Promise<AgentAnswer | null>;

  /** The metadata of main's newest message from a person, from its own isolate; undefined before any. */
  protected abstract mainLastUserMetadata(): Promise<JsonObject | undefined>;

  /** The chat turn main's isolate runs now, as its room heard it open; null between turns. */
  protected abstract mainChatTurn(): string | null;

  /** What that turn's tools run under; null between turns. */
  protected abstract mainChatSurface(): TurnSurface | null;

  /** The turn main's tools run under now: the one their call or their build runs in, else the one main's chat holds. */
  protected mainTurn(): TurnSurface | null {
    return scopedTurnSurface() ?? this.mainChatSurface();
  }

  /** A hosted agent's plan reviews, in its own isolate; null for a name this workspace holds no agent under. */
  protected abstract hostedPlanReviews(actorId: string): HostedPlanReviews | null;

  protected abstract hostedQuestions(): HostedOwnerQuestions;

  /** An owner's words to an agent, resolved once its chat has reserved them, as the root's `admit` is. */
  protected abstract hostedAdmit(actorId: string, input: SentWords & { readonly id: string }): Promise<void>;

  protected abstract hostedWindowName(actorId: string): string | null;

  /** Fires for any actor's connection; the root's sleep-time closed-tab trigger overrides both hooks. */
  protected connectionOpened(): void {}

  /** Fires once per emptying, in the close hook, after the room has been told. */
  protected lastConnectionClosed(): void {}

  /** Fires after each committed change to the root actor's turn claims. */
  protected abstract turnClaimChanged(): void;

  /** The root actor's turn claim as it stands, as the frame its tabs hear on connecting and on each change. */
  protected abstract turnClaimFrame(): string;

  protected abstract overviewChanged(): void;

  protected abstract liveReadsMoved(reads: readonly LiveRead[]): void;

  /** Cumulative cap a scheduled run or fork opts into; costs nothing with no active label.
   * Public so the `agent.*` namespace uses the same object the enforcement seams hold. */
  private _budget: MissionGovernor | null = null;
  get budget(): MissionGovernor {
    this._budget ??= new MissionGovernor({
      actor: this.actorHandle(),
      storage: this.rt.storage,
      // Real USD from catalog rates; null until the lookup lands, then the ledger blends and says so.
      pricing: (spec) => this.modelCatalog.pricing(spec),
      onExhausted: ({ error: _error, ...refusal }) => {
        this.emitRunEvent({ type: 'budget_exhausted', ...refusal });
      },
    });

    return this._budget;
  }

  /** A run event for the turn in flight; a failed write is logged, never thrown into the turn. */
  private emitRunEvent(event: Extract<RunEventInput, { type: keyof typeof RUN_EVENT_EMIT_FAILED }>): void {
    settleLoggedSync(RUN_EVENT_EMIT_FAILED[event.type], { doing: `recording a ${event.type} run event`, otherwise: 'io' }, () => {
      if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, event);
    });
  }

  /**
   * Mission ledger for facets, which run as separate DOs the governed `LLM` never sees; called over
   * a cross-DO stub. Not `@callable`: a spend ledger must not be writable over public WS/HTTP.
   * Inert with an empty label set.
   */
  async missionGuard(
    seam: MissionSeam, labels: readonly string[],
  ): Promise<MissionBudgetRefusal | null> {
    return this.budget.guard(seam, labels);
  }

  async missionDebit(tokens: number, opts: {
    labels: readonly string[]; calls?: number; spawns?: number; usage?: Usage; spec?: string;
  }): Promise<void> {
    this.budget.debit(tokens, opts);
  }

  // Head-journal writes for a recursive split run in this isolate (orchestrator.ts `runHostedSplit`),
  // so spawn/report rows land beside their head_steps. Never `@callable`; allowlisted in rpc-surface.ts.

  async headJournalRecordSplit(rootId: HeadId, rationale: string, spawnedAt: number): Promise<void> {
    this.headJournal.recordSplit(rootId, rationale, spawnedAt);
  }

  async headJournalInsertSpawn(input: HeadInput): Promise<void> {
    this.headJournal.insertSpawn(input);
  }

  async headJournalRecordReport(report: HeadReport): Promise<void> {
    // The journal write publishes the report's announcement; do not broadcast again here.
    this.headJournal.recordReport(report);
  }

  async headJournalCacheMerge(rootId: HeadId, narrative: string): Promise<void> {
    this.headJournal.cacheMerge(rootId, narrative);
  }

  private _evolutionSettling: AsyncTaskOwner | null = null;

  /** A turn settled while the lane ran: its pass started before this turn's review, so one more runs after it. */
  private _evolutionOwed = false;

  /**
   * Settle both evolution lanes (turn lane, then the cadence pass) in a durable fiber, detached so the chat queue is
   * not blocked. Inputs are re-read from durable queues, so the row needs no checkpoint: one an earlier activation left
   * is re-driven by the next (`OrchestratorAgent.recoverDeadActivation`). One lane at a time.
   */
  protected settleEvolutionInBackground(): void {
    if (this._evolutionSettling !== null) {
      this._evolutionOwed = true;

      return;
    }

    const owner: AsyncTaskOwner = { promise: null };
    this._evolutionSettling = owner;
    owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.promise(() => this.rt.schedule.fiber(EVOLUTION_LANE_FIBER, async () => {
      await this.lanes.settleEvolution();
    })), recording({ doing: 'settling the turn and session evolution lanes', otherwise: 'unavailable' }, (failure) => {
      diagnostics.failure('evolution.settle_failed', failure);
    })), Effect.sync(() => {
      if (this._evolutionSettling === owner) this._evolutionSettling = null;

      if (!this._evolutionOwed) return;
      this._evolutionOwed = false;
      this.settleEvolutionInBackground();
    })));
  }

  /**
   * Warm this user's MCP connections for the next turn, detached, via `userMcp_warmConnections`. Covers
   * alarm/email/post-eviction turns the HTTP warmup misses. Failures are dropped and a warm lost to eviction is not
   * resumed: the next settled turn warms again, so it is held by `keepAliveWhile`, not a `cf_agents_runs` row.
   */
  protected _mcpWarmTask: AsyncTaskOwner | null = null;

  protected warmUserMcpInBackground(): void {
    // Same gate as `buildUserMcpTools`: no capability token yet is an ordinary state, not a failure.
    if (!this.getOwnerUserId() || !this.workspaceCapabilityToken() || this._mcpWarmTask !== null) return;
    const owner: AsyncTaskOwner = { promise: null };
    this._mcpWarmTask = owner;
    owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.promise(() => this.keepAliveWhile(async () => {
      const { stub, caller } = await this.userHub();
      await stub.userMcp_warmConnections(caller);
    })), recording({ doing: 'establishing the user MCP connections after a settled turn', otherwise: 'unavailable' }, (failure) => {
      diagnostics.failure('mcp.settle_warmup_failed', failure);
    })), Effect.sync(() => {
      if (this._mcpWarmTask === owner) this._mcpWarmTask = null;
    })));
  }

  /** This actor's ports and models for core's scaffold control plane (evolution/control.ts). */
  protected get scaffoldControl(): ScaffoldControl {
    return {
      rt: this.rt,
      events: this.eventRecorder,
      sql: this.boundSql,
      surface: (task, context, callScope) => {
        // One set for the run: each request's tools project it, and so do its machines.
        const ledgers = this.ownLedgers();
        const stores = serveStores(builtinStoreDeps(this.ownStoreInputs(ledgers)));

        return createScaffoldCandidateSurface({
          ...this.scaffoldCandidateModel(),
          tools: () => this.ownTools(this.turnWorkMode(), callScope ?? null, { ledgers, stores }).raw,
          stores,
          callScope,
          history: this.makeScaffoldHistory(),
          spend: this.scaffoldSpend(),
        }, task, context);
      },
    };
  }

  /** On the substrate like `scaffoldControl`. Only the workspace agent dreams: a facet's engine is built disabled. */
  protected get refinementDeps(): RefinementDeps {
    return {
      control: this.scaffoldControl,
      facts: this.facts,
      approvals: this.instructionApprovals(),
      skillsVfs: this.rt.storage.vfs,
      recordedTurns: () => this.recordedTurns(),
    };
  }

  private scaffoldCandidateModel(): Pick<ScaffoldCandidateBinding, 'rt' | 'profile' | 'bindModel' | 'modelContext' | 'compose'> {
    return {
      rt: this.rt,
      compose: () => this.composeNextRequest(),
      profile: async () => {
        const mode = await this.preparedWorkMode();

        return this.routingProfile([...Object.keys(this.getRawToolsForWorkMode(mode)), ...codemodeCapabilitiesFor(this.ownNamespaces(mode))], mode);
      },
      bindModel: spec => this.ownedModelServices.resolveModel(spec),
      modelContext: spec => this.modelCatalog.contextFor(spec),
    };
  }

  /** Read per call: a scaffold spanning a turn sees the prepared messages as they stand now. */
  protected makeScaffoldHistory(): NonNullable<ScaffoldRunOptions['history']> {
    return createScaffoldHistory(async () => [...await this.mainWorkingContext()]);
  }

  // Platform fan-out and wake ownership around core's serialized chat loop.
  private _host: BackendHost | null = null;
  protected readonly _drainTimerTasks = new Map<string, AsyncTaskOwner>();
  protected get host(): BackendHost {
    if (!this._host) {
      const armWake = this.durableWakeOwner();
      this._host = {
        broadcast: (event) => {
          // A slate's asked message lands where its card is shown, in main's turn running then.
          this.replies.card(event, this.mainChatTurn());
          this.broadcast(JSON.stringify(event));
        },
        enqueueTurn: (input) => this.enqueueMainTurn(input),
        // A signal while main's turn runs is held here and re-delivered as its next turn when that turn ends: its isolate's
        // steps never read this object's buffer, and an enqueue now would wait out the running turn.
        turnInFlight: () => this.mainChatTurn() !== null,
        // Its chat is its isolate's, which never ends.
        closed: () => false,
        // keepAliveWhile holds the DO through the debounce window and drain; if it dies anyway,
        // events stay durable in the EventLog and a later drain picks them up.
        setTimer: (fn, ms) => {
          const timerKey = nanoid();
          const owner: AsyncTaskOwner = { promise: null };
          this._drainTimerTasks.set(timerKey, owner);
          owner.promise = hold(Effect.ensuring(Effect.catchCause(Effect.promise(() => this.keepAliveWhile(async () => {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, ms);
            });

            await settleLogged('drain.timer_callback_failed', { doing: 'running the debounced event drain', otherwise: 'io' }, () => fn());
          })), recording({ doing: 'holding the actor alive across the drain debounce window', otherwise: 'io' }, (failure) => {
            diagnostics.failure('drain.timer_keepalive_failed', failure);
          })), Effect.sync(() => {
            if (this._drainTimerTasks.get(timerKey) === owner) {
              this._drainTimerTasks.delete(timerKey);
            }
          })));
        },
      };

      // Assigned rather than spread so an actor with no wake chain leaves the key absent: core reads
      // the seam's presence as a claim the host can deliver an unwatched wake.
      if (armWake) this._host.reconcileDurableWake = armWake;
    }

    return this._host;
  }

  /** Null when this actor's next wake is somebody else's event; only a root owning a Kinu timer
   *  chain answers. See `BackendHost.reconcileDurableWake`, `OrchestratorAgent.armDurableWake`. */
  protected durableWakeOwner(): (() => void) | null {
    return null;
  }
  /** Debounces the last-active-executor write to one SQL upsert per executor per turn. */
  protected _executorsUsedThisTurn = new Set<string>();
  // Cached against the content hash of UserDO's MCP descriptor surface, so closures rebuild
  // exactly when the durable rows differ from what this activation last served.
  private _mcpToolsCache: McpToolSurfaceCache<ToolSet> | null = null;
  /** Rendered into the turn's dynamic context so missing MCP servers are legible. */
  private _mcpUnavailable: NonNullable<DynamicContextInput['unavailableMcp']> = [];

  private noteGitHubCall(descriptor: Pick<SerializableToolDescriptor, 'presetId' | 'name'>, args: JsonObject, result: string, actorId: string | null): void {
    if (descriptor.presetId !== GITHUB_MCP_PRESET) return;
    recordGitHubActivity(this.boundSql, recognizeGitHubMcp(descriptor.name, args, result), { actorId, at: Date.now() });
  }

  private get mcpToolsCache(): McpToolSurfaceCache<ToolSet> {
    this._mcpToolsCache ??= new McpToolSurfaceCache<ToolSet>(async (descriptors) =>
      // `buildMcpToolSet` puts every non-readOnly tool behind the same durable claim as natives,
      // using ambient turn deps because this cache is shared across turns (KINU-019).
      buildMcpToolSet(descriptors, {
        call: async (d, args, options) => {
          const rawResult = await callUserMcpTool({ stub: this.requireOwnerUserDO(), caller: await this.userCaller() }, d, args, options.abortSignal);

          this.noteGitHubCall(d, args, rawResult, this.actorHandle().actorId);

          return v.parse(JsonValueSchema, JSON.parse(rawResult));
        },
        effectClaims: {
          actor: this.actorHandle(),
          sql: this.rt.storage.sql,
          // A call outside any operation (a slate's) is no turn's effect.
          execution: () => currentOperationProfile(this.actorHandle()) ?? { turnId: WORKSPACE_RUN_ID, runId: WORKSPACE_RUN_ID },
          transaction: (body) => this.ctx.storage.transactionSync(body),
        },
        spill: this.rt.storage,
      }));

    return this._mcpToolsCache;
  }

  // The eval sandbox reads craftStore.list() on every execute, so saved tools appear without
  // cache coherence work.
  private _codemodeFactory: CodemodeFactory | null = null;
  /** A slate's crafted-tool calls, by the actor whose programs they launch; null for a share's viewer. */
  private readonly _slateToolFactories = new Map<string | null, CodemodeFactory>();

  /** Lazy: `boundSql` is not touched until a store is first read, so this can be built here
   *  rather than in the constructor body. */
  protected readonly stores = createAgentStores(
    () => this.boundSql, () => this.actorHandle(), write => this.ctx.storage.transactionSync(write),
    async () => ({
      vfs: this.workspaceBox(this.shellId()).store({ home: WORKSPACE_ROOT }),
      artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)),
    }),
  );

  private _liveHeadJournal: LiveHeadJournal | null = null;

  /** Announcing wrapper over the head store, shared by every head-journal write and getHeadRuns;
   *  core's swarm runner has no progress seam, so liveness hangs here. */
  protected get headJournal(): HeadJournal {
    return (this._liveHeadJournal ??= new LiveHeadJournal(
      this.boundSql,
      this.actorHandle(),
      (headId: HeadId) => this.announceHeadActivity(headId),
    ));
  }

  /** Called by {@link LiveHeadJournal} only after its write returns; throws never reach core.
   *  Protected because hosted actors announce through the workspace's socket too. */
  protected announceHeadActivity(headId: string): void {
    this.broadcast(JSON.stringify({ type: 'head_activity', headId }));
    const rootId = this.headJournal.readHead(headId)?.root_id ?? headId;

    if (!isSteerBranchRunId(rootId)) this.broadcastMctsProgress(rootId);
  }

  /** Broadcast only, no state: a missed frame is corrected by the `head_activity` sent when its
   *  step lands. */
  protected publishHeadStreamFrame(frame: HeadStreamFrame): void {
    this.broadcast(JSON.stringify({ type: 'head_stream', ...frame }));
  }

  protected get eventRecorder(): RunEventRecorder {
    return this.stores.eventRecorder;
  }

  /** Main's turn as the fleet dataset reads it, from the completed turn its isolate settled. */
  protected recordMainTurnRow(turn: CompletedTurn, completed: boolean): void {
    const usage: Usage = turn.usage ?? {};

    recordTurnRow(this.env, {
      workspace: this.workspaceName(),
      agentKind: this.actorKind(),
      ...this.analyticsModel(),
      outcome: completed ? 'ok' : 'failed',
      code: '',
      durationMs: turn.durationMs,
      steps: turn.steps,
      toolCalls: turn.toolCalls.length,
      usage,
      usd: this.priceAt(usage),
    });
  }

  private _claimsObserved = false;

  /** Protected because a subclass settles and recovers claims it did not admit. The one way this object reaches
   *  its claims, so every change it makes to them reaches {@link turnClaimChanged}. */
  protected get claims(): ActorClaimStore {
    const claims = this.stores.claims;

    if (!this._claimsObserved) {
      this._claimsObserved = true;
      claims.observe(() => { this.turnClaimChanged(); });
      claims.observeRecovered((claim) => {
        this.tracing.turns({ id: this.actorHandle().actorId, kind: 'main' }).recovered(claim, claim.outcome);
      });
    }

    return claims;
  }

  /**
   * Record one non-turn model call (judges, fast tier, evolution, compaction, AI bindings) as a
   * `model_call` row; filed under the current run or the workspace id. Row shape and pricing guard
   * live in core's `pricedModelCallEvent`.
   */
  protected reportModelCall(report: ModelCallReport): void {
    const event = pricedModelCallEvent(report, this.modelCatalog);

    settleLoggedSync('event.model_call_emit_failed', { doing: 'recording a model_call run event', otherwise: 'io' }, () => {
      this.eventRecorder.emit(currentOperationProfile(this.actorHandle())?.runId ?? (this._currentRunId || WORKSPACE_RUN_ID), event);
    }, { source: report.source });

    // `spec` is absent on seams that never had one; the actor's effective model stands in so the
    // row stays countable against the provider it reached.
    const dimensions = report.spec === undefined
      ? this.analyticsModel()
      : this.analyticsModelOf(report.spec);

    recordModelRow(this.env, {
      workspace: this.workspaceName(),
      agentKind: this.actorKind(),
      provider: dimensions.provider,
      model: report.modelId ?? dimensions.model,
      source: report.source,
      usage: report.usage,
      // Reuse the durable row's number; re-deriving it can disagree with the ledger if the catalog
      // resolves a rate between the two reads.
      usd: event.usd,
    });
  }

  /**
   * Records direct model operations' start and end via core's shared mapper.
   * A start row with no end means the platform destroyed the frame mid-call.
   */
  protected readonly modelOperations: ModelOperationSink = recordModelOperations(
    // Resolve the recorder per emit: field initializers run in the DO constructor, and the store
    // bundle needs the actor directory that exists only after `onStart`.
    { emit: (runId, input) => { this.eventRecorder.emit(runId, input); } },
    () => currentOperationProfile(this.actorHandle())?.runId ?? (this._currentRunId || WORKSPACE_RUN_ID),
  );

  /** Records a provider-mandated wait to the ledger (`provider_wait`), and tells the windows of the turn it holds: a call
   *  a turn's tool made here. A call no turn made (a title, a logo, upkeep) holds no turn, so no window hears it.
   *  Recorder faults are contained so a ledger write never kills the sleep. */
  /** The run a provider's word belongs to: the operation's in flight, else the actor's current run. */
  private providerRunId(): string {
    return currentOperationProfile(this.actorHandle())?.runId ?? (this._currentRunId || WORKSPACE_RUN_ID);
  }

  private noteModelAttempt(info: ModelAttemptInfo): void {
    settleLoggedSync('event.model_attempt_emit_failed', { doing: 'recording a model_attempt run event', otherwise: 'io' }, () => {
      this.eventRecorder.emit(this.providerRunId(), { type: 'model_attempt', ...info });
    }, { provider: info.provider });
  }

  private noteProviderWait(info: ProviderWaitInfo): void {
    const runId = this.providerRunId();

    settleLoggedSync('event.provider_wait_emit_failed', { doing: 'recording a provider_wait run event', otherwise: 'io' }, () => {
      this.eventRecorder.emit(runId, { type: 'provider_wait', ...info });
    }, { provider: info.provider });

    const turn = activeOperationProfile();

    if (turn === undefined || turn.turnId === WORKSPACE_RUN_ID) return;
    const room = turn.actor.actorId === this.actorHandle().actorId ? null : turn.actor.actorId;

    this.broadcastToActor(room, JSON.stringify({ type: 'provider_wait', ...info }));
  }

  // EventsHub primitives. Spec: docs/ARCHITECTURE.md — "Events and ingress"
  private _eventLog: EventLog | null = null;
  protected get eventLog(): EventLog {
    this._eventLog ??= new EventLog(this.watchedExec, this.actorHandle());

    return this._eventLog;
  }
  protected get facts(): FactsStore {
    return this.stores.facts;
  }

  // Work auto-detached past the 30s threshold (#173).
  private _processEnds: ComputerProcessEnds | undefined;

  /** Where this object's actors' computer processes run as jobs end (`ComputerProcessEnds`). */
  protected get processEnds(): ComputerProcessEnds {
    return this._processEnds ??= new ComputerProcessEnds({
      state: (jobId) => jobState(this.jobRow(jobId)?.status),
      // The end is the job's own outcome: its row settles with it, through the runner that holds the job.
      complete: async (jobId, end) => {
        const row = this.jobRow(jobId);
        const process = row === null ? null : computerProcessJob(row.kind, row.input);

        if (row !== null && process !== null) await this.jobRunnerHolding(row.actorId)?.complete(jobId, { processId: process.processId, ...end });
      },
    });
  }

  /** A job's row in the workspace's one job table, whichever actor's it is. */
  protected jobRow(jobId: string): { readonly actorId: string; readonly kind: string; readonly status: string; readonly input: JsonValue } | null {
    const [row] = this.ctx.storage.sql.exec('SELECT actor_id, kind, status, input_json FROM background_jobs WHERE id = ?', jobId).toArray();
    const parsed = v.safeParse(v.object({ actor_id: v.string(), kind: v.string(), status: v.string(), input_json: v.nullable(v.string()) }), row);

    if (!parsed.success) return null;
    const { actor_id: actorId, kind, status, input_json: input } = parsed.output;

    return { actorId, kind, status, input: input === null ? null : v.parse(JsonValueSchema, JSON.parse(input)) };
  }

  /** The runner that holds `actorId`'s jobs: the workspace agent's, or a hire's own, revived if it is not hosted now. */
  protected jobRunnerHolding(actorId: string): BackgroundJobRunner | null {
    if (actorId === this.actorHandle().actorId) return this.jobRunner;

    return (this.jobAuthorities.live(actorId) ?? this.reviveJobAuthority(actorId))?.runner ?? null;
  }

  protected get jobs(): BackgroundJobStore {
    return this.stores.jobs;
  }

  // Written by the `tasks` tool; read for the live context block and the Tasks surface.
  protected get taskList(): TaskListStore {
    return this.stores.taskList;
  }

  /** Precondition of running a turn; never await from `onStart()` (inside blockConcurrencyWhile,
   *  reset at 30s per `do.block_concurrency.cancel_ms`). Owner-gated and latched per activation. */
  protected _scaffoldReady = false;
  protected async ensureOwnedScaffold(): Promise<void> {
    if (this._scaffoldReady || !this.getOwnerUserId()) return;

    if (!(await this.rt.identity.scaffold.exists())) {
      await bootstrapScaffold(this.rt);
      diagnostics.event('scaffold.bootstrapped', { workspace: this.workspaceName() });
    }

    this._scaffoldReady = true;
  }

  // Resume record for an evicted `action:'swarm'` search (B6); keyed by search root id.
  protected get mctsSearchStore(): MctsSearchStore {
    return this.stores.mctsSearchStore;
  }

  /**
   * Push one search's tree (search_nodes plus head journal), scoped by `rootId` since searches run
   * concurrently. `(isolateGen, pushSeq)` orders a root's frames across isolates.
   */
  broadcastMctsProgress(rootId: string): void {
    return settleSync(Effect.catchCause(Effect.sync(() => {
      const nodes = readSearchTree(this.boundSql, this.actorHandle(), rootId);
      const head = this.headJournal.readRun(rootId);

      if (nodes.length === 0 && head === null) return;
      const fingerprint = JSON.stringify([nodes, head]);

      if (fingerprint === this._lastMctsFingerprint.get(rootId)) return;
      this._lastMctsFingerprint.set(rootId, fingerprint);
      const pushSeq = (this._mctsPushSeq.get(rootId) ?? 0) + 1;
      this._mctsPushSeq.set(rootId, pushSeq);
      this.broadcast(JSON.stringify({
        type: 'mcts-progress', rootId, isolateGen: this.isolateGeneration, pushSeq, nodes, head,
      }));
    }), recording({ doing: 'pushing a swarm search tree to connected surfaces', otherwise: 'io' }, (failure) => {
      diagnostics.failure('mcts.progress_broadcast_failed', failure, { rootId });
    })));
  }

  /** Per activation: a reconnecting client is served by the surface's poll, not a resend. */
  private readonly _lastMctsFingerprint = new Map<string, string>();

  private readonly _mctsPushSeq = new Map<string, number>();

  // Background-job lifecycle (detach, settle, wake, cancel, evict-recovery) over the durable fiber
  // and the programmatic-turn wake. Owns the cancel-controller map.
  private _jobRunner: BackgroundJobRunner | null = null;
  protected get jobRunner(): BackgroundJobRunner {
    this._jobRunner ??= this.actorJobRunner(null, {
      store: this.jobs,
      // Foreground half depends on the surface (30s for chat). Wake half never varies: DO alarms deliver
      // wakes with nobody connected, so spawn-shaped work detaches on unwatched turns too.
      policy: () => invocationBackgroundPolicy(this.turnSurface(), true),
      fiber: (name, fn) => this.rt.schedule.fiber(name, fn),
      inbox: this.workspaceAgentDeliveries().signals,

      // Notify the owner (email on the orchestrator; skips silently when pieces are absent).
      notifySettled: (job) => {
        const notice = backgroundJobNotice(job);
        this.notifyOwner(notice.subject, notice.body);

      },
      // Evict-resume (B6): re-drive from the durable checkpoint. Side-effecting kinds (eval / run)
      // decline and fall back to the eviction failure. A computer's process runs on in its box across this object's
      // restart: its job is resumed by waiting for the end its box tells, starting nothing.
      resume: {
        resumes: (kind, input) => resumableBackgroundJob(kind, input) || this.computerProcessResume.resumes(kind, input),
        redrive: (kind, input, mode, signal) => (this.computerProcessResume.resumes(kind, input)
          ? this.computerProcessResume.redrive(kind, input, mode, signal)
          : this.resumeBackgroundJob(kind, input, mode, signal)),
      },
      // Same predicate as `resume`: a kind that cannot be re-driven has no harvestable partial.
      harvest: (kind, input) => Promise.resolve(harvestBackgroundJob(
        { sql: this.boundSql, actor: this.actorHandle(), ledger: this.mctsSearchStore }, kind, input,
      )),
      // Arms the actor's single terminal-retry row (soonest-wins); its tick re-enters the job sweep,
      // since the fork reconcile runs at most once per activation and a deferred job outlives that.
      scheduleResume: async (atMs) => { await this.scheduleTerminalRetry(atMs); },
    });

    return this._jobRunner;
  }

  /** The clock job runners detach on. */
  protected jobClock(): Clock {
    return REAL_CLOCK;
  }

  private _jobAuthorities: WorkspaceJobAuthorities | null = null;

  /** Every job a runner in this Durable Object drives now, shared by all of them through their ports. */
  private readonly jobsDrivenHere = new Set<string>();

  protected get jobAuthorities(): WorkspaceJobAuthorities {
    this._jobAuthorities ??= new WorkspaceJobAuthorities({
      root: () => ({ kind: 'root', actorId: this.actorHandle().actorId, store: this.jobs, runner: this.jobRunner }),
      revive: (actorId) => this.reviveJobAuthority(actorId),
    });

    return this._jobAuthorities;
  }

  protected reviveJobAuthority(_actorId: string): JobAuthority | null {
    return null;
  }

  /** Every actor's runner; null addresses the root's sockets. */
  protected actorJobRunner(owner: string | null, actor: ActorJobSeams): BackgroundJobRunner {
    const { notifySettled, ...own } = actor;

    return new BackgroundJobRunner({
      // A hire's computer processes resume as the workspace agent's do; one that re-drives more brings its own.
      resume: this.computerProcessResume,
      ...own,
      ...this.workspaceJobPorts(owner),
      logActivity: (event, detail) => this.logActivity(event, detail),
      onSettled: (job) => {
        notifySettled?.(job);
        this.detachOwned(Effect.promise(() => this.servingMoved()));
      },
    } satisfies BackgroundJobRunnerDeps);
  }

  /** Output goes to its owner's sockets. */
  protected workspaceJobPorts(owner: string | null): WorkspaceJobPorts {
    return {
      clock: this.jobClock(),
      drivenHere: this.jobsDrivenHere,
      alive: jobContextAnswers,
      jobOutput: (frame) => { this.broadcastToActor(owner, JSON.stringify(frame)); },
      // Only this request's device work moves; parallel foreground commands remain stoppable.
      onDetached: (jobId, requestIds) => {
        this.detachOwned(Effect.promise(() => this.servingMoved()));

        return this.transferDeviceRequests(jobId, requestIds);
      },
      // A refused device cancel, or a computer's process its box would not stop, leaves the job running and retryable.
      onCancelled: async (jobId) => {
        await this.stopComputerProcessJob(jobId);
        await stopWorkspaceProcessJob(this.jobRow(jobId), this.workspaceBox(this.shellId()), jobId);
        await this.cancelBackgroundDeviceRequests(jobId);
      },
      onSettled: () => { this.detachOwned(Effect.promise(() => this.servingMoved())); },
      // A command on the computer runs in the box's container, which a restart of this object leaves running: its
      // processes carry its job's id (`sandbox.ts`), and the box is asked for them without being started. In the
      // workspace, Nimbus starts a dev server or a node resident again under its job's exec id.
      stillRunning: async (job) => {
        if (isWorkspaceProcessJob(this.jobRow(job.id))) return await workspaceProcessJobRuns(this.workspaceBox(this.shellId()), job.id);
        const box = this.rt.sandboxHandle;

        return job.kind === 'shell' && box !== null && ((await box.stampedProcesses(JOB_STAMP_ENV, job.id))?.length ?? 0) > 0;
      },
    };
  }

  /** Even a partial transfer refusal keeps the job's device ownership and running state. */
  private async transferDeviceRequests(
    jobId: string, requestIds: readonly string[],
  ): Promise<void> {
    if (requestIds.length === 0) return;
    const { stub, caller } = await this.userHub();

    for (const requestId of requestIds) {
      const { transferred } = await stub.transferDeviceRequestToBackgroundJob(caller, requestId, jobId);

      if (!transferred) {
        throw new KinuError(
          'unavailable',
          `device request ${requestId} could not be handed to background job ${jobId}`,
        );
      }
    }
  }

  /**
   * `terminated` and `unknown` count as settled; any `failed` (command may still run) throws,
   * keeping the job `running` so the cancel can be retried.
   */
  /** A computer's process runs on across this object's restart: its job resumes waiting for the end its box tells. */
  private get computerProcessResume(): JobResumer {
    return computerProcessResume((jobId) => this.processEnds.ended(jobId));
  }

  /** A cancelled job that is a computer's process, read from the workspace's one job table, whichever actor's it is. */
  private async stopComputerProcessJob(jobId: string): Promise<void> {
    await stopComputerProcessJob(this.jobRow(jobId), this.rt.sandboxHandle, jobId);
  }

  private async cancelBackgroundDeviceRequests(jobId: string): Promise<void> {
    const { stub, caller } = await this.userHub();
    const outcomes = await stub.cancelDeviceRequestsForBackgroundJob(caller, jobId);
    const unconfirmed = outcomes.filter((outcome) => outcome.outcome === 'failed');

    if (unconfirmed.length === 0) return;
    throw new KinuError('unavailable', `background job ${jobId} still holds ${unconfirmed.length} `
      + `device command(s) nothing confirmed stopped: `
      + unconfirmed.map((o) => `${o.requestId} (${o.detail ?? 'no detail'})`).join('; '));
  }

  protected readonly boxUse: WorkspaceBoxUse = { used: false, drivers: new Set() };

  /**
   * Records which running job's command holds each exposed port, the workspace's or the box's, when that can move (a
   * port exposed, listened on or withdrawn, a job detached or settled), so a listing reads a row and never the box. Only
   * a box this activation used is asked, and one that is down is not read: the next exposure reads again.
   */
  protected async servingMoved(): Promise<void> {
    const holders = this._rt?.portHolders();

    if (holders !== undefined) await recordServingJobs(this.jobs, holders);
  }
  protected get config(): AgentConfigStore {
    return this.stores.config;
  }

  protected swarmDeps(rt: AgentsSwarmDeps['rt'], model: AgentsSwarmDeps['model'], originContext: NonNullable<AgentsSwarmDeps['originContext']>, compactShared: NonNullable<AgentsSwarmDeps['compactShared']>): AgentsSwarmDeps {
    const seams = this.hostedSeams();

    return {
      rt, model, originContext, compactShared,
      windowOf: (spec) => this.modelCatalog.windowFor(spec),
      reportModelCall: (report) => { this.reportModelCall(report); },
      nodeCodemode: (actor) => nodeCodemodeTool(seams, actor),
      webSearch: seams.webSearch(),
      resolveModel: (spec) => this.ownedModelServices.resolveModel(spec),
      hostNode: (node) => hostNodeSeat(seams, node),
      provisionNodeHome: () => async (node) => seams.nodeHome((await hostNodeSeat(seams, node)).actor),
      runtimeForNodeWorkspace: null,
      workers: this.liveWorkers,
      reportNodeDelta: () => (frame) => { this.publishHeadStreamFrame(frame); },
      announceHeadActivity: () => (headId) => { this.announceHeadActivity(headId); },
    };
  }

  /** Main's runs are its isolate's (D9): this object's emits file under the workspace aggregate. */
  protected get _currentRunId(): string {
    return '';
  }

  /** The operation the workspace agent's tools now run under: the call's, else its turn's. */
  protected operationProfile(): OperationProfile | null {
    return currentOperationProfile(this.actorHandle()) ?? this.mainTurn()?.operation ?? null;
  }

  /** The last profile a turn or a status read resolved. */
  private _settledProfile: ResolvedTurnProfile | null = null;

  /** The profile this actor runs on now: its operation's, else the one its next turn resolves. */
  protected async currentProfile(): Promise<ResolvedTurnProfile> {
    const live = this.operationProfile()?.profile;

    if (live !== undefined) return live;
    const { profile } = await this.actorProfile({ actor: this.actorHandle(), availableTools: [], workMode: 'build' });

    this._settledProfile = profile;

    return profile;
  }

  private runningProfile(): ResolvedTurnProfile | null {
    return this.operationProfile()?.profile ?? this.boundProfiles.get(this.actorHandle().actorId) ?? this._settledProfile;
  }
  /** Instruction trust (KINU-N028): one store over actor SQL, scoped to this workspace so a forked
   *  or copied root starts unapproved. */
  private _instructionApprovals: InstructionApprovalStore | null = null;
  private instructionApprovals(): InstructionApprovalStore {
    this._instructionApprovals ??= new InstructionApprovalStore(
      this.rt.storage.sql,
      this.actorHandle(),
      `cf:${this.workspaceName()}`,
    );

    return this._instructionApprovals;
  }

  private _instructionTrust: InstructionTrustResolver | null = null;
  protected instructionTrust(): InstructionTrustResolver {
    const store = this.instructionApprovals();
    this._instructionTrust ??= store.trustOf.bind(store);

    return this._instructionTrust;
  }

  /** The workspace's instruction files, read through its sandbox where it has one. */
  protected workspaceAgentsMd(window: ModelWindow, trust: InstructionTrustResolver): Promise<AgentsMdSources> {
    return collectWorkspaceAgentsMd(this.rt.storage.vfs, window, trust, this.rt.executionRouter?.getProvider('computer'));
  }

  private _instructionDesk: InstructionApprovalDesk | null = null;
  private instructionDesk(): InstructionApprovalDesk {
    this._instructionDesk ??= new InstructionApprovalDesk({
      agentsMd: (window, trust) => this.workspaceAgentsMd(window, trust),
      skillsVfs: this.rt.storage.vfs,
      approvals: this.instructionApprovals(),
      window: () => this.modelCatalog.window(),
    });

    return this._instructionDesk;
  }

  /** Derived on read, never stored, so the agent cannot fill the queue by writing files. */
  @callable()
  async listInstructionApprovals(request: PageRequest = {}): Promise<Page<InstructionSourceRow>> {
    return this.instructionDesk().list(request);
  }

  @callable()
  async readInstructionApproval(path: string): Promise<InstructionSourceView | null> {
    return this.instructionDesk().read(path);
  }

  /** Grants these bytes at this path system placement; the digest is re-checked against the file. */
  @callable()
  async approveInstruction(path: string, reviewedDigest: string): Promise<AdmittedInstructionDecision> {
    return this.instructionDesk().approve(path, reviewedDigest);
  }

  /** The refusal is kept, so nothing can re-grant it without the owner deciding again. */
  @callable()
  async revokeInstruction(path: string): Promise<AdmittedInstructionDecision> {
    return this.instructionDesk().revoke(path);
  }

  private _turnT0 = 0;

  /** A turn is running, read live from the loop; routes signals into the turn, keeps tool claims,
   * and reports the actor busy (forkAgent rejects with "agent busy"). */
  protected get _inFlight(): boolean { return this.mainChatTurn() !== null; }
  /** Core's derivation of the gate (`AgentOrchestrator.beginTurn`), for a turn opening on `mode`. */
  protected turnRecordsEvolution(mode: WorkMode): boolean {
    return this.engine.recordsTurns && mode !== 'plan';
  }

  protected readonly extensions = new ExtensionHost();

  protected _cliCwd: string | null = null;

  getCliCwdForDevice(): string | null {
    return this._cliCwd;
  }

  getCheckpointMetaForDevice(): { turnId: string; sessionId: string } | null {
    // The live turn: the id a Stop sweep names and the daemon's checkpoint key.
    const turnId = this.mainChatTurn();

    return turnId === null ? null : { turnId, sessionId: 'default' };
  }

  // `this.sql` needs `this` bound; this closure can be passed by reference to helpers safely.
  private _boundSql: SqlExecutor | null = null;
  protected get boundSql(): SqlExecutor {
    this._boundSql ??= bindAgentSql(this, this.held);

    return this._boundSql;
  }


  /** Persisted once per activation; tracing and swarm-progress frames share it so neither advances the other. */
  private _isolateGeneration: number | null = null;
  protected get isolateGeneration(): number {
    return (this._isolateGeneration ??= this.config.countIsolateGeneration());
  }
  private _tracing: AgentTracing | null = null;
  /**
   * Lazy so `isolateGen` bumps once per construction, incl. `ctx.facets.abort()`; not in `onStart`,
   * which blocks all requests and resets after 30s (`do.block_concurrency.cancel_ms`).
   * Keyed by `selfPath`, not `ctx.id`: facets report the root's id (`do.facet.id_is_root_namespace`).
   */
  protected get tracing(): AgentTracing {
    this._tracing ??= createAgentTracing({
      tracer: createWorkersTracer(),
      isolateGen: this.isolateGeneration,
      selfPath: this.selfPath,
      actor: { id: this.actorHandle().actorId, kind: 'main' },
    });

    return this._tracing;
  }

  protected logActivity(event: string, detail?: string) {
    const elapsed = this._turnT0 > 0 ? Math.round(performance.now() - this._turnT0) : 0;

    writeActivityLog(() => ({ sql: this.boundSql, actor: this.actorHandle() }), {
      event, detail: detail ?? null, elapsedMs: elapsed, createdAt: Date.now(),
    });
  }

  /** The workspace's choice of each provider's account, over the catalog's (`providerAccounts`); this is the main actor. */
  private providerAccounts(): ProviderAccounts {
    return providerAccounts({
      actor: this.config.getProviderAccounts(), workspace: this.config.getProviderAccounts(),
      catalog: currentOperationProfile(this.actorHandle())?.inputs?.envelope.catalog.accounts,
    });
  }

  protected get rt(): CFRuntime {
    if (!this._rt) {
      const hooks: CFRuntimeHooks = {
        deferrals: () => this.deferralChannel(),
        slate: (operation, turn) => this.programSlate(operation, turn),
        reportModelCall: (report) => this.reportModelCall(report),
        modelOperations: this.modelOperations,
        liveReadsMoved: (reads) => { this.liveReadsMoved(reads); },
        servingMoved: () => this.servingMoved(),
        boxUse: this.boxUse,
        resolveProfile: () => this.routingProfile(),
        currentTurn: (reference) => this.currentTurnOf(reference),
        accounts: () => this.providerAccounts(),
        refusals: this.tierRefusals,
        jobs: () => this.jobRunner,
        processEnds: () => this.processEnds,
        contextPlane: {
          actorId: this.actorHandle().actorId,
          // Main's context is its own isolate's, as every agent's is.
          own: () => this.agentStores(this.actorHandle().actorId).contextTree({ author: this.actorHandle().actorId, child: false }),
          children: childContextResolver({
            directory: this.actorDirectoryStore(),
            parent: this.actorHandle(),
            tree: (child, author) => this.agentStores(child.actorId).contextTree({ author, child: true }),
          }),
        },
      };

      // No `workspaceExecution`: the main actor runs as the session user. Hosted actors get the home
      // assigned (not spread) by the host, because the factory reads the key's presence.
      // No onToolRegistered hook: the eval sandbox reads craftStore.list() fresh each call
      // (see docs/CRAFT-ARCHITECTURE.md §3).
      const runtime = createCFRuntime(this, {
        env: this.env,
        ctx: this.ctx,
        holdLane: (body) => this.holdLane(body),
        workspaceBox: (shellId) => this.workspaceBox(shellId),
        workspaceServing: () => this.workspaceServing(),
        getCliCwdForDevice: () => this.getCliCwdForDevice(),
        getCheckpointMetaForDevice: () => this.getCheckpointMetaForDevice(),
        turnSurface: () => this.turnSurface(),
        commandEnvironment: (use, caller) => this.account.commandEnvironment(use, caller),
      }, {
        actor: this.actorHandle(),
        rootActor: true,
        ownerUserId: () => this.getOwnerUserId(),
        workspaceName: this.workspaceName(),
        shellId: this.shellId(),
        scaffoldPath: this.scaffoldPath(),
        capabilityToken: () => this.workspaceCapabilityToken(),
      }, hooks);

      this.configureRuntime(runtime);
      this._rt = runtime;
    }

    return this._rt;
  }

  /** Synchronous post-construction hook. The runtime is not cached until this returns, so use the
   * argument and do not re-enter `this.rt`. */
  protected configureRuntime(_runtime: CFRuntime): void {}

  /**
   * Deferral target for gated commands with no approver; subagents have no queue, the
   * orchestrator overrides. Resolved at exec time, never during runtime construction (reaching the
   * queue re-enters `rt`).
   */
  protected deferralChannel(): DeferredApprovalChannel | undefined { return undefined; }

  /**
   * The actor a slate acts for; never client-reachable. Hosted actors' callers are minted by the
   * host from the directory row, never from a facet chain's class names.
   */
  protected slateCaller(): SlateCaller {
    return { path: [], cred: CRED_SESSION_USER, workMode: currentWorkMode() };
  }

  /** Every actor's slate operations run on the object that owns its workspace, as this actor. */
  async slate(operation: SlateOperation): Promise<SlateCallResult> {
    return await this.programSlate(operation);
  }

  /** A slate operation from this actor's own program, which `turn` runs (`SlateInvocation.turn`); never a browser's. */
  protected async programSlate(operation: SlateOperation, turn?: string): Promise<SlateCallResult> {
    return await workspaceOwner(this.env, this.workspaceName()).slateAs(this.slateCaller(), operation, turn);
  }

  /** Whether a slate still builds, asked as this actor; a check, never a preview. */
  async slateBuild(slate: string): Promise<SlateCallResult> {
    return workspaceOwner(this.env, this.workspaceName()).slateBuildAs(this.slateCaller(), slate);
  }

  /**
   * Descend one caller hop; the target answers with its own surface narrowed by its own current
   * role, so a slate never reaches more than the actor it calls as.
   */
  private dispatchHostedSlateCall(
    hops: readonly [SlateCallerHop, ...SlateCallerHop[]], route: SlateRoute, mode: WorkMode, context: SlateDispatchContext,
  ): Effect.Effect<SlateSurfaceValue, KinuError> {
    const [{ name }, ...rest] = hops;

    return Effect.gen({ self: this }, function* () {
      if (rest.length > 0) {
        return yield* new KinuError('denied', 'A caller path names one hosted actor; a nested path names an actor no directory holds.');
      }

      return yield* Effect.promise(async () => this.withHostedActor(this.hostedSlateCaller(name), async (actor) => {
        if (route.kind === 'ai') {
          // A hosted actor runs the model call through its own profile, resolved now.
          return await this.slateAiRun(route, actor.handle, context.admit);
        }

        if (route.kind === 'agent') {
          throw new KinuError('denied', 'a hosted actor has no inbox of its own; agent.send answers on the workspace actor');
        }

        if (route.kind !== 'namespace' && route.kind !== 'tool') {
          // Hosted actors hold no MCP servers or slate read model; those belong to the main actor.
          throw new KinuError('denied', `a hosted actor has no ${route.kind} surface; that route belongs to the workspace actor`);
        }

        // A slate's call reaches no `agent.*`.
        const surface = this.hostedActorSurface(actor, { account: false, ownerWaits: null });

        const reached = actorNamespaces(surface.actor, SURFACE_POLICY.slate);
        const providers = context.viewer === true ? providersWithoutOwnerSecrets(reached) : reached;
        // Narrow by the child's own durable, per-actor role, in the mode that role leaves the caller.
        const authority = await this.hostedSlateAuthority(actor, mode, providers, Object.keys(surface.native));
        const reach = slateToolReach(authority.reach);

        if (route.kind === 'tool') {
          // The caller's word read again where the tool is sent, as the root's tools are.
          context.admit?.();

          return this.callSlateTool({ rt: actor.runtime, actor: surface.actor, reach, route, mode: authority.mode, context });
        }

        return await slateMember(reach.narrowProviders(providersInWorkMode(authority.mode, providers)), route, context);
      }));
    });
  }

  /** The actor a slate's caller path names: this one, or the hosted actor its one hop names; a nested path names none. */
  protected slateCallerActorId(path: readonly SlateCallerHop[]): string | null {
    const [next, ...rest] = path;

    if (next === undefined) return this.actorHandle().actorId;

    return rest.length > 0 ? null : this.hostedSlateCaller(next.name).actorId;
  }

  /** The hosted actor a caller path's one hop names, from this actor's directory. */
  private hostedSlateCaller(name: string) {
    return this.actorDirectoryStore().apply(actorReferenceOf(this.actorHandle()), [], { action: 'resolve', name }).reference;
  }

  /**
   * One capability route, run as this actor, narrowed by its own current role.
   * Not `@callable`: reached on the stub transport only.
   */
  slateCallDispatch(path: readonly SlateCallerHop[], route: SlateRoute, mode: WorkMode, context: SlateDispatchContext): Promise<SlateSurfaceValue> {
    // A shared slate's call, its viewer's or its owner's own, and everything it starts runs for no owner.
    if (context.viewer === true) return withholdingOwnerSecrets(() => settle(this.dispatchSlateCall(path, route, mode, context)));

    return settle(this.dispatchSlateCall(path, route, mode, context));
  }

  private dispatchSlateCall(path: readonly SlateCallerHop[], route: SlateRoute, mode: WorkMode, context: SlateDispatchContext): Effect.Effect<SlateSurfaceValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      // Only a namespace member is checked without running it; anything else asked about alone would run.
      if (context.authorizeOnly && route.kind !== 'namespace') {
        return yield* new KinuError('bad_input', `A ${route.kind} route runs at the host; it is not authorized to run elsewhere`);
      }

      // Hops resolve hosted actors through the directory, inside this object, so an unreachable
      // name is refused here rather than as a rejected RPC deeper down.
      const [next, ...rest] = path;

      if (next !== undefined) {
        return yield* this.dispatchHostedSlateCall([next, ...rest], route, mode, context);
      }

      switch (route.kind) {
        case 'namespace': {
          // The root's own path: a share's viewer comes here too, and never holds `agents`.
          const owner = context.viewer !== true;
          const authority = yield* Effect.promise(async () => this.slateAuthority(mode, this.slateNamespaces(mode, owner)));
          const providers = providersInWorkMode(authority.mode, this.slateNamespaces(mode, owner));

          // The owner's own slate hires under the owner's role as of now, as a program in a turn does.
          return yield* Effect.promise(async () => runOperationProfile(owner ? authority.operation ?? null : null, async () => slateMember(
            slateToolReach(authority.reach, owner).narrowProviders(providers), route, context,
          )));
        }

        case 'tool': {
          const authority = yield* Effect.promise(async () => this.slateAuthority(mode, this.slateNamespaces(mode)));

          // A viewer's call is admitted as the tool starts; each member its program reaches meets `nested` as it runs.
          context.admit?.();

          return yield* Effect.promise(async () => this.callSlateTool({
            rt: this.rt, actor: this.surfaceActor(mode, context.viewer ? 'viewer' : 'owner'), reach: slateToolReach(authority.reach), route, mode: authority.mode, context,
          }));
        }

        case 'mcp': {
          // The role admits MCP tools by descriptor key, same as `toolAllowed(d.toolKey)` in native turns.
          const { stub, caller } = yield* Effect.promise(async () => this.userHub());
          const surface = async (): Promise<McpToolSurface> => v.parse(McpToolSurfaceSchema, await stub.userMcp_toolDescriptors(caller));
          let offered = yield* Effect.promise(surface);

          // A slate call is not a turn opening: a server the user object is still dialling is waited for, once.
          if (offered.unavailable.some((row) => row.server === route.server)) {
            yield* Effect.promise(async () => stub.userMcp_warmConnections(caller));
            offered = yield* Effect.promise(surface);
          }

          // A server is named as the actor's programs name it, so a fork reaches its forker's server of that name.
          const descriptor = offered.descriptors.find((d) => d.serverName === route.server && d.name === route.tool);

          if (descriptor === undefined) return yield* new KinuError('missing', `${route.server} offers no tool ${route.tool} to this actor`);
          // Enforce `readOnly` grants here so a read grant cannot write through a non-read-only tool.

          if (route.readOnly === true && descriptor.readOnly !== true) {
            return yield* new KinuError('denied', `${descriptor.toolKey} is read-granted to viewers but ${route.server} does not mark it read-only`);
          }

          const authority = yield* Effect.promise(async () => this.slateAuthority(mode, this.slateNamespaces(mode), [descriptor.toolKey]));

          requireWorkModePermission(authority.mode, descriptor.readOnly === true, descriptor.toolKey);

          if (!authority.reach.allowsTool(descriptor.toolKey)) return yield* new KinuError('denied', `${descriptor.toolKey} is not within this actor's reach right now`);

          // A viewer's call is admitted here, after every wait to prepare it and with none between it and the send.
          context.admit?.();
          const answered = yield* Effect.promise(async () => callUserMcpTool({ stub, caller }, descriptor, route.args, undefined));

          // A slate calls on its viewer's behalf, not any agent's.
          this.noteGitHubCall(descriptor, route.args, answered, null);

          return v.parse(JsonValueSchema, JSON.parse(answered));
        }

        case 'agent': return yield* this.slateAgentCall(route, context);

        case 'ai': return yield* Effect.promise(async () => this.slateAiRun(route, undefined, context.admit));

        case 'rpc': {
          context.admit?.();

          return yield* Effect.promise(async () => this.slateReadModel(route.method));
        }

        case 'app': return yield* new KinuError('bad_input', 'An app hop is answered by the slate host, not by an actor');
      }
    });
  }

  /** A slate's `agent.send` or `agent.ask`, delivered to this agent's turn inbox. */
  private slateAgentCall(route: Extract<SlateRoute, { kind: 'agent' }>, context: SlateDispatchContext): Effect.Effect<SlateSurfaceValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      // `said` is the slate's own message, for the person's card; the text adds what the agent is told.
      const metadata: JsonObject = { slate: route.slate, said: cardWords(route.text), ask: route.ask === true };

      if (route.data !== undefined) metadata.data = route.data;

      if (route.viewer !== undefined) metadata.viewer = route.viewer;

      const said = route.viewer === undefined ? `Slate ${route.slate}: ${route.text}` : `Slate ${route.slate} (viewer ${route.viewer}): ${route.text}`;

      // A program this agent's running turn waits on began the chain: the reply could come only once that turn ends,
      // and the turn waits on the program, so the ask is refused now rather than held until the turn gives up on it.
      if (route.ask === true && context.turn !== undefined && context.turn === this.mainChatTurn()) {
        return yield* new KinuError('unsupported', `agent.ask came from a program the agent is running in its turn, which waits on that program: the agent can answer only once the program returns, so the ask would wait on itself. A slate the agent's own program calls answers without asking it (ai.run), and a page asks it outside its turns.`);
      }

      context.admit?.();

      if (route.ask !== true) {
        const delivered: SlateSurfaceValue = { outcome: yield* Effect.promise(async () => this.slateInbox().send({ kind: 'slate', text: said, metadata })) };

        return delivered;
      }

      // Asked: the reply is open before the message is sent, so the turn it lands in feeds it from its first word. A
      // send that opens a turn settles only when that turn ends, so the reply is answered now and only the wait is
      // detached; a message that never lands says so on its card, which ends the reply.
      const key = `ask:${crypto.randomUUID()}`;
      const reply = this.replies.open(signalCardId(key));

      const sent = this.slateInbox().send({
        kind: 'slate', idempotencyKey: key, metadata,
        text: `${said}\nYour answer's text streams to slate ${route.slate} as you write it: answer it in prose.`,
      });

      this.detachOwned(Effect.promise(async () => { await this.keepAliveWhile(async () => sent); }));

      return { reply };
    });
  }

  /** The one adapter between a slate's `agent.send` and the turn inbox. */
  private slateInbox(): AgentInbox {
    return this.workspaceAgentDeliveries().signals;
  }

  /**
   * One `ai.run` call from a slate: resolve the profile as this actor's turn would, run one model call
   * under a `slate` spend row. `actor` is the hosted actor hopped to, or absent for this actor.
   */
  private async slateAiRun(
    route: Extract<SlateRoute, { kind: 'ai' }>,
    actor?: ActorHandle,
    admit?: () => void,
  ): Promise<SlateSurfaceValue> {
    let profile: ResolvedTurnProfile;

    try {
      profile = (await this.actorProfile({
        actor: actor ?? this.actorHandle(), workMode: 'build', availableTools: [], explicitTier: route.tier,
      })).profile;
    } catch (cause) {
      // The resolver reports bad tiers as plain Errors; surface them as bad input.
      if (cause instanceof Error && /invalid explicit tier|unknown tier/.test(cause.message)) {
        throw new KinuError('bad_input', cause.message, { cause });
      }

      throw cause;
    }

    // Priced as every call is: its model's rate, warmed when it is not the turn's own.
    await this.modelCatalog.warm([profile.tier.model]);
    // A viewer's call is admitted once the model is ready, as it is asked.
    admit?.();

    return slateAiAnswer(route, { spec: profile.tier.model, tier: profile.tier.id }, {
      resolveModel: (spec) => this.ownedModelServices.resolveModel(spec), report: (report) => { this.reportModelCall(report); }, operations: this.modelOperations,
    });
  }

  /**
   * `actor` is whose browser sessions the program's egress reaches; null reaches only a new Kitesurf browser. `as` is
   * whose authority the program runs with: a share's viewer's program opens none of the owner's previews.
   */
  protected codemodeLaunch(actor: string | null, as: 'owner' | 'viewer'): (online: boolean) => ProgramLaunch {
    const workspace = this.workspaceName();
    // A viewer's program holds none of the owner's secrets, and its egress spends none.
    const owner = as === 'owner';

    return (online) => codemodeLauncher(
      {
        kinuNode: true,
        egress: online ? { principal: owner ? { as: 'owner', workspace, actorId: actor, ownerUserId: this.getOwnerUserId() } : { as: 'viewer', workspace, actorId: actor } } : null,
      },
      () => this.account.commandEnvironment('run', owner ? 'owner' : 'viewer'),
    );
  }

  /**
   * A crafted tool: a native tool is its own namespace on a slate's surface, never a member of `tools`. Every member
   * its program reaches passes `context.nested` first, and a viewer's program holds no browser session of this actor's.
   */
  private async callSlateTool(input: {
    rt: SeatedActor["runtime"]; actor: SurfaceActor;
    reach: ToolSurfaceNarrowing; route: Extract<SlateRoute, { kind: 'tool' }>; mode: WorkMode; context: SlateDispatchContext;
  }): Promise<JsonValue> {
    const { rt, actor, reach, route, mode, context } = input;
    const launch = context.viewer ? null : rt.actor.actorId;
    const policy = context.viewer ? SURFACE_POLICY.slateToolForViewer : SURFACE_POLICY.slateTool;
    let factory = this._slateToolFactories.get(launch);

    if (factory === undefined) {
      factory = createCodemodeToolFactory({ launch: this.codemodeLaunch(launch, context.viewer ? 'viewer' : 'owner'), workspace: this.workspaceName() });
      this._slateToolFactories.set(launch, factory);
    }

    // A program calls back into these from its own isolate: a viewer's runs with none of the owner's secrets there too.
    const scope: CodemodeScope = {
      reach, nested: context.nested,
      namespaces: (executor) => (context.viewer === true ? providersWithoutOwnerSecrets(actorNamespaces(actor, policy, { executor })) : actorNamespaces(actor, policy, { executor })),
    };

    return await inWorkMode(mode, () => factory.callTool(codemodeSurface(rt, {}, () => ({}), { stores: actor.stores }), route.name, route.input, scope)) ?? null;
  }

  /** Workspace read models belong to the root; the orchestrator supplies them. */
  protected async slateReadModel(source: SlateReadModel): Promise<JsonValue> {
    throw new KinuError('denied', `${source} is a workspace read model this actor does not hold`);
  }

  /**
   * A slate call's authority. Its mode is the caller's as the actor's role leaves it, resolved now from `requested`:
   * a role that imposes Plan (a planner) holds every call to Plan, while a Build app keeps its own mode through another
   * turn's Plan. Its reach is the in-flight turn's profile while one runs (not the cached one, which outlives its turn),
   * else that same resolution over native, codemode and the given MCP tools.
   */
  private async slateAuthority(
    requested: WorkMode, providers: readonly CodemodeProvider[], mcpToolKeys: readonly string[] = [],
  ): Promise<SlateAuthority> {
    const { profile, inputs } = await this.actorProfile({
      actor: this.actorHandle(),
      workMode: requested,
      // It answers no hirer, so it reports to none.
      availableTools: [...BUILTIN_TOOLS.filter((name) => name !== REPORT_TOOL), ...mcpToolKeys, ...codemodeCapabilitiesFor(providers)],
    });

    const operation = this.operationProfile() ?? captureOperationProfile({ actor: this.actorHandle(), profile, inputs, runId: WORKSPACE_RUN_ID, turnId: null });

    return { mode: profile.workMode, reach: narrowToolSurface(operation.profile.allowedTools), operation };
  }

  /**
   * Hosted actor's authority: not `slateAuthority`, which reads the root's turn and surface.
   * Resolves the role now over the child's own surface, so a role change is seen on the next call.
   */
  private async hostedSlateAuthority(
    actor: SeatedActor, requested: WorkMode, providers: readonly CodemodeProvider[], native: readonly string[],
  ): Promise<SlateAuthority> {
    const { profile } = await this.actorProfile({
      actor: actor.handle,
      availableTools: [...native, ...codemodeCapabilitiesFor(providers)],
      workMode: requested,
    });

    return { mode: profile.workMode, reach: narrowToolSurface(profile.allowedTools) };
  }

  /**
   * The operations an actor reaches now, for a caller outside eval (a slate, an isolate running its turn): its
   * namespaces and its tools, MCP and extension tools included on this actor, narrowed by its role in the mode that
   * role leaves `requested`. `use` runs in that mode, while a hosted actor is held.
   */
  protected async withReachedOperations<A>(
    actor: ActorReference, requested: WorkMode, use: (providers: readonly CodemodeProvider[]) => Promise<A>,
  ): Promise<A> {
    const record = this.actorHost().describe(actor.actorId);
    const scope = record === null ? null : actorReach(actorPolicy(record));

    // A hire reaches its own confined surface; an agent whose programs reach the workspace's program surface, that one.
    if (scope === null || scope.kind === 'confined') {
      return await this.withHostedActor(actor, async (hosted) => {
        // An operation call is the agent's own, so it reaches the account as the agent's programs do; a slate's never does.
        const surface = this.hostedActorSurface(hosted, {
          account: true,
          // Its own turn's programs and an outside caller reach what waits on its owner from its work, as it does in eval.
          ownerWaits: this.hireOwnerWaits(hosted),
          mail: this.mailFor(hosted.handle.actorId, hosted.record.name),
        });

        const providers = actorNamespaces(surface.actor, SURFACE_POLICY.operations);
        const authority = await this.hostedSlateAuthority(hosted, requested, providers, Object.keys(surface.native));

        return await reachedIn(authority, providers, surface.native, use);
      });
    }

    // One set for the call: its namespaces and its tools, in whichever mode its role leaves, run the same store
    // operations on one ledger and one budget.
    const ledgers = this.ownLedgers();
    const own = this.ownTools(requested, null, { ledgers });
    const providers = actorNamespaces(this.surfaceActor(requested, 'owner', own.stores), SURFACE_POLICY.operations);

    // The workspace's own agent, which reaches its external tools.
    const mcp = await this.buildUserMcpTools(own.raw, Promise.resolve(this.modelCatalog));
    const authority = await this.slateAuthority(requested, providers, Object.keys(mcp));
    const external = { ...this.extensions.tools(), ...mcp };
    const tools = authority.mode === requested ? own.raw : this.ownTools(authority.mode, null, { ledgers, stores: own.stores }).raw;

    return await reachedIn(authority, providers, { ...external, ...tools }, use);
  }

  /** Cold ordinary actors retain their existing opener; active run seats are used, never re-composed. */
  private async withHostedActor<Result>(reference: ActorReference, work: (actor: SeatedActor) => Promise<Result>): Promise<Result> {
    const host = this.actorHost();

    if (host.hosted(reference) === null) await host.acquire(reference, { kind: 'actor' });

    return await host.runHosted(reference, work);
  }

  /** The namespaces this actor's own programs reach in `mode`: what a role names and narrows. */
  protected ownNamespaces(mode: WorkMode): CodemodeProvider[] {
    return actorNamespaces(this.surfaceActor(mode), SURFACE_POLICY.program);
  }

  /** The Chrome sessions `actorId` opened; the table lives on the workspace object every actor shares. */
  protected browserSessionsFor(actorId: string): BrowserSessions {
    return browserSessions({ db: this.ctx.storage.sql, binding: this.env.BROWSER, actorId });
  }

  /**
   * The eval namespaces a slate's surface reaches, as this actor's programs reach them, less `tools` and `state`, and
   * less `agents` unless `owner`: the owner's own slate, as the owner, with no share in it. The host refuses what else
   * only the agent does. Read per call: executors attach and detach while this object lives.
   */
  /** A caller other than the owner (a share's viewer, a shared slate's server) runs commands with none of the owner's secrets. */
  protected slateNamespaces(mode: WorkMode, owner = false): CodemodeProvider[] {
    const providers = actorNamespaces(this.surfaceActor(mode, owner ? 'owner' : 'viewer'), owner ? SURFACE_POLICY.ownerSlate : SURFACE_POLICY.slate);

    return owner ? providers : providersWithoutOwnerSecrets(providers);
  }

  /**
   * This actor as every caller's namespaces are built over it (`actorNamespaces`); it delegates in `mode`. A share's
   * viewer's calls reach the web without the pass the owner's carry to the workspace's own previews.
   */
  /**
   * This actor as a caller's namespaces are built over it. `stores`: the store operations a caller's native tools run,
   * which its programs run too; a caller holding none (a slate) has them served here, over the same inputs.
   */
  protected surfaceActor(mode: WorkMode, as: 'owner' | 'viewer' = 'owner', stores?: ServedStores): SurfaceActor {
    return {
      executors: () => this.rt.executionRouter?.getProviders() ?? [],
      web: {
        search: as === 'owner' ? this.ownedModelServices.getWebSearchProvider() : this.ownedModelServices.getViewerWebSearchProvider(), files: this.rt.storage,
        browser: { sessions: this.browserSessionsFor(this.rt.actor.actorId), prelude: BROWSER_PRELUDE },
      },
      stores: stores ?? serveStores(builtinStoreDeps(this.ownStoreInputs(this.ownLedgers()))),
      // Plan is decided per table scope at invocation.
      db: this.stores.appData,
      agents: () => this.ownAgentsToolDeps(mode),
      self: this.agentSelf(),
      // The workspace's agent reads what waits on its owner through its own `agent.*`.
      ownerWaits: null,
      mail: this.mailFor(this.rt.actor.actorId, 'main'),
    };
  }

  /** `mail.*` for one of this workspace's agents over its owner's Mailbox (docs/MAIL.md §3); null where there is no mail. */
  protected mailFor(_actorId: string, _name: string): MailDeps | null {
    return null;
  }

  /** The workspace agent's eval programs: crafted tools saved mid-turn still work because craftStore is re-read per call. */
  protected workspaceCodemode(): CodemodeFactory {
    this._codemodeFactory ??= createCodemodeToolFactory({
      launch: this.codemodeLaunch(this.rt.actor.actorId, 'owner'),
      workspace: this.workspaceName(),
      // Drives the UI's default executor; one upsert per executor per turn (reset as its turn opens).
      onExecutorUsed: (name) => {
        if (this._executorsUsedThisTurn.has(name)) return;
        this._executorsUsedThisTurn.add(name);
        this.config.setLastActiveExecutor(name);
      },
    });

    return this._codemodeFactory;
  }

  /** One object so a cost can never be filed for an operation that was never opened. */
  private scaffoldSpend(): ModelCallSpend {
    return {
      source: 'scaffold',
      report: (report) => this.reportModelCall(report),
      operations: this.modelOperations,
    };
  }

  protected providerRegistry(): AgentProviderRegistry {
    return this.ownedModelServices.providerRegistry();
  }

  protected getOwnerUserDO(): UserHubClient | null {
    const userId = this.getOwnerUserId();

    if (!userId) return null;
    const stub: UserHubClient = objectNamed(this.env.UserDO, userId);

    return stub;
  }

  /** The owner's user id; a workspace no one has claimed is refused (`unownedWorkspace`). */
  protected requireOwner(): string {
    const userId = this.getOwnerUserId();

    if (!userId) throw unownedWorkspace();

    return userId;
  }

  /** `requireOwner` as an effect, for the paths that refuse in one. */
  protected owner(): Effect.Effect<string, KinuError> {
    return Effect.suspend(() => {
      const userId = this.getOwnerUserId();

      return userId ? Effect.succeed(userId) : Effect.fail(unownedWorkspace());
    });
  }

  protected requireOwnerUserDO(): UserHubClient {
    return objectNamed(this.env.UserDO, this.requireOwner());
  }

  /** Throws when no capability token exists; an unclaimed workspace reaches nothing. */
  protected async userCaller(): Promise<UserCaller> {
    const workspaceToken = this.workspaceCapabilityToken();

    if (!workspaceToken) {
      throw new KinuError('unavailable', 'This workspace has not been issued a capability token yet. Open it through the authenticated app or CLI first.');
    }

    return { workspaceToken };
  }

  protected async userHub(): Promise<{ stub: UserHubClient; caller: UserCaller }> {
    return { stub: this.requireOwnerUserDO(), caller: await this.userCaller() };
  }

  /** What the owner's account says that a turn reads, asked of its user object as this workspace. */
  protected readonly account = new AccountReads({
    hub: () => this.userHub(), owned: () => this.getOwnerUserId() !== null, workspace: () => this.name,
  });

  /** `record` lets core emit the `profile_resolution` run event; this backend only picks where it goes. */
  protected async profileInputs(): Promise<ProfileAuthorityInputs> {
    return loadProfileAuthorityInputs({
      envelope: () => this.profileCatalog(),
      provider: () => this.ownedModelServices.profileProviderSnapshot(),
      record: (event) => this.eventRecorder.emit(this._currentRunId || WORKSPACE_RUN_ID, event),
    });
  }

  protected profileCatalog(): Promise<ProfileCatalogEnvelope> {
    return this.account.catalog();
  }

  /** A fork reaches these through its `parent` executor. No `@callable`: only a worker-held
   * parent stub can reach them. */
  async readWorkspaceFile(path: string): Promise<Uint8Array> {
    return answerParentRpc(path, async () => this.rt.localVfs.readFile(path));
  }

  async writeWorkspaceFile(input: ParentRpcWrite): Promise<null> {
    return answerParentRpc(input.path, async () => {
      if (input.kind === 'file') await this.rt.localVfs.writeFile(input.path, input.data);
      else await this.rt.localVfs.mkdir(input.path, { recursive: input.recursive });

      return null;
    });
  }

  async listWorkspaceFiles(path: string): Promise<VfsDirent[]> {
    return answerParentRpc(path, async () => this.rt.localVfs.readdir(path));
  }

  async statWorkspaceFile(path: string, options?: { follow?: boolean }): Promise<VfsStat | null> {
    return answerParentRpc(path, async () => this.rt.localVfs.stat(path, options));
  }

  async deleteWorkspaceFile(path: string): Promise<null> {
    return answerParentRpc(path, async () => {
      await this.rt.localVfs.unlink(path);

      return null;
    });
  }

  /** Run a command in this workspace's shell for a fork: one round trip instead of one RPC per
   * file through an emulated shell. */
  execWorkspaceCommand(command: string): Promise<ParentExecResult> {
    return answerParentRpc('', () => {
      const shell = this.rt.shell;

      if (!shell) return settle(Effect.fail(new KinuError('unsupported', 'this workspace has no shell')));

      return shell.exec(command);
    });
  }

  /** Null when unset (registry picks the default). */
  protected getStoredModelId(): string | null {
    return this.config.getModel();
  }

  /** Native owner inspection. Does not initialize the SDK or application tables. */
  async inspectSubagentStorage(request: SubagentInspectionRequest, authority: SubagentInspectionAuthority): Promise<SubagentInspectionResult> {
    // Core authorizes the directory path before resolving its canonical
    // transcript. Payload reads may await VFS; they never acquire an actor.
    return inspectSubagentStorage({
      sql: this.boundSql, raw: this.ctx.storage.sql,
      actor: this.actorHandle(), directory: this.actorDirectoryStore(),
      transcriptFor: (actor) => this.transcriptFor(actor),
      ownRows: (actor, own) => this.agentCall(actor.actorId, (isolate, snapshot) => isolate.inspect(snapshot, own)),
    }, request, authority);
  }

  /** Every read or write of an agent's own stores goes here (D9): a call into its isolate, bound to its snapshot. */
  protected abstract agentCall<A>(actorId: string, call: (isolate: AgentFacetCalls, snapshot: AgentSnapshot) => Promise<A>): Promise<A>;

  /** An agent's own stores as core's ports read them. */
  protected agentStores(actorId: string): AgentStoreBroker {
    return new AgentStoreBroker((call) => this.agentCall(actorId, call));
  }

  /** Main's conversations are its own isolate's. */
  protected ownConversations(): ConversationRecall {
    return this.agentStores(this.actorHandle().actorId).conversations();
  }

  /**
   * One page of one chat: the caller's own by default, or the subagent a pane names by actor id.
   * The root's pane names none and reads this actor's conversation.
   */
  @callable()
  getChatHistoryPage(request: PositionPageRequest & { actor?: string } = {}): Promise<ChatHistoryPage> {
    return settle(Effect.gen({ self: this }, function* () {
      // Strict: a dropped id cursor from an old client re-reads the newest page forever.
      const { actor, ...page } = v.parse(v.strictObject({ ...PositionPageRequestSchema.entries, actor: v.optional(v.string()) }), request);

      if (actor !== undefined) yield* this.requireSubagentChat(actor);

      return yield* Effect.promise(async () => this.agentCall(actor ?? this.actorHandle().actorId, (isolate, snapshot) => isolate.historyPage(snapshot, page)));
    }));
  }

  /**
   * A tab shows a settled answer whose phases have no line: they are named in its agent's own isolate, on its fast tier.
   * The caller's own chat by default, or the subagent a pane names; never part of a turn. False while no committed
   * answer has the id, so the tab asks again once it has one.
   */
  @callable()
  namePhases(request: { messageId: string; actor?: string }): Promise<boolean> {
    return settle(Effect.gen({ self: this }, function* () {
      const { messageId, actor } = v.parse(v.strictObject({ messageId: v.string(), actor: v.optional(v.string()) }), request);

      if (actor !== undefined) yield* this.requireSubagentChat(actor);

      return yield* Effect.promise(async () => this.agentCall(actor ?? this.actorHandle().actorId, (isolate, snapshot) => isolate.namePhases(snapshot, messageId)));
    }));
  }

  private requireSubagentChat(actorId: string): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const directory = this.actorDirectoryStore();
      const record = directory.retained(actorId);

      if (record === null) return yield* new KinuError('missing', 'The actor is not registered in this workspace.');

      // Every agent up its hierarchy is a hire, to the tree's root, which hosts every chat below it.
      for (let step: typeof record | null = record; step?.parentActorId !== null; step = directory.retained(step.parentActorId)) {
        if (step === null || !isSubagentOrigin(step.origin)) return yield* new KinuError('denied', 'The actor id does not name a chat this workspace hosts.');
      }
    });
  }

  /** Used to preselect a menu entry; the model list comes from /api/user/models (user-scoped). */
  @callable()
  async getStoredModelSpec(): Promise<{ spec: string | null }> {
    return getStoredModelSpec(this.config);
  }

  /** Takes effect on the next resolved turn: `beforeTurn` re-reads
   * `config.getRoleSelection()` (core profiles/role-change.ts:1-5). */
  @callable() async setRole(roleId: string): Promise<{ role: string }> {
    const { envelope } = await this.profileInputs();
    const changed = changeRoleAsOwner({ config: this.config, envelope, to: roleId, active: this.activeRoleLabel() });

    // Main's isolate measures its next request on the new role, as every agent's does.
    await this.modelSettingsChanged();

    return changed;
  }
  /** How a model pin is set on `config`: this workspace's registry normalizes the spec. */
  protected modelSetting(config: AgentConfigStore, onChanged: () => void): SetModelDeps {
    return { config, normalize: (s) => this.providerRegistry().normalizeSpecSync(s), onChanged };
  }

  /** Resolves on admission, not landing; where the words land reaches clients as steer_status
   * under the same id. Unrecognized mode runs as build. */
  @callable()
  send(text: string, id: string, files: readonly PromptFile[] = [], mode?: WorkMode): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const attachments = v.parse(v.array(PromptFileSchema), files);
      const workMode = isWorkMode(mode) ? mode : 'build';
      const window = this.addressedActor();

      if (window !== null && this.hostedChatWire(window) === null) return yield* new KinuError('missing', `${window} is not an agent of this workspace`);
      yield* Effect.promise(async () => this.hostedAdmit(window ?? this.actorHandle().actorId, { text, files: attachments, id, mode: workMode }));
    }));
  }

  /** Where a send stands in the chat this connection addresses, read from its durable facts: what a client asks after
   *  any break, instead of inferring its fate from what the stream showed. */
  @callable()
  sendState(id: string): Promise<SendState> {
    return settle(Effect.flatMap(this.addressedChat(), (chat) => Effect.promise(() => chat.sendState(id))));
  }

  /** Its state once settled or none; a client that lost its connection asks again. */
  @callable()
  awaitSend(id: string): Promise<SendState> {
    return settle(Effect.flatMap(this.addressedChat(), (chat) => Effect.promise(() => chat.awaitSend(id))));
  }

  private addressedChat(): Effect.Effect<ChatWire, KinuError> {
    const window = this.addressedActor();

    if (window === null) return Effect.succeed(this.chatTransport.wire);
    const wire = this.hostedChatWire(window);

    return wire === null ? Effect.fail(new KinuError('missing', `${window} is not an agent of this workspace`)) : Effect.succeed(wire);
  }

  /** Aborts the in-flight LLM request first so stop works even if the cancel frame is lost.
   * Foreground only: detached jobs are stopped via `cancelBackgroundJob`. */
  @callable()
  async cancelCurrentWork(): Promise<CancelWorkOutcome> {
    const window = this.addressedActor();

    if (window !== null) {
      // In its window's order: what the window sent before this Stop is stopped, what it sends after is not.
      await this.chatRooms.hostedRoom(window)?.interrupt();

      return { ok: true, abortedTools: 0, deviceCommands: [] };
    }

    const actorId = this.actorHandle().actorId;

    this.stopSubtree(actorId);

    return await cancelCurrentWork({
      // In the room's order, as a window's Stop is; its subtree and devices are stopped here.
      cancelChats: () => this.chatTransport.interrupt(() => this.stopAgent(actorId)),
      activeToolControllers: this.jobRunner.foreground,
      broadcast: (payload) => { this.broadcastToActor(null, payload); },
      stopDeviceCommands: () => settle(this.stopAgentDevices(actorId)),
      onCancelled: (outcome) => this.onWorkCancelled(outcome),
    });
  }

  /**
   * An agent's device commands stopped, whichever of its turns ran them: one its ended turn's Stop left unconfirmed is
   * reached by its next Stop (#68), and no other agent's is. A sweep that fails is reported as failed: the Stop's local
   * part has already run.
   */
  protected stopAgentDevices(actorId: string): Effect.Effect<CancelWorkOutcome['deviceCommands']> {
    return Effect.catchCause(Effect.promise(async () => {
      const { stub, caller } = await this.userHub();

      return stub.cancelDeviceRequestsForAgent(caller, actorId);
    }), (failed) => Effect.sync(() => {
      const err = Cause.squash(failed);
      diagnostics.failure('device.agent_cancel_failed', toKinuError({
        doing: "cancelling the agent's device commands", cause: err, otherwise: 'unavailable',
      }), { actorId });

      return [{ outcome: 'failed' as const, detail: renderThrownChain({ cause: err }) }];
    }));
  }

  /** Per-root hook after cancellation; whether Stop settles turn state is the root's business. */
  protected onWorkCancelled(_outcome: Omit<CancelWorkOutcome, 'ok'>): void {}

  /** Model for auxiliary calls and compaction. */
  getModel(): LanguageModel {
    this.actorHandle();
    const spec = this.runningProfile()?.tier.model ?? this.getStoredModelId();

    return settleSync(spec === null
      ? Effect.fail(new KinuError('missing', 'this agent has resolved no profile yet and pins no model'))
      : Effect.sync(() => this.ownedModelServices.resolveModel(spec)));
  }

  /** SOUL.md as this turn read it: any agent may have edited it since the last turn. */
  protected _cachedSoulText: string | null = null;
  protected async loadSoulText(): Promise<string> {
    return (await readSoul(this.rt.storage.vfs)) ?? '';
  }
  protected async refreshSoulText(): Promise<void> {
    this._cachedSoulText = await this.loadSoulText();
  }
  /** Protected because a hosted actor's turn is framed with the same workspace soul. */
  protected getSoulText(): string {
    return this._cachedSoulText ?? '';
  }

  /**
   * The workspace's purpose as this actor knows it: the auto-title source, and what an
   * added agent inherits. Each root answers from wherever its mission durably lives.
   */
  protected abstract ownMission(): Promise<string>;

  /**
   * Failures propagate so the durable caller keeps the row owed and the ledger retries it.
   * Decision is core's (`planWorkspaceTitle`); `persistAutoTitle` refuses if the owner claimed first.
   */
  protected async applyAutoTitle(mission: string, standIn: boolean): Promise<string | null> {
    // Read stored naming state before a cold activation plans a title.
    await this.hydrateTitleInputs();

    const title = await applyWorkspaceTitle({
      slug: this.actorHandle().name,
      ...this.titleInputs(),
      mission,
      standIn,
    }, {
      persist: (name) => this.persistAutoTitle(name),
      suggest: (text) => this.suggestTitle(text),
    });

    if (title) diagnostics.event('agent.auto_titled', { workspace: this.name, title });
    // Always publish, even with no new title, so the roster never keeps the placeholder.
    // Throws, so the owed row carries the retry.
    await this.publishAutoTitle();

    return title;
  }

  /** Publish the stored title to readers outside this actor's storage; no-op in the base. */
  protected async publishAutoTitle(): Promise<void> {}

  /** Fill the activation-local view {@link titleInputs} reads; no-op when naming is local. */
  protected async hydrateTitleInputs(): Promise<void> {}

  protected async titlingRefusal(): Promise<string | null> {
    return null;
  }

  /** `false` means a manual rename claimed the title first, so the owner's choice wins the race. */
  protected abstract persistAutoTitle(displayName: string): Promise<boolean>;

  /** The base reads its own config; the workspace root overrides with its cache of the UserDO
   *  registry row, since an actor_config mirror would drift against other writers. */
  protected titleInputs(): WorkspaceTitleInputs {
    return { displayName: this.config.getDisplayName(), nameOrigin: this.config.getNameOrigin() };
  }

  /** The workspace name, plus the actor's own name when it is a subagent. */
  protected abstract promptIdentity(): Promise<PromptIdentity>;

  /**
   * One `'fast'` literal feeds both the model route and the spend label, so they cannot disagree. Down the
   * fast tier's chain like every fixed-tier call ({@link completeOnRoute}).
   */
  protected async suggestTitle(mission: string): Promise<string | null> {
    return suggestWorkspaceTitle(await this.oneShotOn('fast'), mission);
  }

  protected async oneShotOn(source: 'fast' | 'logo'): Promise<(system: string, prompt: string) => Promise<string>> {
    const route = resolveModelRoute(source, await this.routingProfile());

    return (system, prompt) => completeOnRoute(route, {
      llm: (resolution) => routedLlm((serving) => this.modelForResolution(serving), resolution, {
        report: (report) => this.reportModelCall(report), operations: this.modelOperations,
      }, system),
      attemptOf: (spec) => this.ownedModelServices.attemptFor(spec),
      refusals: this.tierRefusals,
    }, prompt);
  }

  private refusalNotices: TierRefusals | null = null;

  private modelSettingsChanges = 0;

  protected refusalNoticesFor(actor: ActorHandle): TierRefusals {
    return tierRefusals({
      sql: this.boundSql, actor, config: actor.config, now: Date.now, settings: MODEL_SETTINGS, changes: () => this.modelSettingsChanges,
    });
  }

  /** One for the object's life, shared with the runtime's lanes, so what it said is read once. */
  protected get tierRefusals(): TierRefusals {
    this.refusalNotices ??= this.refusalNoticesFor(this.actorHandle());

    return this.refusalNotices;
  }

  /** The owner changed what decides a tier's model or credential: a parked refusal may answer differently. */
  protected async modelSettingsChanged(): Promise<void> {
    this.modelSettingsChanges += 1;
    this._accountSwarms = null;
    this.invalidateModelCaches();
    await this.terminal.ownerActed();
  }



  /** The workspace agent's tools as a turn of its own reaches them now, under its operation's profile. */
  getTools(): ToolSet {
    const tools = this.ownTools(this.turnWorkMode(), null).turn;
    const operation = this.operationProfile();

    return operation ? withOperationProfile(tools, operation) : tools;
  }

  /** `claimScope` keys a rollout's effects on the rollout; else a call claims under the operation it runs in. */
  protected getRawToolsForWorkMode(mode: WorkMode, claimScope?: string): ToolSet {
    return this.ownTools(mode, claimScope ?? null).raw;
  }

  /** The workspace agent's own tools in `mode` outside any turn of its, from the one factory every agent's are built by.
   *  `held`: the call's ledgers and the store operations its other projections already run. */
  protected abstract ownTools(mode: WorkMode, scope: string | null, held?: OwnToolsHeld): ActorToolsets;

  /** What this agent's builtins read its stores from, as its own tools do, on `ledgers`: for a caller holding none of
   *  them (a slate, a scaffold's run). */
  protected abstract ownStoreInputs(ledgers: TurnLedgers): BuiltinStoreInputs;

  /** What a hosted actor's builtins read its stores from, as its own turn's do; without `account`, the account's
   *  memory stays out of reach (a slate's call never reaches it). */
  protected abstract hostedStoreInputs(actor: CFSeat, ledgers: Pick<TurnLedgers, 'files' | 'context'>, account: boolean): BuiltinStoreInputs;

  /**
   * A hosted actor as a caller outside its turn reaches it: its own files, tables, tasks and facts over the stores its
   * own turn runs, never the workspace actor's (pinned by `tests/unit-slate-composition.test.ts`).
   */
  protected hostedActorSurface(
    actor: SeatedActor, reach: { readonly account: boolean; readonly ownerWaits: OwnerWaitsHost | null; readonly mail?: MailDeps | null },
  ) {
    // `ActorHostDeps.runtimeFor` is `createCFRuntime` on this backend; core only narrows the type.
    const { runtime } = actor;

    if (!isCFRuntime(runtime)) {
      throw new KinuError('unsupported', 'a hosted actor on this backend must run on the cf runtime');
    }

    // A slate's call is no turn of the actor's: it accounts into ledgers of its own, but for its files, whose reads stand
    // across its calls as the actor's own programs' do.
    const scoped = scopedTurnSurface()?.ledgers;
    const inputs = this.hostedStoreInputs({ ...actor, runtime }, { files: scoped?.files ?? standingFileLedger(runtime), context: (scoped ?? turnLedgers()).context }, reach.account);
    const webSearch = this.ownedModelServices.getWebSearchProvider();
    // Served once: the slate's `tools.*` and its named namespaces run the same operations.
    const stores = serveStores(builtinStoreDeps(inputs));
    const surface = this.hostedSurface({ ...actor, runtime }, { search: webSearch, stores, ownerWaits: reach.ownerWaits, mail: reach.mail ?? null });

    return { actor: surface, native: buildBuiltinTools({ ...inputs, webSearch }, stores) };
  }

  /** A hosted actor's program surface over `held.stores`, with this workspace's browser for it. */
  protected hostedSurface(
    actor: CFSeat,
    held: { readonly search: WebSearchProvider; readonly stores: ServedStores; readonly ownerWaits: OwnerWaitsHost | null; readonly mail: MailDeps | null; readonly agents?: () => AgentsToolDeps },
  ): SurfaceActor {
    const { search, ...reached } = held;

    return hostedSurfaceActor(actor, {
      ...reached,
      web: { search, files: actor.runtime.storage, browser: { sessions: this.browserSessionsFor(actor.runtime.actor.actorId), prelude: BROWSER_PRELUDE } },
    });
  }

  /**
   * The ledgers this agent's own tools account into: its turn's, else, outside any turn, a budget of the call's own
   * and its runtime's standing file ledger, which every caller outside a turn shares (`standingFileLedger`).
   */
  protected ownLedgers(): TurnLedgers {
    return this.mainTurn()?.ledgers ?? { ...turnLedgers(), files: standingFileLedger(this.rt) };
  }

  /** The workspace agent's delegation in `mode`, as its programs reach it. */
  protected abstract ownAgentsToolDeps(mode: WorkMode): AgentsToolDeps;

  /** Every agent's turn surface (design v2 §2, §9), from the one factory. */
  protected abstract actorSurface(actor: CFSeat, turn: SurfaceTurn): Promise<ActorSurface>;

  /**
   * "Beta: swarms" as the workspace agent's tools last read it; null until read and after a catalog write. Not the held
   * catalog's: a recovered turn's tools offer what its frozen catalog said, and a turn's stay as it opened them.
   */
  private _accountSwarms: boolean | null = null;

  /** "Beta: swarms" as held, read once when nothing holds it. */
  protected async readAccountSwarms(): Promise<boolean> {
    this._accountSwarms ??= await this.currentAccountSwarms();

    return this._accountSwarms;
  }

  /** "Beta: swarms" as the account's catalog says it now, held for the workspace agent's tools. */
  protected async currentAccountSwarms(): Promise<boolean> {
    this._accountSwarms = betaSwarms((await this.profileCatalog()).catalog);

    return this._accountSwarms;
  }

  /** A turn of the workspace agent read the account's catalog as it opened: its tools offer what that read says. */
  protected accountSwarmsRead(catalog: ProfileCatalogEnvelope['catalog']): void {
    this._accountSwarms = betaSwarms(catalog);
  }

  /** Whether the workspace agent's tools offer swarms, as the account's catalog was last read for them. */
  protected get accountSwarmsHeld(): boolean {
    return this._accountSwarms === true;
  }

  /** Built lazily once per DO lifetime; heads need the owner for UserDO auth, so undefined without one. */
  private _cfHeadRuntime: HeadRuntime | null = null;
  /** This workspace's running swarm workers and branch heads, each stoppable alone. */
  protected readonly liveWorkers = new LiveWorkers();
  protected getCFHeadRuntime(): HeadRuntime | undefined {
    if (this._cfHeadRuntime) return this._cfHeadRuntime;
    const ownerUserId = this.getOwnerUserId();

    if (!ownerUserId) return undefined;

    const grounding: HeadGrounding = this.rt.judgeModel
      ? { executor: this.rt.executor, explorer: this.rt.llm, judge: this.rt.judgeModel }
      : { executor: this.rt.executor, explorer: this.rt.llm };

    this._cfHeadRuntime = createHeadRuntime({
      host: this.hostedSeams(),
      workers: this.liveWorkers,
      models: this.ownedModelServices,
      // The merge is a judge call: its model and effort come from the route table via this profile,
      // not from the actor's stored chat spec.
      profile: () => this.routingProfile(),
      reportModelCall: (report) => this.reportModelCall(report),
      operations: this.modelOperations,
      grounding,
    });

    return this._cfHeadRuntime;
  }

  /** An actor's transcript as this object's stores bind it. */
  protected abstract transcriptFor(actor: ActorHandle): SessionTranscript;

  /**
   * An actor's recent conversation (last N messages), handed to each spawned head as context.
   * A hosted actor hiring its own child must pass its own conversation, not the workspace root's.
   */
  protected abstract readInheritedContext(actor?: ActorHandle): Promise<SerializedMessage[]>;

  /**
   * The owner's MCP descriptors, asked for at once and settled, so the turn that reads them decides what a failed read
   * means. No owner or no identity, no user-level tools: checked rather than caught, as userCaller() throws only when no
   * token was issued, and a real read failure must not silently empty the surface.
   */
  protected userMcpDescriptors(): Promise<PromiseSettledResult<McpToolSurface>> | null {
    if (!this.getOwnerUserId() || !this.workspaceCapabilityToken()) return null;
    const asked = this.userCaller().then(async (caller) => await this.requireOwnerUserDO().userMcp_toolDescriptors(caller));

    return Promise.allSettled([asked]).then(([read]) => read);
  }

  /**
   * Rebuilds AI-SDK tools from MCP descriptors; cache invalidates on descriptor content hash, and a
   * failed read keeps the last good build. `execute` dispatches as the parent workspace's token.
   */
  protected async buildUserMcpTools(nativeTools: ToolSet, catalog: Promise<ModelCatalogRead>, descriptors = this.userMcpDescriptors()): Promise<ToolSet> {
    if (descriptors === null) return {};
    // Read beside the model's resolution; a failed read reaches the failure arm through `refresh`.
    const [read] = await Promise.allSettled([catalog, descriptors]);

    // An unresolved profile fails the turn in `readTurnInputs`.
    if (read.status === 'rejected') return {};

    try {
      // Budget is the resolved model's step context limit minus this actor's own tool definitions, read
      // off the same `ModelCatalogSession` as compaction (`McpSurfaceBudget`).
      const tools = await this.mcpToolsCache.refresh(
        async () => {
          const surface = await descriptors;

          if (surface.status === 'rejected') throw surface.reason;

          return v.parse(McpToolSurfaceSchema, surface.value);
        },
        {
          ...read.value.window(),
          nativeToolTokens: toolSurfaceTokens(nativeTools),
        },
      );

      this._mcpUnavailable = this.mcpToolsCache.unavailable;
      this.logActivity('mcp_tools_served', `${Object.keys(tools).length} tools`);

      return tools;
    } catch (err) {
      const failure = toKinuError({
        doing: 'building the user MCP tool adapters for this turn',
        cause: err,
        otherwise: 'unavailable',
      });

      // Only an unreachable/unfinished catalog read is tolerated (turn runs on builtins alone); denied
      // callers, bad descriptors or cancellation are this turn's faults and rethrow.
      if (!MCP_CATALOG_READ_FAILURES.has(failure.code)) throw failure;
      diagnostics.failure('mcp.tool_surface_failed', failure);
      this._mcpUnavailable = [{ server: null, reason: 'The descriptor read failed. No MCP tool is available for this turn.' }];

      return {};
    }
  }

  /** Resolved `<provider>/<modelId>` for the next turn; falls back to the raw spec pre-claim.
   *  Protected: a hosted actor's search prices its estimate against this resolution. */
  protected effectiveModelSpec(): string {
    return resolveEffectiveModelSpec({
      live: () => this.runningProfile()?.tier.model,
      stored: () => this.getStoredModelId(),
      normalize: (spec) => (spec === null ? '' : this.providerRegistry().normalizeSpecSync(spec)),
    });
  }

  private promptModelContextFor(named: string): PromptModelContext {
    const spec = named === '' ? '' : this.providerRegistry().normalizeSpecSync(named);

    if (!spec) return {};

    try {
      const { provider, modelId } = parseModelSpec(spec);

      return { id: modelId, provider };
    } catch (error) {
      diagnostics.event('actor.model_spec_unparseable', {
        workspace: this.name, error: renderThrownChain({ cause: error }),
      });

      return { id: spec };
    }
  }

  /** Cached, non-blocking lookup per spec; static fallbacks answer until it lands. Every hosted actor's spend
   *  is priced off it, so a search's estimate and the ledger read one rate. */
  protected readonly modelCatalog = new ModelCatalogSession({
    effectiveSpec: () => this.effectiveModelSpec(),
    lookup: async (spec) => (spec ? this.catalogEntry(spec) : null),
    measured: (spec) => this.stores.eventRecorder.measuredWindow(spec),
  });

  protected async catalogEntry(spec: string): Promise<ModelInfo | null> {
    const reg = this.providerRegistry();

    return specModelInfo(reg.registry, reg.deps, spec);
  }

  /** Before the task's first call. */
  protected async priceHostedModel(spec: string): Promise<void> {
    await this.modelCatalog.warm([spec]);
  }

  /** A fresh turn of the workspace agent opens on its lanes: evolution work a dead process left is recovered, and the
   *  turn's missions scope the workspace's spend. */
  protected workspaceTurnOpening(driving: JsonObject): void {
    this.engine.recoverInterruptedWork();
    this.budget.activate([...turnTags({ metadata: driving }).missionLabels]);
  }

  /** A turn of the workspace agent's read here: its executors and folder are its own, its clock starts, and a fresh one's
   *  owner's words are the verdict on the turn before (programmatic turns, a reactor's or a job's wake, are not). */
  protected workspaceTurnOpened(surface: TurnSurface, driving: JsonObject, fresh: boolean): void {
    this._executorsUsedThisTurn.clear();
    this._cliCwd = readCliCwd(driving);
    this._turnT0 = performance.now();

    if (fresh && surface.item.kind === 'user') {
      this.lanes.observeUserTurn(surface.key.turnId, surface.item.text, surface.continuity, this.engine.enabled && turnTags({ metadata: driving }).mode !== 'plan');
    }
  }

  /** The profile each agent's isolate last assembled a turn on, kept for the status reads between its turns. */
  protected readonly boundProfiles = new Map<string, ResolvedTurnProfile>();

  /** An agent's tools run under the profile its isolate assembled on, inside the approved plan it implements, over its
   *  own store and the workspace's; each call is a fleet row. */
  protected turnTools(tools: ToolSet, turn: { readonly taskPlan: TaskPlan | undefined; readonly surface: TurnSurface; readonly sql: SqlExecutor }): ToolSet {
    const { taskPlan, surface } = turn;
    const held = taskPlan === undefined ? tools : withTaskPlan(tools, { sql: Object.freeze([this.boundSql, turn.sql]), plan: taskPlan });

    return Object.fromEntries(Object.entries(held).map(([name, entry]) => {
      const { execute } = entry;

      if (execute === undefined) return [name, entry];

      return [name, { ...entry, execute: async (input, options) => {
        const started = Date.now();
        let failed = true;

        try {
          const result = await inTurnSurface(surface, () => runOperationProfile(surface.operation, () => execute(input, options)));

          failed = false;

          return result;
        } finally {
          // Name, verdict and duration only: its input and result carry the workspace's content.
          recordToolRow(this.env, { workspace: this.workspaceName(), agentKind: this.actorKind(), tool: name, failed, durationMs: Date.now() - started });
        }
      } }];
    }));
  }

  /** An agent's first token as its window hears it, from its turn's own start, on the model its isolate assembled on. */
  protected recordFirstToken(actorId: string, openedAt: number): void {
    const model = this.boundProfiles.get(actorId)?.tier.model;

    recordTtftRow(this.env, {
      workspace: this.workspaceName(), agentKind: this.actorKind(), ...(model === undefined ? this.analyticsModel() : this.analyticsModelOf(model)), ttftMs: Date.now() - openedAt,
    });
  }

  /** Main's next request as a candidate scaffold is compared against, from the one factory its turns are built by: its
   *  working context is its own isolate's. */
  private async composeNextRequest(): Promise<ComposedRequest> {
    const history = await this.mainWorkingContext();
    const mode = await this.preparedWorkMode();
    const root = this.rootBound();

    const surface = await this.actorSurface({ ...root, runtime: this.rt }, {
      key: { actorId: root.handle.actorId, turnId: WORKSPACE_RUN_ID, runId: WORKSPACE_RUN_ID },
      lane: { authorship: 'owner', mode, parentDriven: false, awaitsReply: false, ...(this.turnDrivingMetadata() !== undefined && { driving: this.turnDrivingMetadata() }) },
      text: '',
    });

    const explicitTier = turnTags({ metadata: this.turnDrivingMetadata() }).tier;

    const assembled = await assembleActorTurn(
      { ...surface.sources, toolset: () => ({ tools: surface.tools, stores: surface.stores }), externalTools: async () => surface.surface.external },
      {
        userText: extractLastUserText(history), workMode: mode, ...(explicitTier !== undefined && { explicitTier }),
        pagesInAnswer: answerDrawsPages(this.turnDrivingMetadata()),
      },
    );

    this._settledProfile = assembled.profile;

    return { execution: assembled.execution, profile: assembled.profile, sessionKey: this.name };
  }

  /**
   * Main's Clear, answered in its own isolate: transcript, working history, dynamic ledger and compaction plan, refused
   * while a turn runs. Only once the stores are empty is every window told to empty, so no page drops what the server
   * still holds.
   */
  @callable()
  async clearConversation(): Promise<void> {
    const unmeasured = await this.clearMainConversation();

    // The clear stands without its measure; the failure is recorded where the operator's diagnostics read it.
    if (unmeasured !== null) diagnostics.failure('context.clear_measure_failed', new KinuError('unavailable', unmeasured), { workspace: this.name });
    this.broadcastToActor(null, JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
  }

  /** The one override point for a harness to script a turn's model. */
  protected turnModel(spec: string): LanguageModel {
    return this.ownedModelServices.resolveModel(spec);
  }

  /** Main's working context, in its own isolate: what a context:'inherit' hire reads back of the conversation it had. */
  private async mainWorkingContext(): Promise<readonly ModelMessage[]> {
    return await this.agentStores(this.actorHandle().actorId).workingContext();
  }

  /** Subclass-only planes, read per step by the shared assembler; empty here. */
  protected extraDynamicContext(): ActorDynamicContextExtras {
    return {};
  }

  /** Each agent's dynamic-block reads and its delegates, held across its turns' preparation, binding, tool answers and
   *  open work ({@link held}). One per agent, whichever store bundle asks first: a hold names its tables, not its store. */
  private readonly heldDynamic = new Map<string, { readonly reads: DynamicReads; readonly delegates: () => readonly DynamicDelegate[] }>();

  private heldDynamicOf(reference: ActorReference) {
    const known = this.heldDynamic.get(reference.actorId);

    if (known !== undefined) return known;
    // Over its store binding, which outlives its seat: a seat released between turns would revoke what it held.
    const { handle, stores } = this.actorHost().bindStores(reference);

    const held = {
      reads: dynamicReads(stores, this.boundSql, handle, this.held),
      // Every SubagentRosterStore writes over `watchedExec`, the directory's origins over `sql`.
      delegates: this.held.hold(['actor_subagents', 'workspace_actors'], () => subagentDelegatesOf(new SubagentRosterStore(this.watchedExec, handle).list())),
    };

    this.heldDynamic.set(reference.actorId, held);

    return held;
  }

  protected dynamicReadsOf(reference: ActorReference): DynamicReads {
    return this.heldDynamicOf(reference).reads;
  }

  /**
   * The live state of an agent, read for one model step, the same for every agent; its store rows are held until a write
   * moves them. The workspace's planes (its external tools' gaps, its approvals, its failing slates) only where its reach
   * names them. Nothing clock-derived: a wall-clock field would re-fingerprint the block every request.
   */
  protected actorDynamicContext(actor: SeatedActor, reach: ActorReach, step: {
    readonly profile: Pick<ResolvedTurnProfile, 'workMode' | 'allowedTools' | 'tier'>;
    readonly tools: ToolSet;
    readonly reads: TurnMemoryReads;
    readonly surface: TurnSurface | null;
  }): DynamicContext {
    const { memoryTail, accountFacts, activeSkills, mail } = step.reads;
    const held = this.heldDynamicOf(actor.reference);
    const extras = reach.kind === 'workspace' ? this.extraDynamicContext() : {};
    // The workspace's own agent is told why its turn runs and what its model holds; a hire, its model's name.
    const turn = reach.kind === 'workspace' && step.surface !== null ? turnTags(step.surface.item).reason : undefined;
    const model = reach.kind === 'workspace' ? this.promptModelContextFor(step.profile.tier.model) : { id: step.profile.tier.model };
    // Names and hosts only: a placeholder is the command's to hold, never the model's to read.
    const secrets = this.account.secretsHeld;

    return collectDynamicContext({
      rt: actor.runtime,
      stores: actor.stores,
      reads: held.reads,
      profile: step.profile,
      tools: step.tools,
      externalTools: step.surface?.declared ?? {},
      runtime: { backend: 'cf', model, date: currentDateForPrompt() },
      ...(turn !== undefined && { turn }),
      // Its skills are its isolate's: a snapshot here reads only what the turn hands it.
      ...(activeSkills !== null && activeSkills !== undefined && { activeSkills }),
      memoryTail,
      ...(accountFacts !== undefined && { accountFacts }),
      ...(secrets !== undefined && { secrets: { granted: secrets.granted.map(({ name, hosts, position, reveal }) => ({ name, hosts, position, reveal })), withheld: secrets.withheld } }),
      ...(reach.kind === 'workspace' && { unavailableMcp: this._mcpUnavailable }),
      missingCapabilities: extras.extraMissingCapabilities?.() ?? [],
      subagentDelegates: held.delegates,
      approvals: extras.approvals,
      ...(mail !== undefined && { mail }),
      ...(extras.failingSlates !== undefined && { failingSlates: extras.failingSlates }),
    });
  }

  /** Chat turns are interactive: slow work must hand back a handle fast. Signal-driven turns are
   *  one-shot: detaching there costs a truncated turn plus a synthesis turn and buys nothing. A wake
   *  that resumes parked calls opens its turn on the surface they were made on (`RESUMED_SURFACE`). */
  protected turnSurface(): InvocationSurface {
    const resumed = v.safeParse(InvocationSurfaceSchema, this.turnUserMetadata()?.[RESUMED_SURFACE]);

    if (resumed.success) return resumed.output;
    // Either marks one-shot: a CLI `oneShot` request (continuity 'independent_task') or a
    // signal-driven turn carrying `kinuEvent` metadata; continuity alone misses autonomous turns.
    const programmatic = this.turnUserMessageEvent() !== null;

    return programmatic || this.mainTurn()?.continuity === 'independent_task' ? 'one-shot' : 'interactive';
  }

  /** Read off the item the loop admitted; null for real chat turns. */
  protected turnUserMessageEvent(): string | null {
    const metadata = this.turnUserMetadata();

    return metadata !== undefined && v.is(v.string(), metadata.kinuEvent) ? metadata.kinuEvent : null;
  }
  /** Plan is explicit user intent on the driving message; everything else is unconstrained. */
  protected turnWorkMode(): WorkMode {
    return this.workModeForMetadata(this.turnDrivingMetadata());
  }

  protected workModeForMetadata(metadata: JsonObject | undefined): WorkMode {
    return this.operationProfile()?.profile.workMode ?? turnTags({ metadata }).mode;
  }

  protected async preparedWorkMode(): Promise<WorkMode> {
    if (this.mainTurn() !== null) return this.turnWorkMode();

    return this.workModeForMetadata(await this.mainLastUserMetadata());
  }

  /** Author-stamped, so the plan hold tells the owner's turn from the harness's. */
  protected turnDrivingMetadata(): JsonObject | undefined {
    const metadata = this.turnUserMetadata();
    const item = this.mainTurn()?.item ?? null;

    return item === null ? metadata : authoredTurnMetadata({ kind: item.kind, metadata });
  }

  /** Active turn metadata only. Idle operations await canonical metadata in
   *  preparedWorkMode before constructing their synchronous tool surface. */
  protected turnUserMetadata(): JsonObject | undefined {
    const metadata = this.mainTurn()?.item.metadata;

    if (metadata === undefined) return undefined;
    const parsed = v.safeParse(JsonObjectSchema, metadata);

    return parsed.success ? parsed.output : undefined;
  }

  /**
   * The live turn's profile, else one resolved now for durable work without a chat turn.
   * MODEL_ROUTE_POLICY is read against this; resolving a model any other way bypasses routing.
   */
  protected async routingProfile(availableTools: readonly string[] = [], preparedMode?: WorkMode): Promise<ResolvedTurnProfile> {
    return resolveRoutingProfile({
      actor: this.actorHandle(),
      resolve: async () => {
        const inputs = await this.profileInputs();

        return resolveTurnProfile({
          ...inputs,
          ...ownProfileChoices(this.config, inputs),
          workMode: preparedMode ?? await this.preparedWorkMode(),
          availableTools,
          activeSkills: [],
        });
      },
    });
  }
  /** Resolved now, as this root's or hosted actor's next turn would. */
  protected async actorProfile(input: {
    readonly actor: ActorHandle;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
    /** An `ai.run` call's named tier overrides the actor's assignment for this call. */
    readonly explicitTier?: string | undefined;
  }): Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }> {
    const inputs = await this.profileInputs();

    return {
      profile: resolveTurnProfile({
        ...inputs,
        ...ownProfileChoices(input.actor.config, inputs, this.ancestorProfiles(input.actor), {
          explicitTier: input.explicitTier,
        }),
        workMode: input.workMode,
        availableTools: [...input.availableTools],
        activeSkills: [],
      }),
      inputs,
    };
  }

  /** Ancestors' own pins, nearest first, up to the root; none for an agent no one hired, whose own pins are the workspace's. */
  protected ancestorProfiles(actor: ActorHandle): PinnedProfile[] | undefined {
    if (actor.parentActorId === null) return undefined;

    return ancestorPins(actor.parentActorId, { actorId: this.actorHandle().actorId, pins: this.config }, (id) => {
      const parent = this.actorHost().describe(id);

      return parent === null ? null : { parentActorId: parent.parentActorId, pins: createAgentConfigStore(this.boundSql, id, actor.assertCurrent) };
    });
  }

  /** One model of a side route or of its chain, resolved the one way every side model is. */
  protected modelForResolution(resolution: Pick<ModelRouteResolution, 'model' | 'reasoningEffort'>) {
    return {
      spec: resolution.model,
      ...this.ownedModelServices.resolveModelWithEffort(resolution.model, resolution.reasoningEffort),
    };
  }

  /**
   * Async maintenance that may queue turns or cross objects, so it runs in the alarm, never activation.
   * Idempotent; returns whether the budget filled and work must continue next tick.
   */
  protected async maintenanceWork(): Promise<boolean> {
    return recoverSubagentLifecycles(this.subagentRoster, this.subagentRuntime());
  }

  /** A lane: work held alive whose own row outlives the activation running it, so the next one re-drives what it left
   *  (D11). Not a fiber: the platform's recovery hook runs under a timeout. */
  protected holdLane<T>(body: () => Promise<T>): Promise<T> {
    return this.keepAliveWhile(body);
  }

  /** Detached work this actor owns until its lexical error boundary settles. */
  protected readonly _backgroundTasks = new Set<AsyncTaskOwner>();

  /**
   * Owns a detached task so it can be joined; a reset cancels promises silently
   * (`do.background_task.cancelled_on_reset`). Not durable; the body names its own failures.
   */
  protected detachOwned(body: Effect.Effect<void>): void {
    const owner: AsyncTaskOwner = { promise: null };
    this._backgroundTasks.add(owner);
    owner.promise = hold(Effect.ensuring(Effect.catchCause(body, recording({ doing: 'running a detached activation task', otherwise: 'io' }, (failure) => {
      diagnostics.failure('actor.detached_task_unclassified', failure, { workspace: this.name });
    })), Effect.sync(() => {
      this._backgroundTasks.delete(owner);
    })));
  }

  /**
   * Await every detached task this activation owns; a test seam, since production tasks are fenced.
   * Bounded laps: a task that keeps replenishing the set fails the caller instead of hanging.
   */
  protected async settleBackgroundTasks(): Promise<void> {
    for (let lap = 0; lap < 32; lap++) {
      if (this._backgroundTasks.size === 0) return;
      await Promise.all([...this._backgroundTasks].map((task) => task.promise ?? Promise.resolve()));
    }

    throw new KinuError('io',
      `settleBackgroundTasks: ${String(this._backgroundTasks.size)} task(s) still detached after 32 `
      + 'laps: something keeps enqueuing work; join a narrower seam instead',
    );
  }

  /** Every budgeted activation sweep; subclasses fold in their own. True if any pass filled its
   *  budget (caller arms the wake). Synchronous so the init gate can run the same seam. */
  protected maintenanceSweeps(): boolean {
    return false;
  }

  protected invalidateModelCaches(): void {
    // Also drops the provider registry (caches per-agent OAuth refreshers) so a disconnected
    // provider stops being marked available.
    this.ownedModelServices.invalidate();
    this.account.expire();
  }

  // All credentials live in UserDO; providers resolve auth headers through the UserDO stub at
  // fetch time, so this agent stores no raw credentials.

  /** Fan-out target of notifyWorkspacesModelSettingsChanged after the owner's credential or profile writes. */
  async onModelSettingsChanged(): Promise<{ ok: true }> {
    await this.modelSettingsChanged();

    return { ok: true };
  }

  /** Re-drive an evicted background job from its checkpoint (B6) over the raw surface, so a
   *  re-drive can't detach a second job. */
  protected async resumeBackgroundJob(
    kind: string,
    input: JsonValue,
    mode: WorkMode,
    signal: AbortSignal,
  ): Promise<JsonValue | undefined> {
    await this.currentAccountSwarms();
    // Work outside a turn runs on the profile the actor resolves now.
    await this.currentProfile();

    return await resumeBackgroundJob({
      rawTools: (resumeMode) => this.getRawToolsForWorkMode(resumeMode),
      kind, input, mode, signal,
    });
  }
}
