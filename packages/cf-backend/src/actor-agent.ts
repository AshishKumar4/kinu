/**
 * ActorAgent — the actor-agnostic substrate beneath every full-loop Kinu
 * actor on the Cloudflare backend.
 *
 * OrchestratorAgent (the top-level workspace DO) and any future facet actor
 * (a subordinate riding the workspace via subAgent()) are Think subclasses
 * that differ only in the profile members below — identity bootstrap
 * (getOwnerUserId), exec-plane keying (workspaceName), tool surface
 * (actorToolDeps / extraCodemodeProviders), evolution engine, and owner
 * notification. Everything else — the CF runtime assembly, the BackendHost,
 * the shared AgentOrchestrator, ExtensionHost + compaction, the dynamic
 * ledger, prompt/model/tool caches, and the Think hook bridge (beforeTurn /
 * beforeStep / tool hooks) — lives here, once.
 *
 * Tool gating is structural: an actor whose profile wires no `team` deps has
 * no hiring actions on its `agents` tool. No flags.
 */

import { callable, type AgentContext, type Connection, type ConnectionContext, type SubAgentClass } from "agents";
import { ExplorationAgent } from './exploration';
// Type-only, so it is erased and the base class carries no runtime import of
// its own subclass. The VALUE comes from `subordinateFacet()`, which each
// concrete root supplies.
import type { SubordinateAgent } from './subordinate-agent';
import type { SubordinateActivityEvent } from './lib/protocol';
import { parseProtocolMessage } from "agents/chat";
import { CLI_SCOPES_HEADER, cliScopesConnectionTag, rejectOutOfScopeRpc } from "./cli/rpc-gate";
import { createWorkersTracer } from "./obs/cf-tracer";
import { createAgentTracing, renderThrownChain, type AgentTracing } from "@kinu.run/core/obs";
import {
  createCompactionExtension, createVfsTranscriptStore,
  createCompactionStateStore, createModelSummarizer,
  type CompactionStateStore, type Logger as CompactionLogger,
} from "@kinu.run/compaction";
import { Think, Session } from "@cloudflare/think";
import { streamText, tool, jsonSchema, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, SystemModelMessage, ToolSet, UIMessage } from "ai";
import {
  SerializableToolDescriptorSchema,
  type SerializableToolDescriptor,
} from "./user/mcp";
import type {
  TurnContext, TurnConfig,
  ToolCallResultContext, StepContext, ChunkContext,
  PrepareStepContext, StepConfig,
  ToolCallContext as ThinkToolCallContext,
  ChatResponseResult,
  StreamableResult,
} from "@cloudflare/think";
import {
  EvolutionEngine, type EvolutionConfig,
  resolveMaxSteps,
  // Scaffold loop closure — the evolved inference loop + its sampled
  // shadow rollout. Shared by every actor that carries an EvolutionEngine.
  scaffoldInferenceTransform, type ScaffoldRunOptions,
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory,
  queueTurnShadowTrial, runQueuedShadowTrials, createJsonJudge, type ScaffoldControl,
  SCAFFOLD_TURN_TIMEOUT_MS,
  effortFor, type CompletedTurn, type TurnContinuity,
  runAdvisorLane,
  // canonical tool + prompt surface — single source of truth
  buildActorTools,
  withClampedToolResults,
  type WebSearchProvider,
  buildSystemPromptSync,
  activePromptSectionOverrides,
  currentDateForPrompt,
  turnProvenanceForMetadata,
  workModeForTurnMetadata,
  DynamicContextLedger, turnLocalContextMessage, observeSystemPromptHash,
  type DynamicContext, type MissingCapability,
  // Public extension seam — the SAME host contract runChat drives on the CLI
  ExtensionHost, composePrepareStep,
  UserSteerDrain, STEER_METADATA_KEY, STEER_STEP_METADATA_KEY,
  type UserSteer, type UserSteerOutcome, type SteerStatusEvent, type SteerStatusDetail,
  // Overflow recovery — the shared turn-failure policy (see turn-failure.ts)
  OVERFLOW_RETRY_EVENT,
  // Shared turn lifecycle (run bracket, prompt-token trigger, overflow apply)
  openTurnRun, closeTurnRun, persistMeasuredPromptTokens, applyOverflowRecovery,
  // backend-agnostic per-turn accounting + orchestration (shared by cf + cli)
  TurnAccumulator, AgentOrchestrator, type BackendHost,
  type SettledSignals,
  type AgentsToolAction,
  type AgentsToolDeps,
  type BuiltinToolName,
  type TurnProvenance,
  type PromptModelContext,
  type WorkMode,
  ACTIVE_TOOLS,
  nanoid,
  // Branching heads
  HeadController, type HeadJournal, LiveHeadJournal,
  type HeadId, type HeadInput, type HeadReport, type MergeStrategy,
  type SerializedMessage, type SplitPhaseEvent, type HeadRuntime, type HeadGrounding, type MergeResult,
  type NodeLoopHost, type NodeArbiter, type BranchProposal, type BranchDecision,
  // Canonical memory-note read (the dynamic-context MEMORY.md tail)
  readMemoryTail,
  // Durable run-event log
  type RunEventRecorder,
  // Cumulative, label-scoped spend governor (opt-in; no label = no cap)
  MissionGovernor, type MissionSeam, type MissionBudgetRefusal,
  // The one normalized provider usage report
  normalizeUsage, usageReported, type Usage,
  // Non-turn model calls: the row type, its sink, and where a call with no run
  // open is filed. The other 25 producers of workspace spend arrive this way.
  WORKSPACE_RUN_ID, type ModelCallReport, type RunEventInput,
  // The ONE catalog pricing, so a model_call row prices exactly as the ledger
  // debits — and only when the rate belongs to the model that served it.
  priceCall,
  // agent_facts world model
  type FactsStore,
  // Per-turn device awareness (laptop runtime presence + change notice)
  observeDevicePresence,
  // The stores every agent has, built once from its one SQL handle, and the
  // one binding of the live per-step planes to them.
  createAgentStores, type AgentConfigStore, collectDynamicContext,
  type SessionWriter, type SqlExecutor,
  // The agents tool's fork substrate (shared factory) + durable MCTS session
  buildStrategyForkDeps, createDurableMctsSession, agentsActionsFor,
  // Background-job system (#173 — auto-background past the surface threshold)
  BackgroundJobRunner, BACKGROUND_POLICY, type SessionSurface,
  type BackgroundJobStore, type TaskListStore,
  wrapToolsForBackground, BACKGROUNDABLE_TOOLS, resumeBackgroundJob, harvestBackgroundJob,
  // The control plane both roots expose over the same core implementations.
  cancelCurrentWork, getStoredModelSpec, setModel, getChatHistoryPage,
  type CancelWorkOutcome, type ChatHistoryEntry, type Page, type PageRequest,
  type MctsSearchStore, readSearchTree, type MCTSProgressEvent,
  // EventsHub primitives (spec §1)
  EventLog,
  // Skills + per-turn surface (core turn-surface)
  resolveTurnSkills, filterToolNamesBySkills, skillsVfsOver,
  type ActiveSkillSet, type SkillsVfs,
  // Heads support (takes capture + inherited-context digest)
  recordGroundedHeadsTake, INHERITED_CONTEXT_CAP,
  inheritedContextFromRows, headPhaseRunEvent,
  type ReleaseToolDeps,
  type SubmitPlanToolDeps,
  isVfsError,
  type ParentRpcResult, type ParentExecResult,
  type ParentRpcWrite,
  // Subordinate teams + cross-workspace peers + the report spine
  type TeamToolDeps, type PeersToolDeps, type ReportToolDeps,
  SubordinateRosterStore, createTeamToolDeps, receiveSubordinateEvent,
  type SubordinatesChangedEvent, type SubordinateReportStatus, type SubordinateReportOrigin,
  slugifyName,
  // The subordinate tree's depth cap — derived per child, never stated by one
  DELEGATION_MAX_DEPTH,
  delegationExhausted, deriveChildDelegationBudget, type DelegationBudget,
  type DynamicDelegate,
  readSoul, bootstrapScaffold,
  parseModelSpec, catalogModelInfo,
  // Model-capability attachment sanitization (the PDF-400 fix)
  type MediaModality,
  // Shared catalog view of the resolved model
  ModelCatalogSession,
  // Shared turn-context assembly — the SAME ordering runChat runs on the CLI
  assembleTurnMessages, measureCompactionTrigger,
  // The tool-call pairing invariant — applied wherever messages reach the model
  // WITHOUT going through assembleTurnMessages (the scaffold replay below).
  settleUnpairedToolCalls,
  // AGENTS.md (agents.md standard) — cloud workspace discovery
  collectWorkspaceAgentsMd,
  mergeProviderOptions, reasoningEffortOptions, REASONING_EFFORT_FOR_STAGE,
  uiMessageText, tableExists, PROGRAMMATIC_MESSAGE_ID_PREFIX,
  TURN_AUTHOR_METADATA_KEY, stampTurnAuthor,
  // memory.* / tasks.* — codemode projections of the same-named native tools
  createMemoryCodemodeProvider, createTasksCodemodeProvider,
  JsonObjectSchema, JsonValueSchema, projectJsonValue, type JsonObject, type JsonValue,
} from "@kinu.run/core";
import { bindAgentSql, createCFRuntime, type CFRuntime } from "./runtime";
import { createExecuteToolsTool } from "./execute-tools";
import { createHeadRuntime } from "./head-runtime";
import { spawnNodeFacet } from "./facet-spawn";
import type { AgentProviderRegistry } from "./providers/agent-registry";
import { OwnedModelServices } from "./owned-model-services";
import {
  // Prompt-cache breakpoints — single source in core prompting/cache-breakpoints.ts
  promptCachePlan, hasCacheMarkers, markLastToolForAnthropicCache,
  type PromptCacheStrategy,
} from "@kinu.run/core";
import type { CodemodeProvider, DeferredApprovalChannel } from "@kinu.run/core";
import { diagnostics, KinuError, toKinuError, tolerate } from "@kinu.run/core/obs";
import type { UserDO } from "./user/user-do";
import type { UserCaller } from "./user/workspace-capability";
import { sha256Hex } from "./lib/crypto";
import * as v from 'valibot';

const SESSION_REFLECTION_INTERVAL = 5; // turns between session reflections

interface ClientRpcFrame {
  id: string;
  method: string;
}
interface SettledTurnEvents {
  drainTurnId: string | undefined;
  programmaticUserMessage: UIMessage | null;
  errorText: string | undefined;
  completed: boolean;
  injectedSignals: SettledSignals;
}

interface UserHubCoreClient {
  readonly hasPeerGrant: UserDO['hasPeerGrant'];
  readonly hasWorkspace: UserDO['hasWorkspace'];
  readonly listWorkspaces: UserDO['listWorkspaces'];
  readonly publishExperience: UserDO['publishExperience'];
  readonly searchExperience: UserDO['searchExperience'];
  readonly getExperienceEntry: UserDO['getExperienceEntry'];
  readonly getReleaseBoard: UserDO['getReleaseBoard'];
  readonly upsertReleaseSource: UserDO['upsertReleaseSource'];
  readonly createReleaseChange: UserDO['createReleaseChange'];
  readonly updateReleaseChange: UserDO['updateReleaseChange'];
  readonly transitionReleaseChange: UserDO['transitionReleaseChange'];
  readonly recordReleaseCheck: UserDO['recordReleaseCheck'];
  readonly requestReleaseApproval: UserDO['requestReleaseApproval'];
  readonly recordReleaseDeployment: UserDO['recordReleaseDeployment'];
  readonly getReleaseDetail: UserDO['getReleaseDetail'];
  readonly decideReleaseApproval: UserDO['decideReleaseApproval'];
  readonly getAuthHeaders: UserDO['getAuthHeaders'];
  readonly listCredentials: UserDO['listCredentials'];
  readonly getCredentialBaseURL: UserDO['getCredentialBaseURL'];
  readonly setWorkspaceDisplayName: UserDO['setWorkspaceDisplayName'];
  readonly deviceRpc: UserDO['deviceRpc'];
  readonly getProfile: UserDO['getProfile'];
  readonly getConfig: UserDO['getConfig'];
  readonly registerWorkspace: UserDO['registerWorkspace'];
  readonly reserveWorkspace: UserDO['reserveWorkspace'];
  readonly releaseWorkspaceReservation: UserDO['releaseWorkspaceReservation'];
  readonly ensureWorkspaceCapability: UserDO['ensureWorkspaceCapability'];
  readonly removeWorkspace: UserDO['removeWorkspace'];
}

export interface UserHubClient extends UserHubCoreClient {
  userMcp_updatedAt(caller: UserCaller): Promise<number>;
  userMcp_toolDescriptors(caller: UserCaller): Promise<string>;
  userMcp_callTool(
    caller: UserCaller,
    serverId: string,
    name: string,
    args: JsonObject,
  ): Promise<string>;
}

type UserHubRpcClient = UserHubClient & Pick<Fetcher, 'fetch'>;
const ClientRpcFrameSchema = v.object({
  type: v.literal('rpc'), id: v.string(), method: v.string(), args: v.array(JsonValueSchema),
});
const McpToolSurfaceSchema = v.object({
  descriptors: v.array(SerializableToolDescriptorSchema),
  unavailable: v.array(v.object({ server: v.string(), reason: v.string() })),
});

function parseClientRpcFrame<Message>(message: Message): ClientRpcFrame | null {
  if (!v.is(v.string(), message)) return null;
  const json = tolerate<unknown>(() => JSON.parse(message), 'malformed-input');
  if (json === undefined) return null;
  const frame = v.safeParse(ClientRpcFrameSchema, json);
  return frame.success ? { id: frame.output.id, method: frame.output.method } : null;
}


function jsonObject<Input>(input: Input): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, input);
  return parsed.success ? parsed.output : {};
}

async function* projectDefaultInference<Chunk>(stream: AsyncIterable<Chunk>) {
  for await (const chunk of stream) yield { value: projectJsonValue({ value: chunk }) };
}

/** Extract plain text from the last user message in a ModelMessage[]. Used
 *  by skills resolution to look for `/skill-name` invocations and keyword
 *  matches without needing to know the AI SDK content-part union shape.
 *  Deliberately text-only: file/image attachment parts are dropped here, but
 *  they still reach the model — the evolved-scaffold path hands this flattened
 *  text to the scaffold as `task` while `host.defaultInference()` streams the
 *  prepared turn with all parts intact (see _transformInferenceResult). */
export function extractLastUserText(messages: ReadonlyArray<ModelMessage>): string {
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

/**
 * Turn continuity for the arriving message (core's TurnContinuity). The CLI's
 * one-shot surfaces (`kinu exec`/`kinu run` against a cloud workspace)
 * stamp `oneShot` on the chat request body: each invocation is an independent
 * task by a process that never saw the previous answer, so its prompt is not a
 * verdict on the previous turn. Everything else — the web chat, the API, the
 * REPL over this socket — is a real conversation.
 */
function readTurnContinuity(body?: JsonObject): TurnContinuity {
  return body?.oneShot === true ? 'independent_task' : 'conversation';
}

type UserModelMessage = Extract<ModelMessage, { role: 'user' }>;

function withCliCwdContext(messages: ReadonlyArray<ModelMessage>, cwd: string): ModelMessage[] {
  const prefix = `Current terminal working directory: ${cwd}\n\n`;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const next = [...messages];
    next[i] = {
      ...message,
      content: prefixCliCwdContent(message.content, prefix),
    };
    return next;
  }
  return [...messages];
}

function prefixCliCwdContent(content: UserModelMessage['content'], prefix: string): UserModelMessage['content'] {
  if (v.is(v.string(), content)) return `${prefix}${content}`;
  if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
  return prefix;
}

/** One activity-log line per compaction engine event: message + compact JSON. */
function compactionLogDetail<Data>(message: string, data?: Data): string {
  if (data === undefined) return message;
  try {
    return `${message} ${JSON.stringify(data)}`;
  } catch {
    return message;
  }
}

/** The per-actor-class tool deps `getRawTools` wires into the shared
 *  builtin factory. Structural absence IS the gate: a tool whose deps an
 *  actor class does not wire neither exists in the ToolSet nor is advertised
 *  in the prompt (actorActiveTools). */
export interface ActorToolDeps {
  /** In-workspace subordinate management. Wired by `teamProfile()` on EVERY
   *  actor that still has tree left below it — a subordinate tree is recursive
   *  — and absent at the depth cap. */
  team?: TeamToolDeps;
  /** Cross-workspace peer messaging — orchestrator-only, because
   *  `hire scope=workspace` mints the root of a fresh tree (see
   *  AgentsToolDeps.peers in core tools/agents-tool.ts). */
  peers?: PeersToolDeps;
  /** Subordinate → parent progress spine — subordinate-only. */
  report?: ReportToolDeps;
  releases?: ReleaseToolDeps | undefined;
  /** Orchestrator-owned plan review submitter. Present structurally on the
   *  workspace actor, then surfaced only when this turn is in Plan mode. */
  submitPlan?: SubmitPlanToolDeps;
}

/** The deps-gated builtins: names dropped from the advertised tool surface
 *  when the actor profile wires no deps for them. The `agents` tool is never
 *  dropped on cf — every actor has the fork substrate — but its ACTIONS gate
 *  on the same profile (see actorAgentsActions). `release` is not a native
 *  tool anymore (release.* is codemode-only — see extraCodemodeProviders
 *  above), so `deps.releases` no longer gates anything here; it still feeds
 *  that codemode namespace directly. */
const DEPS_GATED_TOOLS = ['report'] as const;

/** ACTIVE_TOOLS filtered to what this actor's deps actually wire — the prompt
 *  and the activeTools whitelist must not advertise structurally absent
 *  tools. */
export function actorActiveTools(deps: ActorToolDeps): BuiltinToolName[] {
  const present = {
    report: !!deps.report,
  } satisfies Record<(typeof DEPS_GATED_TOOLS)[number], boolean>;
  return ACTIVE_TOOLS.filter((name) => name !== 'report' || present.report);
}

/** The `agents` actions this actor profile supports, for the prompt's
 *  Delegation ladder — the same gating rule the tool's enum uses. Fork is
 *  universal on cf (every ActorAgent owns the strategy registry + facet
 *  substrate); hiring and peer converse ride the actor profile. */
export function actorAgentsActions(deps: ActorToolDeps): AgentsToolAction[] {
  return agentsActionsFor({ fork: {}, team: deps.team, peers: deps.peers });
}

export abstract class ActorAgent extends Think<Env> {
  // ── The actor profile — what a concrete actor class supplies ─────────
  // The rest of this class is actor-agnostic; these members are the whole
  // difference between actor kinds (orchestrator vs a future facet actor).

  /** Owner userId, or null while unclaimed — the actor's identity bootstrap.
   *  The orchestrator reads workspace_identity; a facet actor reads the
   *  owner row its parent seeded. */
  protected abstract getOwnerUserId(): string | null;

  /** The workspace whose exec planes (authoritative workspace, sandbox,
   *  /pc device consent) this actor rides. A top-level workspace DO is its
   *  own workspace; a facet actor overrides with its parent's name. */
  protected workspaceName(): string { return this.name; }

  protected shellId(): string { return `agent:${this.name}`; }

  /** The default agent owns the workspace's canonical scaffold. Facet actors
   * override this with an actor-private path inside the same workspace. */
  protected scaffoldPath(): string { return 'scaffold/agent.js'; }

  /** This actor's proof of workspace identity to the owner's UserDO. A
   *  top-level workspace DO holds its own token; a facet actor holds a pushed
   *  copy of its PARENT's, which is why every facet of a workspace is
   *  attenuated exactly as the workspace is, with no per-facet bookkeeping to
   *  forget. Null before the Worker has claimed the workspace and issued one.
   *
   *  Stored in its own table rather than agent_config: it is identity, not
   *  configuration, and must not be reachable through any config or snapshot
   *  surface. There is deliberately no RPC that reads it back out — the token
   *  only ever travels parent -> facet, so nothing name-addressable can be
   *  asked for another workspace's secret. */
  protected async workspaceCapabilityToken(): Promise<string | null> {
    // A plain read. It used to create the table it selects from and swallow
    // every failure as `null`, which is what made a missing `workspace_capability`
    // read as "this workspace holds no token" — indistinguishable from the truth,
    // and the reason nobody noticed the table had no owner. The constructor owns
    // it now (`initCapabilitySchema`), so a failure here is a real failure.
    const rows = this.sql<{ token: string }>`SELECT token FROM workspace_capability LIMIT 1`;
    return rows[0]?.token || null;
  }

  /** The hash of the token this workspace holds, or null when it holds none.
   *  Safe to hand out — it is what lets the owner's UserDO detect that the two
   *  sides disagree without either of them exchanging the secret. */
  protected async workspaceCapabilityHash(): Promise<string | null> {
    const token = await this.workspaceCapabilityToken();
    return token ? sha256Hex(token) : null;
  }

  /** Install the capability token the owner's UserDO minted for this
   *  workspace. Worker-side DO RPC only — deliberately not `@callable`. */
  async installWorkspaceCapability(token: string): Promise<{ ok: true }> {
    if (!token) throw new Error('capability token required');
    // A native DO RPC does not route through partyserver, so it can land before
    // `onStart` has run — the same race `OrchestratorAgent.claimOwner` handles
    // this way. Flag-gated, so it is a no-op once the activation is initialized.
    this.ensureSchema();
    void this.sql`INSERT INTO workspace_capability (id, token) VALUES (1, ${token})
             ON CONFLICT(id) DO UPDATE SET token = excluded.token`;
    this.invalidateModelCaches();
    // …then push it down this actor's own subtree. Facets present the PARENT
    // workspace's identity, so the token travels down rather than being read
    // back out of a DO — nothing name-addressable ever hands the secret to a
    // caller. Recursive by construction: each hire re-enters here for its own
    // hires, so a reissued token reaches the whole tree, not just its first row.
    const facet = this.subordinateFacet();
    for (const entry of this.subordinateRoster.list()) {
      try {
        const stub = await this.subAgent(facet, entry.name);
        await stub.installWorkspaceCapability(token);
      } catch (err) {
        diagnostics.failure('capability.subordinate_push_failed', toKinuError({
          doing: 'pushing the workspace capability token to a subordinate',
          cause: err,
          otherwise: 'unavailable',
        }), { subordinate: entry.name });
      }
    }
    return { ok: true };
  }

  /** The workspace's identity table. Created from the constructor rather than a
   *  root's `ensureSchema()` because the constructor is the only point guaranteed
   *  to precede every read and write of it on BOTH cf roots: the SDK does not
   *  guarantee `onStart` runs before an RPC (see `OrchestratorAgent.claimOwner`),
   *  and the orchestrator installs a token into a subordinate by a direct DO RPC
   *  that enters no root's `ensureSchema`.
   *
   *  It earns that placement the hard way: it used to be created lazily by
   *  `workspaceCapabilityToken()`, i.e. by a READ performing DDL, and its only
   *  reliable creator turned out to be `onStart`'s scaffold probe failing on its
   *  way into the workspace filesystem. A table that exists because an unrelated
   *  call threw is a table with no owner.
   *
   *  Per-root by design — `cli` has no user plane, so core's
   *  `initWorkspaceSchema` must NOT own it: `core/conformance/manifest.ts`
   *  declares `workspace_capability` WIRED for cf-orchestrator and cf-subordinate
   *  and absent for cli. */
  private initCapabilitySchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_capability (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL
    )`);
  }

  /** Every table this root carries, created before any read. Declared here
   *  because `installWorkspaceCapability` — a native DO RPC reachable before
   *  `onStart` — has to be able to demand it. */
  protected abstract ensureSchema(): void;

  /** Tool deps only this actor class wires. Structural absence is the gating
   *  mechanism (the same way hiring is absent on the CLI backend): an actor
   *  that returns {} has no roster/peer actions and no release tool. */
  protected abstract actorToolDeps(): ActorToolDeps;

  /** Codemode providers beyond the shared set. Spliced between `rlm` and
   *  `web` so provider order — and therefore the LLM-visible type
   *  description — is stable across actor kinds. */
  protected extraCodemodeProviders(): CodemodeProvider[] { return []; }

  /** The evolution engine the shared AgentOrchestrator drives. */
  protected abstract get engine(): EvolutionEngine;

  /** The promotion gate's two ports, over this actor's control plane — the
   *  engine config every actor's engine must carry. Here rather than in each
   *  subclass's constructor for the same reason `settleCompletedTurn` is:
   *  a facet that queues trials but wires no runner stalls on the first
   *  proposal it makes, and one that wires neither scores none at all. */
  protected get shadowTrialPorts(): Pick<EvolutionConfig, 'shadowTrialQueue' | 'shadowTrialRunner'> {
    return {
      shadowTrialQueue: (turn) => queueTurnShadowTrial(this.scaffoldControl, turn),
      shadowTrialRunner: () => runQueuedShadowTrials(this.scaffoldControl),
    };
  }

  /** Out-of-band owner notification (mission-inbox email on the
   *  orchestrator). Fired when a background job settles. */
  protected abstract notifyOwner(subject: string, body: string): void;

  /** Browser/socket-only RPC policy. Durable Object stub calls do not pass
   * through onMessage, so subclasses can keep bootstrap methods available to
   * trusted worker callers while denying the same method to client sockets. */
  protected isClientRpcMethodDenied(_method: string): boolean { return false; }

  // ── The subordinate tree ────────────────────────────────────────────
  // Hoisted here from the orchestrator when `hire` became recursive: an actor
  // that can hold a roster is not a kind of actor, it is every actor with tree
  // left below it. The orchestrator is depth 0, a subordinate reads its own
  // depth off the immutable identity row its parent seeded, and both run the
  // identical roster/ingress/broadcast machinery — there is no second
  // implementation to drift.

  /** This actor's position in the workspace's subordinate tree, and the room
   *  left below it. The orchestrator answers with the root budget; a facet
   *  actor answers from durable storage, so an eviction cannot reset it. */
  protected abstract delegationBudget(): DelegationBudget;

  /** The facet class a hire runs as. Supplied by each concrete root because the
   *  base class must not import its own subclass — the TYPE is imported (and
   *  erased), the VALUE comes from here. */
  protected abstract subordinateFacet(): SubAgentClass<SubordinateAgent>;

  /** Exploration facets (heads, branches, swarm nodes) of this actor. The VALUE
   *  lives here rather than in facet-spawn.ts so that helper carries no runtime
   *  import of the class it spawns — that import closed a cycle through
   *  runtime.ts and head-runtime.ts. */
  explorationFacet(): SubAgentClass<ExplorationAgent> { return ExplorationAgent; }

  /**
   * The roster half of the actor profile — wired only while this actor has room
   * below it.
   *
   * At the cap the deps are ABSENT rather than present-and-refusing, so
   * hire/ask/send/list/dismiss are not in the tool enum, not in the codemode
   * namespace and not in the prompt's ladder. That is this repo's structural
   * containment doctrine and the stronger of the two mechanisms in use: a tool
   * that is not there cannot be attempted. It is also what oh-my-pi does
   * (`canSpawnAtDepth` drops `task` below its cap) rather than what dsh does
   * (keeps the tool and throws a typed SubagentDepthError).
   *
   * The classified refusal in core's dispatch is NOT a second opinion on the
   * same question — it covers the one window absence cannot: a ToolSet is cached
   * across turns and a facet's identity is seeded after it is constructed, so a
   * build that ran before the seed could offer `hire` to an actor that turns out
   * to be at the cap. Absence for the steady state, a reason for the seam that
   * absence cannot reach; and the prompt states the cap for an actor sitting on
   * it, so silence is never the whole answer.
   */
  protected teamProfile(): Pick<ActorToolDeps, 'team'> {
    return delegationExhausted(this.delegationBudget()) ? {} : { team: this.getTeamToolDeps() };
  }

  private _subordinateRoster: SubordinateRosterStore | null = null;

  protected get subordinateRoster(): SubordinateRosterStore {
    if (!this._subordinateRoster) {
      this._subordinateRoster = new SubordinateRosterStore(this.ctx.storage.sql);
      this._subordinateRoster.ensureSchema();
    }
    return this._subordinateRoster;
  }

  /** This actor's hires, for the per-step dynamic context. */
  protected subordinateDelegates(): DynamicDelegate[] {
    return this.subordinateRoster.list().map((entry) => ({
      kind: 'subordinate' as const,
      name: entry.name,
      phase: entry.status,
      task: entry.currentTask,
    }));
  }

  protected broadcastSubordinatesChanged(event?: SubordinatesChangedEvent): void {
    this.broadcast(JSON.stringify(event ?? {
      type: 'subordinates_changed',
      subordinates: this.subordinateRoster.list(),
    }));
  }

  protected broadcastSubordinateEvent(
    event: Omit<SubordinateActivityEvent, 'type' | 'id'> & { id?: string },
  ): void {
    this.broadcast(JSON.stringify({
      type: 'subordinate_event',
      id: event.id ?? nanoid(),
      kind: event.kind,
      subordinate: event.subordinate,
      status: event.status,
      content: event.content,
      task: event.task,
      timestamp: event.timestamp,
    } satisfies SubordinateActivityEvent));
  }

  /** A facet is reachable only while its own roster still lists it. */
  override async onBeforeSubAgent(
    request: Request,
    child: { className: string; name: string },
  ): Promise<Request | Response | void> {
    if (child.className !== this.subordinateFacet().name) {
      return new Response('Not found', { status: 404 });
    }
    const rosterEntry = this.subordinateRoster.get(child.name);
    if (!rosterEntry || rosterEntry.status === 'dismissed'
      || !this.hasSubAgent(child.className, child.name)) {
      return new Response('Not found', { status: 404 });
    }
    return request;
  }

  protected getTeamToolDeps(): TeamToolDeps {
    const facet = this.subordinateFacet();
    return createTeamToolDeps({
      delegation: this.delegationBudget(),
      roster: this.subordinateRoster,
      now: () => Date.now(),
      inheritedContext: () => this.readInheritedContext(),
      createName: (role) => {
        const base = slugifyName(role).slice(0, 48) || 'subordinate';
        return `${base}-${nanoid(6)}`;
      },
      broadcast: (event) => this.broadcastSubordinatesChanged(event),
      broadcastTask: (event) => this.broadcastSubordinateEvent({
        kind: 'task',
        ...event,
      }),
      runtime: {
        spawn: async (input) => {
          const ownerUserId = this.getOwnerUserId();
          if (!ownerUserId) throw new Error('Agent has no owner yet — subordinate creation needs an owned workspace.');
          const stub = await this.subAgent(facet, input.name);
          const capabilityToken = await this.workspaceCapabilityToken();
          try {
            const identity = {
              name: input.name,
              displayName: input.displayName,
              role: input.role,
              mission: input.mission,
              model: input.model,
              capabilityToken: capabilityToken ?? undefined,
            };
            await stub.setSubordinateIdentity(identity);
          } catch (error) {
            // A cleanup path that discards its own failure cannot be trusted to
            // have cleaned up. `deleteSubAgent` is what WIPES the half-seeded
            // facet's storage, so a swallowed failure here leaves a permanent
            // database inside this DO charged against the quota every facet
            // shares — reported with the seeding failure as its cause, never
            // hidden behind it.
            try {
              await this.deleteSubAgent(facet, input.name);
            } catch (cleanupError) {
              throw new Error(
                `Subordinate ${input.name} failed to seed and its storage could not be reclaimed: `
                + `${renderThrownChain({ cause: cleanupError })}`,
                { cause: error },
              );
            }
            throw error;
          }
        },
        assign: async (name, input) => {
          const stub = await this.subAgent(facet, name);
          const task = {
            kind: 'task',
            body: input.body,
            mode: input.mode,
            deliverable: input.deliverable,
            deadlineHint: input.deadlineHint,
            inheritedContext: input.inheritedContext,
          } as const;
          return stub.enqueueSubordinateTask(task);
        },
        status: async (name) => (await this.subAgent(facet, name)).getSubordinateStatus(),
        message: async (name, content, mode) => {
          return (await this.subAgent(facet, name))
            .enqueueSubordinateTask({ kind: 'message', body: content, mode });
        },
        dismiss: async (name, keepHistory) => {
          if (!keepHistory) await this.deleteSubAgent(facet, name);
        },
      },
    });
  }

  /**
   * Facet bootstrap authority. Worker-side DO RPC only. The child verifies its
   * supplied owner/workspace against this source before persisting its immutable
   * identity row — and takes its DEPTH from here, never from its own arguments.
   *
   * This is the one place a child's depth is decided, which is what makes the cap
   * unbypassable by a subordinate that simply does not check: the number it would
   * have to lie about is one it never supplies. The seeding authority refuses at
   * the cap too, so even a stale ToolSet that offered `hire` cannot produce a
   * child past it.
   */
  async getSubordinateBootstrapIdentity(): Promise<{
    parentWorkspace: string;
    ownerUserId: string;
    model: string | null;
    depth: number;
  }> {
    // Deliberately carries no capability token: this method is reachable by any
    // holder of a stub to this workspace, so it must never hand out a secret.
    // The token reaches subordinates by push (setSubordinateIdentity +
    // installWorkspaceCapability), never by read-back.
    this.ensureSchema();
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) throw new Error('Workspace must be owned before creating subordinates.');
    const own = this.delegationBudget();
    if (delegationExhausted(own)) {
      throw new Error(
        `Delegation depth cap reached: this agent is at depth ${own.depth} of ${DELEGATION_MAX_DEPTH} `
        + 'and cannot seed a subordinate below it.',
      );
    }
    return {
      parentWorkspace: this.workspaceName(),
      ownerUserId,
      model: this.config.getModel(),
      depth: deriveChildDelegationBudget(own).depth,
    };
  }

  /** Subordinate progress ingress. Worker-side DO RPC only: the method is not
   * `@callable`, and the public route exposes only the subordinate's own chat
   * surface. Reports use the same EventLog → drain rail as mission inbox. */
  async receiveSubordinateEvent(input: {
    fromSubordinate: string;
    status: SubordinateReportStatus;
    content: string;
    origin: SubordinateReportOrigin;
    mode: WorkMode;
  }): Promise<{ id: string; admitted: boolean }> {
    this.ensureSchema();
    return receiveSubordinateEvent({
      log: this.eventLog,
      roster: this.subordinateRoster,
      vfs: this.rt.storage.vfs,
      transaction: (body) => this.ctx.storage.transactionSync(body),
      announce: (report) => {
        this.broadcastSubordinatesChanged();
        this.broadcastSubordinateEvent({ ...report, kind: 'report' });
      },
      onAdmitted: () => { this.orch.scheduleDrain(); },
    }, input, Date.now());
  }

  override maxSteps = resolveMaxSteps(this.env.KINU_MAX_STEPS);

  private readonly ownedModelServices = new OwnedModelServices({
    env: this.env,
    agentName: () => this.name,
    appTitle: 'Kinu',
    ownerRequired: true,
    getOwnerUserId: () => this.getOwnerUserId(),
    getUserCaller: () => this.userCaller(),
  });

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Before any read or write of it can happen — see initCapabilitySchema.
    this.initCapabilitySchema();
    // Scoped `pta_…` access tokens reach this DO over ticket-authenticated
    // websockets, and the REST scope gate never sees websocket frames — so
    // out-of-scope @callable requests are rejected here, ahead of the
    // agents-SDK rpc dispatcher (installed as an own-property onMessage
    // wrapper by the Agent constructor, hence the re-wrap instead of an
    // onMessage override). Chat frames pass through untouched.
    const dispatchMessage = this.onMessage;
    this.onMessage = async (connection, message) => {
      const rejection = rejectOutOfScopeRpc(connection.tags, message);
      if (rejection) {
        connection.send(rejection);
        return;
      }
      const rpc = parseClientRpcFrame(message);
      if (rpc && this.isClientRpcMethodDenied(rpc.method)) {
        connection.send(JSON.stringify({
          type: 'rpc',
          id: rpc.id,
          success: false,
          error: `${rpc.method} is not available from client connections.`,
        }));
        return;
      }
      const event = v.is(v.string(), message) ? parseProtocolMessage(message) : null;
      try {
        return await dispatchMessage.call(this, connection, message);
      } finally {
        if (event?.type === 'clear') {
          this.dynamicLedger.reset();
          this._pendingDrainReplyTurns.clear();
          try {
            await this.compactionState.plans.save(this.name, null);
          } catch (err) {
            diagnostics.failure('compaction.reset_failed', toKinuError({
              doing: 'clearing the persisted compaction plan after clear-history',
              cause: err,
              otherwise: 'io',
            }), { workspace: this.name });
          }
        }
      }
    };
    // Constructor body (not a field initializer): boundSql's memo field must
    // be initialized before the getter caches its closure.
    this.compactionState = createCompactionStateStore(this.boundSql);
    this.registerCompactionExtension();
    // The user steer-drain registers BEFORE the orchestrator's signal
    // extension: a signal splice must never shift the indices the user-steer
    // drain replays into durable history (the same ordering the CLI's
    // ExtensionHost uses).
    this.extensions.register({
      name: 'kinu.user-steer',
      prepareStep: (ctx) => this.userSteer.prepareStep(ctx),
    });
    // The orchestrator's per-turn extension: the turn steering's observation
    // hooks plus the ONE mid-turn signal drain every producer feeds. Forwarded
    // through closures because `orch` is built lazily and this runs in the
    // constructor.
    this.extensions.register({
      name: 'kinu.signals',
      onToolCall: (ctx) => this.orch.turnExtension.onToolCall?.(ctx),
      onToolResult: (ctx) => this.orch.turnExtension.onToolResult?.(ctx),
      prepareStep: (ctx) => this.orch.turnExtension.prepareStep?.(ctx),
    });
  }

  /** The settled turn's actor-generic front half — every actor's
   *  onChatResponse calls this FIRST (before anything that can throw or
   *  return early). Resolves the drain identity, clears in-flight turn
   *  state, and settles mid-turn signal delivery: absorbed signals keep their
   *  reply dispatch with this turn's answer, and whatever the model never saw
   *  re-delivers through the same seam (which queues it, since the turn is
   *  over) — so the event card and reply dispatch work unchanged. */
  protected settleTurnEvents(result: ChatResponseResult): SettledTurnEvents {
    const drainTurnId = this._activeDrainTurnId ?? this._pendingDrainReplyTurns.get(result.requestId);
    const programmaticUserMessage = this._activeProgrammaticUserMessage;
    this._activeDrainTurnId = null;
    this._activeProgrammaticUserMessage = null;
    // Persist the provider error TEXT, not just the status — Think keeps only
    // the LAST terminal error, which the next failure overwrites, so this row
    // (and the run_end event in recordTurnTelemetry) is the durable evidence
    // trail.
    const errorText = result.error?.slice(0, 500);
    this.logActivity("response_complete", errorText ? `${result.status} — ${errorText}` : result.status);
    // Clear the in-flight flag once the turn is durably completed — forkAgent
    // is allowed again from here forward. Evolution (the orchestrator's detached engine.reviewTurn)
    // runs fire-and-forget and does NOT extend the busy window.
    this._inFlight = false;
    this._cliCwd = null;
    // Order matters: the flag is already clear, so the leftover steer enqueues
    // as a turn of its own instead of buffering for a turn that is over.
    this.rerunLeftoverSteers();
    const completed = result.status === 'completed';
    const injectedSignals = this.orch.signals.settle({ completed });
    return { drainTurnId, programmaticUserMessage, errorText, completed, injectedSignals };
  }

  /**
   * Accept a message the user typed while a turn is running. `'idle'` means no
   * turn was there to steer and the CALLER still owns the text — it must send
   * it as an ordinary turn, because nothing was buffered here.
   *
   * `'mid-turn'` is announced immediately, before the model has it: the person
   * who pressed Enter needs to know their words were taken and are waiting for
   * the next step, which is a different fact from "the model read them"
   * (announced again, as `landed`, when the drain actually happens). The id is
   * minted HERE and carried through both announcements and the durable row, so
   * a surface tracking a steer never sees the same one twice under two names.
   */
  protected acceptUserSteer(text: string): UserSteerOutcome {
    const body = text.trim();
    if (!body) throw new Error('steerTurn requires the message text');
    const id = `steer-${nanoid(12)}`;
    const outcome = this.userSteer.accept({ id, text: body });
    if (outcome === 'mid-turn') {
      this.broadcastSteerStatus({ status: 'queued', steerId: id, text: body });
      this.logActivity('steer_queued', body.slice(0, 120));
    }
    return outcome;
  }

  /**
   * A drain happened: the model has these steers as of the step now starting.
   *
   * Each becomes a VERBATIM user row in the session tree — `addMessages`
   * appends without enqueuing a turn and is explicitly safe from inside a live
   * one, and the row parents off the current leaf (the message that started
   * this turn), so the assistant answer chains after it. That chain is what
   * makes the walk-back fork able to cut at a steer, exactly as it can on the
   * CLI (local-session persist()).
   *
   * The row keeps the steer's own id, so the live chip and the durable message
   * are the same thing to the chat pane and it renders one, never both.
   *
   * It also keeps `atStep`. A turn is ONE assistant message — Think persists it
   * once, after the stream drains — so a row appended beside it sorts before or
   * after the whole turn and nowhere else. The step index is the only durable
   * statement of where inside the turn the model actually read this, and both
   * the live splice and the reloaded transcript place the bubble from it.
   */
  private recordLandedSteers(steers: readonly UserSteer[], atStep: number): void {
    for (const steer of steers) {
      if (steer.id) this.broadcastSteerStatus({ status: 'landed', steerId: steer.id, text: steer.text, atStep });
    }
    void this.addMessages(steers.map((steer) => ({
      id: steer.id ?? `steer-${nanoid(12)}`,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: steer.text }],
      metadata: { [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: atStep },
    }))).catch((err) =>
      diagnostics.failure('steer.persist_failed', toKinuError({
        doing: 'persisting a mid-turn steer as a durable user row',
        cause: err,
        otherwise: 'io',
      }), { steers: steers.length }));
  }

  /**
   * Drop the in-flight turn's pending steers and hand their texts back — the
   * abort path's half of the steer contract (core cancelCurrentWork calls this
   * through `interruptSteers`). Stop means stop; it does not mean "stop and
   * then do what I typed". But the surface already rendered them as sent, so
   * they come back to the composer rather than disappearing.
   */
  protected interruptUserSteers(): string[] {
    const dropped = this.userSteer.interrupt();
    for (const steer of dropped) {
      if (steer.id) this.broadcastSteerStatus({ status: 'returned', steerId: steer.id, text: steer.text });
    }
    return dropped.map((steer) => steer.text);
  }

  /** The one place a steer's lifecycle reaches connected surfaces. Written as a
   *  literal so the broadcast-wiring gate can see the channel it must prove has
   *  a consumer. */
  private broadcastSteerStatus(detail: SteerStatusDetail): void {
    this.broadcast(JSON.stringify({ type: 'steer_status', ...detail } satisfies SteerStatusEvent));
  }

  /**
   * Steers that never saw a step boundary (the model was already writing its
   * final answer) rerun as a USER-origin turn. It carries the operator's own
   * words, so it says so: without the stamp the enqueue seam would read a row
   * with no author and the programmatic id prefix it gives every row, and file
   * the operator's sentence as the harness's. Detached: a turn must never block
   * on the next one's queue slot.
   */
  private rerunLeftoverSteers(): void {
    const leftover = this.userSteer.takeLeftover();
    if (leftover.length === 0) return;
    void this.host.enqueueTurn({
      text: leftover.map((steer) => steer.text).join('\n\n'),
      metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator' },
    })
      .catch((err) =>
        diagnostics.failure('steer.rerun_failed', toKinuError({
          doing: 'enqueuing leftover steers as their own user turn',
          cause: err,
          otherwise: 'io',
        }), { steers: leftover.length }));
  }

  /** The settled turn's telemetry — the measured compaction trigger, the
   *  shared overflow-recovery policy, and the durable turn_end/run_end
   *  events. Runs for completed AND aborted/errored turns. */
  protected recordTurnTelemetry(result: ChatResponseResult, turn: {
    errorText: string | undefined;
    completed: boolean;
    programmaticUserMessage: UIMessage | null;
  }): void {
    const { errorText, completed, programmaticUserMessage } = turn;
    // The NEXT turn's measured compaction trigger (core turn-lifecycle).
    persistMeasuredPromptTokens(this.compactionState, this.name, this.acc.lastPromptTokens, this._turnDurableLength);
    // Overflow recovery — the shared core policy, APPLIED by the shared core
    // helper (arm force-compaction + at most one retry enqueue).
    if (!completed && result.error) {
      const recovery = applyOverflowRecovery({
        error: result.error,
        lastPromptTokens: this.acc.lastPromptTokens,
        contextWindow: this._turnContextWindow > 0 ? this._turnContextWindow : this.sessionContextWindow(),
        turnWasOverflowRetry: this.turnUserMessageEvent(programmaticUserMessage) === OVERFLOW_RETRY_EVENT,
        state: this.compactionState,
        sessionKey: this.name,
        signals: this.orch.signals,
      });
      if (recovery.forceCompaction) {
        this.logActivity('overflow_detected',
          `${recovery.failureClass} — force compaction armed${recovery.enqueueRetry ? ', retry enqueued' : ''}`);
      }
    }
    // Seal the durable run: turn_end + run_end (core turn-lifecycle).
    if (this._currentRunId) {
      closeTurnRun(this.eventRecorder, this._currentRunId, {
        turnIndex: this.orch.sessionTurnIndex,
        usage: this.acc.usage,
        context: this.acc.context,
        files: this.acc.files,
        escalations: this.acc.escalations,
        steering: this.orch.steering.snapshot(),
        craft: this.orch.craft.snapshot(),
        recoveries: this.orch.recoverySnapshot(),
        reason: result.status,
        error: errorText,
      });
    }
  }

  /** Durable per-session compaction state (plan snapshot + the measured
   *  prompt-token trigger signal) in DO SQLite. Table created in ensureSchema. */
  protected readonly compactionState: CompactionStateStore;

  /** Durable-history length (ModelMessage count) at the in-flight turn's
   *  assembly — the length the turn's prompt-token measurement is bound to. */
  protected _turnDurableLength = 0;

  /** `agent.compactNow()` — the agent folding a finished phase itself instead
   *  of waiting for the token trigger. It rides the SAME one-shot flag
   *  overflow recovery arms, so there is one forced-rebuild path and a repeat
   *  call can never loop the ladder. The in-flight turn's context is already
   *  assembled, so the fold lands on the next one. */
  armCompactNow(): void {
    this.compactionState.armForceCompaction(this.name);
  }

  /** Better-compact is THE default (and only) compaction path: the staged
   *  pruning ladder runs as a transformContext extension once per turn
   *  assembly, replaying its persisted plan byte-stably until the context
   *  regrows. Registered unconditionally at construction; every port
   *  dereferences `this` lazily, so nothing heavy (the CF runtime, the model)
   *  is built before it is first needed. */
  private registerCompactionExtension(): void {
    const logger: CompactionLogger = {
      info: (message, data) => this.logActivity('compaction', compactionLogDetail(message, data)),
      debug: (message) => diagnostics.event('compaction.debug', { message }),
      // `degraded`/`failed` rather than `warn`/`error`: a level is not an outcome, and these two names
      // are shared verbatim with `cli-backend/src/local-session.ts`, which adapts the same
      // `@better-compact/core` Logger port to the same outcomes. One query reads both backends.
      warn: (message, data) => {
        diagnostics.failure('compaction.degraded', new KinuError('unavailable', message));
        this.logActivity('compaction_warn', compactionLogDetail(message, data));
      },
      error: (message, data) => {
        diagnostics.failure('compaction.failed', new KinuError('io', message));
        this.logActivity('compaction_error', compactionLogDetail(message, data));
      },
    };
    this.extensions.register(createCompactionExtension({
      ports: {
        transcripts: createVfsTranscriptStore(() => this.rt.storage.vfs),
        plans: this.compactionState.plans,
        logger,
      },
      archive: this.compactionState.archive,
      // The sink the summarizer already accepts, finally passed. `compaction`
      // was a declared SPEND_SOURCE that could never appear in the panel:
      // folding history is the producer that fires precisely when a
      // conversation got expensive, so the workspace total understated exactly
      // the sessions an owner asks about.
      summarize: createModelSummarizer(() => this.getModel(), undefined, {
        source: 'compaction', report: (report) => this.reportModelCall(report),
      }),
      // The ladder's first rung prunes this plane before any tool output.
      ephemeral: this.dynamicLedger,
      onOutcome: ({ outcome }) => {
        // The model-visible stream changed shape — a NEW plan rewrote it
        // ('planned') or a cached plan was discarded after a history rewrite
        // ('invalidated') — so the dynamic ledger's frozen block positions
        // are meaningless. This fires inside runTransformContext, BEFORE the
        // turn's first step weave, so the next weave starts over with one
        // fresh block at the tail. A byte-stable replay keeps positions valid.
        if (outcome !== 'replayed') this.dynamicLedger.reset();
      },
    }));
  }

  /** Persist the verified connect-ticket scopes (edge-set header, see
   *  appendIdentityHeaders) as a connection tag — tags ride the WebSocket
   *  attachment, so the rpc gate survives DO hibernation. */
  override async getConnectionTags(connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const tags = await super.getConnectionTags(connection, ctx);
    const scopeTag = cliScopesConnectionTag(ctx.request.headers.get(CLI_SCOPES_HEADER));
    return scopeTag ? [...tags, scopeTag] : tags;
  }

  /** Scoped access-token connections may chat but never write agent state. */
  override shouldConnectionBeReadonly(connection: Connection, ctx: ConnectionContext): boolean {
    return super.shouldConnectionBeReadonly(connection, ctx)
      || !!ctx.request.headers.get(CLI_SCOPES_HEADER);
  }

  private _rt: CFRuntime | null = null;
  /** Backend-agnostic per-turn accounting (tool calls, steps, usage, errors).
   *  Lazily built with cf sinks → activity_log + the durable run-event recorder.
   *  Shared with the CLI backend (core/orchestrator/turn-accumulator). */
  // The backend-agnostic agent logic (per-turn accounting + session-evolution
  // cadence + the event→turn reactor). The DO provides the BackendHost
  // (broadcast + programmatic-turn via saveMessages) + the cf sinks. The CLI
  // backend builds the same AgentOrchestrator with its own host.
  private _orch: AgentOrchestrator | null = null;
  protected get orch(): AgentOrchestrator {
    if (!this._orch) {
      this._orch = new AgentOrchestrator({
        host: this.host,
        engine: this.engine,
        eventLog: this.eventLog,
        budget: this.budget,
        sessionReflectionInterval: SESSION_REFLECTION_INTERVAL,
        sinks: {
          logActivity: (e, d) => this.logActivity(e, d),
          onToolCallEvent: (ev) => {
            try {
              if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, { type: 'tool_call_end', ...ev });
            } catch (err) {
              diagnostics.failure('event.tool_call_end_emit_failed', toKinuError({
                doing: 'recording a tool_call_end run event',
                cause: err,
                otherwise: 'io',
              }));
            }
          },
          onStepEvent: (ev) => {
            try {
              if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, { type: 'step_finish', ...ev });
            } catch (err) {
              diagnostics.failure('event.step_finish_emit_failed', toKinuError({
                doing: 'recording a step_finish run event',
                cause: err,
                otherwise: 'io',
              }));
            }
          },
        },
      });
    }
    return this._orch;
  }
  protected get acc(): TurnAccumulator { return this.orch.acc; }

  /** The actor's mission budget governor — the cumulative cap a scheduled run
   *  or a fork opts into. Its refusals land in the run's durable event log next
   *  to `context_budget`; with no active label it costs nothing. Public so the
   *  `agent.*` self-direction namespace declares and reads budgets through the
   *  same object the two enforcement seams hold. */
  private _budget: MissionGovernor | null = null;
  get budget(): MissionGovernor {
    this._budget ??= new MissionGovernor({
      storage: this.rt.storage,
      // Real USD: the catalog rates for whatever model the next turn resolves
      // to. Null until the lookup lands — the ledger then blends, and says so.
      pricing: () => this.modelCatalog.pricing(),
      onExhausted: ({ error: _error, ...refusal }) => {
        try {
          if (this._currentRunId) this.eventRecorder.emit(this._currentRunId, { type: 'budget_exhausted', ...refusal });
        } catch (err) {
          diagnostics.failure('event.budget_exhausted_emit_failed', toKinuError({
            doing: 'recording a budget_exhausted run event',
            cause: err,
            otherwise: 'io',
          }));
        }
      },
    });
    return this._budget;
  }

  /**
   * The mission ledger, reached from a facet.
   *
   * A forked head runs as its own Durable Object with its own storage and its
   * own resolved model, so the governed `LLM` the fork seam wraps never sees
   * the calls it actually makes. These two are the ledger's other end: the head
   * guards before each step and debits after it, over a cross-DO stub back to
   * the actor that declared the budget.
   *
   * NOT `@callable`: cross-DO stub RPC never needed the decorator, and a
   * spend ledger must not be writable over the public WS/HTTP transport. They
   * are also inert without labels — `guard`/`debit` with an empty label set
   * return immediately and touch no storage — so an unbudgeted head that
   * somehow called them would still not create a cap.
   */
  async missionGuard(
    seam: MissionSeam, labels: readonly string[],
  ): Promise<MissionBudgetRefusal | null> {
    return this.budget.guard(seam, labels);
  }

  async missionDebit(tokens: number, opts: {
    labels: readonly string[]; calls?: number; spawns?: number; usage?: Usage;
  }): Promise<void> {
    this.budget.debit(tokens, opts);
  }

  /**
   * A facet's non-turn model call, filed in the ROOT workspace's event log.
   *
   * Same reason the mission ledger and the head journal are reached this way: a
   * facet has its own SQLite, so a row it wrote locally would strand a
   * workspace's spend one Durable Object away from the total that has to
   * account for it. The owner asks what the WORKSPACE cost, and a recursive
   * split's merge synthesis is part of that answer.
   *
   * Not `@callable`, exactly like `missionDebit`: a spend record must not be
   * writable over the public WS/HTTP transport. Allowlisted in rpc-surface.ts.
   */
  async reportFacetModelCall(report: ModelCallReport): Promise<void> {
    this.reportModelCall(report);
  }

  // ── The subtree's head journal, over this actor's control plane ──────
  //
  // A recursive split runs on a facet with its own SQLite, so a journal it
  // wrote locally would strand its rows one DO away from the head_steps they
  // must join against — the C2 defect that made a depth-2 head unreadable.
  // These four are the writes HeadController performs, exposed as the same kind
  // of cross-DO port missionGuard/missionDebit use: worker-side DO RPC reachable
  // on a stub and nowhere else, never `@callable`, allowlisted in rpc-surface.ts.

  async headJournalRecordSplit(rootId: HeadId, rationale: string, spawnedAt: number): Promise<void> {
    this.headJournal.recordSplit(rootId, rationale, spawnedAt);
  }

  async headJournalInsertSpawn(input: HeadInput): Promise<void> {
    this.headJournal.insertSpawn(input);
  }

  async headJournalRecordReport(report: HeadReport): Promise<void> {
    // The announcement is the JOURNAL's now, not this method's. It used to
    // broadcast here, which made a branch's last write — the summary, the status
    // and the wall clock — live for a recursive split and for nothing else,
    // because this RPC is only reachable from a facet calling its parent.
    this.headJournal.recordReport(report);
  }

  async headJournalCacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): Promise<void> {
    this.headJournal.cacheMerge(rootId, result, strategy);
  }

  /** True while a keepAlive heartbeat is holding the DO open for evolution. */
  private _evolutionSettling = false;

  /**
   * Hold the Durable Object open until the evolution this turn dispatched has
   * settled — the cf peer of the CLI's `await orch.settleEvolution()` before
   * process exit.
   *
   * Evolution is deliberately detached so it never blocks Think's TurnQueue,
   * but its LLM calls (outcome classification, reflection, session reflection)
   * take 5-30s and outlive the request that woke the DO. A DO with no pending
   * request and no alarm is evicted, which kills them mid-call — the exact bug
   * that was fixed for headless CLI runs. keepAlive() (agents-SDK) keeps a
   * heartbeat alarm armed while the ref is held, so the activation survives.
   *
   * Fire-and-forget by construction: awaiting it here would re-block the queue.
   * One watcher at a time — settleEvolution() drains whatever is in flight when
   * it runs, so a turn that completes while a watcher is live is already
   * covered by it.
   *
   * BOTH evolution lanes are held open here (core's exit contract): the turn
   * lane via settleEvolution(), and the cadence session-evolution pass via
   * runDueSessionEvolution(). The DO is the host that CAN afford the heavy
   * pass — keepAlive is exactly the mechanism a one-shot CLI process lacks —
   * so unlike `kinu exec` it waits for it rather than carrying it forward.
   */
  protected settleEvolutionInBackground(): void {
    if (this._evolutionSettling) return;
    this._evolutionSettling = true;
    void this.keepAliveWhile(async () => {
      await this.orch.settleEvolution();
      await this.orch.runDueSessionEvolution();
    })
      .catch((err) => diagnostics.failure('evolution.settle_failed', toKinuError({
        doing: 'settling the turn and session evolution lanes',
        cause: err,
        otherwise: 'unavailable',
      })))
      .finally(() => { this._evolutionSettling = false; });
  }

  /**
   * The completed turn's evolution spine — the SINGLE place a settled turn
   * feeds the agent's self-improvement loop, for every actor.
   *
   * `orch.recordTurn` opens the outcome review + session cadence (which is
   * what eventually proposes a new scaffold), `settleEvolutionInBackground`
   * holds the DO open for that detached work, `engine.queueShadowTrial`
   * records this turn as evidence the promotion gate may draw on, and
   * `reviewTurnInBackground` is the advisor. Split across subclasses these
   * drift: a facet that recorded turns but never settled or queued them
   * proposes exactly one scaffold and then stalls forever on it.
   */
  protected settleCompletedTurn(turn: CompletedTurn): void {
    // Evolution hooks make 5-30s LLM calls and onChatResponse runs INSIDE
    // Think's TurnQueue — everything here is detached so the next message is
    // never blocked, and held open by the keepAlive heartbeat instead.
    this.orch.recordTurn(turn, this._turnContinuity);
    this.settleEvolutionInBackground();
    // One row, no inference: the trial itself runs on the cadence lane. The
    // turn's prepared messages are read synchronously (before any await) so a
    // later turn's stash can never bleed into this one's replay.
    this.engine.queueShadowTrial(turn, this._lastTurnOpts?.messages ?? []);
    this.reviewTurnInBackground(turn);
  }

  /**
   * The advisor lane: one review of the turn that just ended.
   *
   * Detached for the same reason the evolution lanes are — it is a model call
   * on a path the turn queue is holding — and held open by the same keepalive.
   * A reviewer that fails leaves a turn with no advice, never a failed turn, so
   * nothing here can reach the caller.
   *
   * Governed off the TURN's labels rather than the governor's active scope, the
   * same way the engine's own review is: this runs after the turn ended, when
   * the active scope is either empty or some later turn's, and debiting a
   * mission for work it did not cause is worse than not debiting at all.
   *
   * There is no completion gate on this backend — it is the one-shot CLI
   * surface's mechanism — so `gateOpen` is false here by construction rather
   * than by omission.
   */
  private reviewTurnInBackground(turn: CompletedTurn): void {
    const llm = this.rt.advisorLlm;
    if (llm === undefined || !this.config.getAdvisorEnabled()) return;
    const labels = turn.missionLabels ?? [];
    void this.keepAliveWhile(() => runAdvisorLane({
      turn,
      llm: labels.length === 0 ? llm : this.budget.govern(llm, labels),
      enabled: true,
      minSeverity: this.config.getAdvisorMinSeverity(),
      recent: this.engine.recentAdvisorNotes(),
      gateOpen: false,
      // The turn's OWN ToolSet keys, read synchronously with the messages beside
      // them: what the actor demonstrably had, not what this actor class can
      // have. A capability the turn never carried must never be named at it.
      reachable: Object.keys(this._lastTurnOpts?.tools ?? {}),
      deliver: (signal) => this.orch.signals.deliver(signal),
      record: (note, turnId) => { this.engine.recordAdvisorNote(note, turnId); },
    })).catch((err) => diagnostics.failure('advisor.review_failed', toKinuError({
      doing: 'reviewing the completed turn',
      cause: err,
      otherwise: 'unavailable',
    })));
  }

  /**
   * The scaffold evolution control plane's view of this actor: the four ports
   * a candidate loop runs against, plus the two models it needs. The plane
   * itself is core's (evolution/control.ts); this is the whole of what being a
   * Durable Object contributes to it.
   *
   * On the substrate rather than on the orchestrator because the shadow trial
   * queue above fills for EVERY actor, and a facet with a control plane it
   * cannot reach would score no proposal at all.
   */
  protected get scaffoldControl(): ScaffoldControl {
    return {
      rt: this.rt,
      sql: this.boundSql,
      config: this.config,
      surface: (task, context) => ({
        llmStream: this.makeScaffoldLLMStream(),
        // The same tool dispatcher the production chat path uses, so a
        // candidate runs with the real tool surface rather than the disabled
        // tool-call fallback that penalizes any tool-using candidate.
        callTool: this.makeScaffoldCallTool(),
        history: this.makeScaffoldHistory(),
        // With a replay context this re-runs the trial turn's OWN conversation
        // — the parity a delegating candidate needs to be judged on the
        // scaffold delta rather than on a context handicap. Without one (a
        // preview, a GEPA rollout) the task is all there is.
        //
        // The replay goes straight to streamText rather than through
        // assembleTurnMessages, so the pairing invariant is applied here: a
        // context captured from a turn that was interrupted between a tool call
        // and its result would make streamText throw before the request left
        // the isolate, failing the shadow trial for a reason that has nothing
        // to do with the scaffold being judged. The CLI's replay reaches the
        // invariant through runChat (cli-backend local-session.ts); this is the
        // other half of that one path.
        defaultInference: () => projectDefaultInference(streamText({
          model: this.getModel(),
          messages: context && context.length > 0
            ? settleUnpairedToolCalls(context) ?? [...context]
            : [{ role: 'user', content: task }],
          tools: this.getRawTools(),
          stopWhen: stepCountIs(this.maxSteps),
          ...effortFor('scaffold_mutation'),
        }).toUIMessageStream()),
      }),
      model: () => this.getModel(),
      judge: createJsonJudge(() => this.getModelForReview()),
    };
  }

  /** The scaffold's host.llmStream bridge (core scaffold-host): tool names
   *  resolve against the RAW surface per call, multi-step, scaffold-stage
   *  reasoning effort. The step budget is the turn's own — a scaffold that
   *  delegates through this bridge is doing the turn's work, and giving it
   *  less room than the default loop makes every comparison between them a
   *  measurement of the handicap. */
  protected makeScaffoldLLMStream(): ScaffoldRunOptions['llmStream'] {
    return createScaffoldLLMStream({
      model: this.getModel(),
      tools: () => this.getRawTools(),
      defaultMaxSteps: this.maxSteps,
      streamOptions: effortFor('scaffold_mutation'),
    });
  }

  /** The scaffold's host.callTool bridge (core scaffold-host) over this
   *  actor's RAW ToolSet. */
  protected makeScaffoldCallTool(): NonNullable<ScaffoldRunOptions['callTool']> {
    return createScaffoldCallTool(() => this.getRawTools());
  }

  /** The scaffold's host.history bridge (core scaffold-host): a read-only,
   *  budgeted page of THIS turn's prepared messages — the same stream the
   *  scaffold is the inference loop for. Read per call, so a scaffold running
   *  across a turn sees the messages as they stand when it looks. */
  protected makeScaffoldHistory(): NonNullable<ScaffoldRunOptions['history']> {
    return createScaffoldHistory(() => this._lastTurnOpts?.messages ?? []);
  }

  /**
   * Inference seam override — THE single production chat path on Think, for
   * EVERY actor. A facet that evolves a scaffold it cannot run is a dead
   * loop, so this lives on the substrate, not on one subclass.
   *
   * Think's `_runInferenceLoop` is private and calls the AI SDK `streamText`
   * itself; this protected transform is the one seam a subclass gets that can
   * replace the stream every turn entry path consumes (the old
   * `runStreamText` override had zero callers on 0.8.2 — the scaffold was
   * silently dead until this re-wire). We route through the agent's mutable
   * scaffold IFF it has evolved one (current version > 0). An un-evolved
   * agent (still on the bootstrap v0) returns Think's result untouched —
   * same behaviour as before, zero overhead — until the evolution loop
   * proves + promotes a better scaffold via shadow eval. Once promoted, that
   * scaffold becomes the agent's live inference loop. One method, one
   * decision, no parallel paths (core scaffold/inference-transform.ts owns
   * the routing + orphan-stream semantics).
   *
   * The scaffold runs in the codemode sandbox and reaches the model/tools/
   * memory only through the `host.*` bridge (the live result object can't
   * cross the boundary). `host.defaultInference()` streams exactly THIS
   * prepared result back, so a delegating scaffold is byte-faithful to the
   * default; a custom scaffold can wrap or replace it.
   */
  protected _transformInferenceResult(result: StreamableResult): StreamableResult {
    const version = this.sql<{ v: number }>`
      SELECT COALESCE(MAX(version), 0) AS v FROM scaffold_versions WHERE status = 'current'`[0]?.v ?? 0;

    return scaffoldInferenceTransform({
      currentVersion: version,
      result,
      run: {
        rt: this.rt,
        // beforeTurn stashed this turn's prepared opts just before streamText
        // fired (turns are serialized on the TurnQueue, so it is THIS turn's).
        task: extractLastUserText(this._lastTurnOpts?.messages ?? []),
        llmStream: this.makeScaffoldLLMStream(),
        callTool: this.makeScaffoldCallTool(),
        history: this.makeScaffoldHistory(),
        timeoutMs: SCAFFOLD_TURN_TIMEOUT_MS,
      },
    });
  }

  // The BackendHost the core orchestrator runs against. broadcast → DO fan-out;
  // enqueueTurn → Think.saveMessages (TurnQueue-serialized programmatic turn) —
  // the queued half of signal delivery, reached only through the core seam.
  private _host: BackendHost | null = null;
  protected get host(): BackendHost {
    if (!this._host) {
      const getHeadRuntime = () => this.getCFHeadRuntime();
      this._host = {
        broadcast: (event) => this.broadcast(JSON.stringify(event)),
        enqueueTurn: async ({ text, metadata, idempotencyKey }) => {
          const drainTurnId = v.is(v.string(), metadata?.drainTurnId)
            ? metadata.drainTurnId
            : null;
          // The id is the row's provenance FALLBACK (core transcriptRole): every
          // turn the harness enqueues is prefixed, keyed or not. Where the
          // producer named the FACT, the id is that name — and the message
          // store's primary key is then what makes a re-announcement land on the
          // row the first one wrote instead of beside it.
          //
          // The AUTHOR is stamped here rather than left to the producer, because
          // this is the seam every programmatic row is written through: a turn
          // that reaches it without saying who wrote it is the harness speaking,
          // and the chat pane must never draw it as the owner's bubble.
          const message: UIMessage = {
            id: `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${idempotencyKey ?? crypto.randomUUID()}`,
            role: 'user' as const, parts: [{ type: 'text' as const, text }],
            metadata: stampTurnAuthor(metadata),
          };
          if (idempotencyKey) {
            const result = await this.submitMessages([message], { idempotencyKey, metadata });
            return {
              status: result.status === 'aborted' || result.status === 'skipped' || result.status === 'error'
                ? 'skipped'
                : 'queued',
              durable: {
                submissionId: result.submissionId,
                accepted: result.accepted,
                status: result.status,
              },
            };
          }
          try {
            const result = await this.saveMessages(() => {
              this._activeDrainTurnId = drainTurnId;
              this._activeProgrammaticUserMessage = message;
              return [message];
            });
            return { status: result.status === 'completed' ? 'queued' : 'skipped' };
          } finally {
            if (this._activeProgrammaticUserMessage === message) {
              this._activeDrainTurnId = null;
              this._activeProgrammaticUserMessage = null;
            }
          }
        },
        // A signal lands on the agent's next step, so this answers whether
        // there will be one. The read is synchronous and the seam's buffer
        // push happens in the same tick, so the turn observed here is the one
        // whose prepareStep will drain it (turns are TurnQueue-serialized); a
        // turn that settles first re-delivers the signal from settle().
        turnInFlight: () => this._inFlight,
        // The drain-debounce timer. keepAliveWhile (the agents-SDK heartbeat
        // the evolution hooks already rely on) holds the DO through the window
        // + the drain so the debounced drain completes within the live
        // activation instead of racing eviction. If the DO dies anyway, the
        // events are still durable in the EventLog — the next ingress / cron
        // alarm / post-turn drain picks them up (delayed, never dropped).
        setTimer: (fn, ms) => {
          void this.keepAliveWhile(() => new Promise<void>((resolve) => {
            setTimeout(() => {
              fn().catch((err) =>
                diagnostics.failure('drain.timer_callback_failed', toKinuError({
                  doing: 'running the debounced event drain',
                  cause: err,
                  otherwise: 'io',
                })),
              ).finally(resolve);
            }, ms);
          })).catch((err) =>
            diagnostics.failure('drain.timer_keepalive_failed', toKinuError({
              doing: 'holding the actor alive across the drain debounce window',
              cause: err,
              otherwise: 'io',
            })));
        },
        // Branching-heads runtime (Facet spawner + merge LLM), resolved lazily —
        // heads need the owner for UserDO auth, set by first-turn time. undefined
        // before then ⇒ heads degrade (getHeadController throws the no-owner error).
        get headRuntime() { return getHeadRuntime(); },
      };
    }
    return this._host;
  }
  /** Executors whose tools ran this turn — debounces the last-active-executor
   *  write to one SQL upsert per executor per turn. Reset in beforeTurn. */
  protected _executorsUsedThisTurn = new Set<string>();
  // ── Tool cache: avoid rebuilding the built-in ToolSet + codemode types every turn ──
  protected _cachedTools: ToolSet | null = null;
  protected _cachedToolsKey: string = "";

  // ── User MCP tools cache ─────────────────────────────────────────────
  // Per-user MCP tools live in UserDO. Per turn we ask UserDO for the
  // current tool descriptors (cheap RPC) and cache them against UserDO's
  // monotonic mcp_updated_at watermark so we only rebuild closures when
  // the user has actually added/removed/edited a server.
  private _cachedMcpTools: ToolSet = {};
  private _cachedMcpToolsKey: number = -1;
  /** Configured MCP servers whose tools did not make it onto this surface —
   *  rendered into the turn's dynamic context so their absence is legible. */
  private _mcpUnavailable: MissingCapability[] = [];

  // Preamble-injection: the codemode tool is built once per DO lifetime.
  // Its executor (PreambleCraftedExecutor) reads craftStore.list() on every
  // execute call, so newly-saved tools appear on the next execute_tools
  // invocation without any registry or cache coherence work.
  private readonly _craftExecTools = new Map<string, ReturnType<typeof createExecuteToolsTool>>();

  // Branching-heads controller — lazily built once per DO lifetime. Wraps a
  // HeadJournal + HeadRuntime (Facet spawner + merge LLM). The `agents` fork
  // drives it, injecting inheritedContext + an onPhase event sink via
  // defaultOptions().
  private _headController: HeadController | null = null;

  /** The stores every agent has, from core — one list both backends inherit,
   *  so a store added there exists for this actor too. Lazy inside: the bundle
   *  never touches `boundSql` until a store is first read, which is what lets
   *  it be built here rather than in the constructor body. */
  private readonly stores = createAgentStores(() => this.boundSql);

  private _liveHeadJournal: LiveHeadJournal | null = null;

  /**
   * The orchestrator's view of head activity (journal + runs + steps). Shared by
   * getHeadController (write path) and getHeadRuns (read path).
   *
   * ANNOUNCING, and that is the whole of the liveness fix. This handed out the
   * raw store, so every write core made through it — a node's spawn, its steps
   * on the unhosted path, its report, the settle — landed durably and told
   * nobody. Wrapping the one instance both paths already share is what makes a
   * search live without a line in `packages/core`, whose swarm runner carries no
   * progress seam to hang a callback on.
   */
  protected get headJournal(): HeadJournal {
    return (this._liveHeadJournal ??= new LiveHeadJournal(
      this.boundSql,
      (headId) => this.announceHeadActivity(headId),
    ));
  }

  /** Tell every open client that one branch's ledger moved. Ordering and
   *  failure isolation belong to {@link LiveHeadJournal}, which calls this only
   *  after its write has returned and never lets a throw here reach core. */
  private announceHeadActivity(headId: string): void {
    this.broadcast(JSON.stringify({ type: 'head_activity', headId }));
  }

  // Durable run-event recorder (Flue-style discriminated union, SSE-resumable).
  // Backed by `agent_log` rows of kind in {step, tool_call, tool_result,
  // reactor_decision}. The RunEventRecorder shim adapts the existing emit()
  // API to the unified log so the SSE stream and the events sidebar share
  // one source of truth.
  protected get eventRecorder(): RunEventRecorder {
    return this.stores.eventRecorder;
  }

  /**
   * Record one non-turn model call in the durable run-event log.
   *
   * The turn loop's spend arrives as `step_finish` (`onStepEvent` above). This is
   * the other 25 producers — judges, the fast tier, the evolution engine,
   * compaction, a scaffold's own loop, a sandbox program's `llm.query`, the
   * platform AI bindings — each of which used to drop the provider's report on
   * the line that received it. Same log, same `Usage`; a `model_call` row rather
   * than a `step_finish` one, so a judge's cold prompt never enters the turn
   * loop's prefix-cache window.
   *
   * FILED UNDER THE CURRENT RUN, OR THE WORKSPACE. Half of these fire between
   * runs (an evolution pass on a fiber, an embedding backfill at boot), and
   * `_currentRunId` is empty then. Dropping those is the dishonesty this row
   * exists to remove, so they go to the reserved workspace id instead.
   *
   * PRICED ONLY WHERE THE RATE IS THE CALL'S OWN. The catalog session tracks the
   * ACTOR's model; a judge deliberately runs on a different one
   * (`selectJudgeModel` picks cross-family on purpose). Pricing a judge call at
   * the actor's rate would put a fabricated number in the ledger, so `usd` stays
   * absent unless the call ran on the very model the catalog resolved — and an
   * absent `usd` already means unpriced, never free.
   */
  protected reportModelCall(report: ModelCallReport): void {
    try {
      const event: Extract<RunEventInput, { type: 'model_call' }> = {
        type: 'model_call', source: report.source,
      };
      if (usageReported(report.usage)) event.usage = report.usage;
      if (report.spec !== undefined) event.spec = report.spec;
      if (report.modelId !== undefined) event.modelId = report.modelId;
      const pricing = report.spec === this.effectiveModelSpec()
        ? this.modelCatalog.pricing()
        : null;
      const usd = pricing ? priceCall(report.usage, pricing) : undefined;
      if (usd !== undefined) event.usd = usd;
      this.eventRecorder.emit(this._currentRunId || WORKSPACE_RUN_ID, event);
    } catch (err) {
      diagnostics.failure('event.model_call_emit_failed', toKinuError({
        doing: 'recording a model_call run event',
        cause: err,
        otherwise: 'io',
      }), { source: report.source });
    }
  }

  // ── EventsHub: per-agent ingress + persistence + dispatch. ──────────────
  // Load-bearing primitives (spec §1):
  //   - `agent_log`     unified append-only ledger (initEventsHubTables)
  //   - EventLog        publish/pending/defer/dismiss/query
  //   - TriggerRegistry durable subscriptions (webhooks, timers, watches)
  //   - ReplyChannelStore  durable reply-channel rows + dispatchers
  // Spec: docs/ARCHITECTURE.md — "Events and ingress"
  private _eventLog: import('@kinu.run/core').EventLog | null = null;
  protected get eventLog(): EventLog {
    if (!this._eventLog) {
      this._eventLog = new EventLog(this.ctx.storage.sql);
    }
    return this._eventLog;
  }
  // agent_facts world model — typed, idempotent, keyed.
  protected get facts(): FactsStore {
    return this.stores.facts;
  }

  // Background-job registry — work auto-detached past the 30s threshold (#173).
  protected get jobs(): BackgroundJobStore {
    return this.stores.jobs;
  }

  // The agent's own task list — written by the `tasks` tool, read here for the
  // live context block and by the Tasks surface.
  protected get taskList(): TaskListStore {
    return this.stores.taskList;
  }

  /** The scaffold is the program a turn executes (core reads it in
   *  scaffold/executor.ts), so its existence is a precondition of RUNNING A
   *  TURN — deliberately not of activating the Durable Object.
   *
   *  It must never be awaited from `onStart()`: partyserver runs `onStart` inside
   *  `ctx.blockConcurrencyWhile`, which `fetch`, `webSocketMessage`,
   *  `webSocketClose` and `alarm` all await, and the hosted file plane is a
   *  SECOND Durable Object. Awaiting it there stalls every request on this
   *  object — pure `@callable` reads included — for as long as that object takes
   *  to answer, and the Workers runtime cancels the block and resets the object
   *  at 30s (`do.block_concurrency.cancel_ms`). Measured: a bare `SELECT` took
   *  25212ms behind a filesystem object busy for 25s, against 266ms with the same
   *  object busy and a clean `onStart`.
   *
   *  Owner-gated because the hosted file plane is owner-namespaced, and latched
   *  per activation like `_schemaReady`: once this activation has seen the
   *  scaffold, later turns re-probe nothing. Protected for the same reason
   *  `_cachedSoulText` is: a harness with no filesystem declares the two
   *  file-backed turn preconditions satisfied rather than faking a filesystem. */
  protected _scaffoldReady = false;
  protected async ensureOwnedScaffold(): Promise<void> {
    if (this._scaffoldReady || !this.getOwnerUserId()) return;
    if (!(await this.rt.identity.scaffold.exists())) {
      await bootstrapScaffold(this.rt);
      diagnostics.event('scaffold.bootstrapped', { workspace: this.workspaceName() });
    }
    this._scaffoldReady = true;
  }

  // Durable MCTS search checkpoints — the resume record an `action:'swarm'`
  // search evicted mid-flight continues from (B6). One per DO; keyed by search
  // root id.
  protected get mctsSearchStore(): MctsSearchStore {
    return this.stores.mctsSearchStore;
  }

  /**
   * Push ONE search's tree to every connected client, after each of its MCTS
   * iterations. The one broadcast both producers use — the lifetime evolution
   * cycle and an agent-initiated `agents` fork (see getAgentsToolDeps). It used
   * to hang off the orchestrator and be reachable only from the first of those,
   * so a search an operator started emitted nothing and its tree sat still for
   * as long as it ran.
   *
   * Scoped by the `rootId` the event carries, NOT by "which tree was written to
   * most recently". A workspace runs concurrent searches — two detached
   * `action:'swarm'` calls — and the latest-tree read made every event a coin
   * flip between them: one search's iteration shipped the other's nodes under
   * its own phase and budget, and a backpropagation (visits change, no insert,
   * so never "latest") was suppressed by the shared fingerprint as a no-change.
   *
   * Several events fire per iteration and each carries the WHOLE tree —
   * observations and proposed code included — so a tree that has not changed
   * SINCE ITS OWN last push is skipped rather than re-serialized and fanned out.
   * The fingerprint is therefore per search: one search going quiet must not
   * mask another that is growing.
   */
  broadcastMctsProgress(rootId: string, phase: string, iteration?: number, budget?: number): void {
    try {
      const nodes = readSearchTree(this.boundSql, rootId);
      if (nodes.length === 0) return;
      const fingerprint = nodes.map((n) => `${n.id}:${n.visits}:${n.value}:${n.status}`).join('|');
      if (fingerprint === this._lastMctsFingerprint.get(rootId)) return;
      this._lastMctsFingerprint.set(rootId, fingerprint);
      this.broadcast(JSON.stringify({
        type: 'mcts-progress', rootId, phase, iteration, budget,
        nodeCount: nodes.length, nodes,
      }));
    } catch (err) {
      diagnostics.failure('mcts.progress_broadcast_failed', toKinuError({
        doing: 'pushing an MCTS search tree to connected surfaces',
        cause: err,
        otherwise: 'io',
      }), { rootId, phase });
    }
  }

  /** The tree last pushed, per search. Per activation, which is the right
   *  lifetime: a reconnecting client is served by the surface's own poll, not by
   *  a resend. */
  private readonly _lastMctsFingerprint = new Map<string, string>();

  /** One MCTS progress event → the broadcast, whichever producer raised it. */
  protected onMctsProgress(event: MCTSProgressEvent): void {
    const phase = event.type === 'phase' ? event.phase : event.type;
    const budget = event.type === 'branch-failed' ? undefined : event.remainingBudget;
    this.broadcastMctsProgress(event.rootId, phase, event.iteration, budget);
  }
  // The backend-agnostic background-job lifecycle (detach → settle → wake +
  // cancel + evict-recovery), running over the durable fiber (rt.schedule.fiber)
  // and the BackendHost programmatic-turn wake. Owns the cancel-controller map.
  private _jobRunner: BackgroundJobRunner | null = null;
  protected get jobRunner(): BackgroundJobRunner {
    if (!this._jobRunner) {
      this._jobRunner = new BackgroundJobRunner({
        store: this.jobs,
        // The background policy follows the TURN's surface, not the DO: one
        // workspace serves human-watched web chat, one-shot `kinu exec`
        // invocations, and autonomous drains, and the detach threshold has to
        // match the caller. 30s keeps chat responsive; anything with nobody
        // watching wants its work finished in-turn.
        policy: () => BACKGROUND_POLICY[this.turnSurface()],
        fiber: this.rt.schedule.fiber,
        signals: this.orch.signals,
        eventLog: this.eventLog,
        scheduleDrain: () => this.orch.scheduleDrain(),
        logActivity: (event, detail) => this.logActivity(event, detail),
        // Mission Inbox: a settled background job also notifies the owner
        // (email on the orchestrator; skips silently when pieces are absent).
        onSettled: (job) => this.notifyOwner(
          `Background ${job.kind} job ${job.status}`,
          job.status === 'completed'
            ? `Background ${job.kind} job ${job.id} completed.\n\nResult:\n${job.result ?? '(empty)'}`
            : `Background ${job.kind} job ${job.id} ${job.status}${job.error ? `:\n\n${job.error}` : '.'}`,
        ),
        // Evict-resume (B6): re-drive an interrupted job from its durable
        // checkpoint. A fork re-runs the raw agents tool — MCTS continues its
        // remaining search budget via the search store; heads re-run from input.
        // Side-effecting kinds (execute_tools / run) are not safe to blindly
        // re-execute, so they decline and fall back to the eviction failure.
        resume: (kind, input, mode, signal) => this.resumeBackgroundJob(kind, input, mode, signal),
        // What a bounded-out job already produced. Same predicate as `resume` above,
        // so a kind that cannot be re-driven has nothing partial to read either —
        // and a SEARCH does, which is the case that used to settle empty over two
        // completed candidates.
        harvest: (kind, input) => Promise.resolve(harvestBackgroundJob(
          { sql: this.boundSql, ledger: this.mctsSearchStore }, kind, input,
        )),
      });
    }
    return this._jobRunner;
  }
  /** Foreground long-tool controllers before they cross the background
   *  threshold. Once detached, BackgroundJobRunner owns cancellation. */
  protected readonly _activeToolControllers = new Set<AbortController>();

  // Typed accessors over the `agent_config` key/value table — replaces
  // scattered raw SQL with a single deep module.
  protected get config(): AgentConfigStore {
    return this.stores.config;
  }

  /** The unified `agents` tool's deps: the fork substrate is universal on cf
   *  actors — the SAME shared factory the CLI wires (core fork-deps), with
   *  the host-injected infrastructure recomputed per fork call; the
   *  roster/peer halves ride this actor's profile (actorToolDeps). Rebuilt
   *  with the toolset (getRawTools), so the fork model refreshes exactly
   *  when the toolset does. */
  private getAgentsToolDeps(workMode: WorkMode): AgentsToolDeps {
    const actorDeps = this.actorToolDeps();
    // Called directly rather than through the BackendHost seam. That seam is a
    // TYPES-layer contract, and routing a facet host through it made types/
    // depend on strategy/ — an inverted edge the layer gate refused, correctly.
    // Nothing outside this class ever read it, so the indirection bought nothing.
    const nodeLoopHost = this.getCFNodeHost();
    const deps: AgentsToolDeps = {
      mode: workMode,
      fork: buildStrategyForkDeps({
        rt: this.rt,
        model: this.getModel(),
        // Same catalog session that answers the context window and prices the
        // mission ledger — so a search's pre-run estimate and the ledger that
        // later debits it read one rate.
        costModel: () => ({
          spec: this.effectiveModelSpec(),
          pricing: this.modelCatalog.pricing(),
        }),
        // Where a tool-using node's loop runs. Through the same BackendHost seam
        // `headRuntime` uses, because it is the same question one level down: the
        // CLI wires none and its nodes run in process.
        nodeHost: nodeLoopHost === undefined ? undefined : () => nodeLoopHost,
        // `nodeHome` is deliberately NOT wired, and this is the one place a reader
        // would look for it. *Isolation* needs a uid-0 view of the workspace
        // filesystem and the principal registry that scopes `/tmp`; this backend
        // reaches its workspace by RPC to a Nimbus Durable Object, where every
        // pid-less filesystem call acts as the session user
        // (@nimbus-sh/worker session/rpc.js `callerCred`) and `confinePrincipal`
        // has no RPC at all — it is a method on `SqliteVFS`, which lives in that
        // other isolate. A facet is no better placed: an ExplorationAgent builds
        // its runtime over the same remote session. So nodes here report
        // `shared-origin-plane`, and are graded on what they REPORT. Inventing a
        // directory would hand a node a boundary it does not have.
        mcts: {
          session: () => this.createMCTSSession(),
          search: this.mctsSearchStore,
          overrides: () => this.config.getMctsOverrides(),
          // The search the operator watches. Bound at dispatch (the fork
          // detaches on spawn-confirm), same as heads' onPhase.
          onProgress: () => (event: MCTSProgressEvent) => this.onMctsProgress(event),
        },
        heads: {
          controller: () => this.getHeadController(),
          inheritedContext: () => this.readInheritedContext(),
          // Captured at dispatch, once per fork call — see emitHeadPhase.
          onPhase: () => {
            const runId = this._currentRunId;
            return (event: SplitPhaseEvent) => this.emitHeadPhase(event, runId);
          },
          onComplete: (merge: MergeResult, task: string) => {
            if (workMode === 'build') this.recordHeadsTake(merge, task);
          },
        },
      }),
      budget: this.budget,
    };
    if (actorDeps.team) deps.team = actorDeps.team;
    if (actorDeps.peers) deps.peers = actorDeps.peers;
    return deps;
  }

  /** Convenience: current runId for event emission. One run per turn. */
  protected _currentRunId = '';

  // ── Skills (turn-scoped) ───────────────────────────────────────
  /** Resolved active set for the current turn. Built in beforeTurn, read by
   *  the system-prompt assembly via TurnConfig.system override. */
  private _turnActiveSkills: ActiveSkillSet | null = null;
  /** Lazy SkillsVfs shim around rt.storage.vfs — built once, reused. */
  private _skillsVfs: SkillsVfs | null = null;
  private getSkillsVfs(): SkillsVfs {
    if (!this._skillsVfs) this._skillsVfs = skillsVfsOver(this.rt.storage.vfs);
    return this._skillsVfs;
  }

  // ── Activity logging: persisted + broadcast to Logs pane ──
  private _turnT0 = 0;

  // Per-turn in-flight flag — forkAgent rejects with "agent busy" while set.
  // Set in beforeTurn, cleared in onChatResponse (after durable persist;
  // evolution is fire-and-forget and does not extend the busy window).
  protected _inFlight = false;
  /** Synthetic drain id captured when its programmatic queue entry actually
   *  starts. `this.messages` may already contain a newer queued user message
   *  by the time this turn finishes. */
  protected _activeDrainTurnId: string | null = null;
  protected _activeProgrammaticUserMessage: UIMessage | null = null;
  /** Standalone drains may span Think auto-continuations under one request id. */
  protected readonly _pendingDrainReplyTurns = new Map<string, string>();

  /**
   * Mid-turn steers — what the user typed while this turn was running. The
   * SHARED core drain, so the USER semantics are defined in exactly one place
   * for both backends: each steer persists as a verbatim user row (the
   * walk-back fork cuts at user messages), an interrupt hands what the model
   * never saw back to the composer, and anything left over reruns as a
   * user-origin turn.
   *
   * Deliberately NOT `orch.signals`: a signal is never persisted and always
   * re-delivers as a turn of its own, which is the opposite of all three.
   */
  protected readonly userSteer = new UserSteerDrain({
    turnInFlight: () => this._inFlight,
    // A drain is the moment the steer stops being "queued" and becomes
    // something the model has. Both halves of saying so happen here: the
    // durable user row (so the fork and every read model see it) and the
    // broadcast every open surface renders it from.
    onDrain: (steers, atStep) => this.recordLandedSteers(steers, atStep),
  });

  /** The public extension seam on the cloud backend — the SAME ExtensionHost
   *  contract `runChat` drives on the CLI, bridged onto Think's subclass
   *  hooks: beforeTurn → onTurnStart + transformContext, beforeStep → the
   *  shared step pipeline (composePrepareStep), beforeToolCall/afterToolCall
   *  → onToolCall/onToolResult, onChatResponse → onTurnEnd. Persistent for
   *  the DO activation. The default compaction extension registers here at
   *  construction (registerCompactionExtension). */
  protected readonly extensions = new ExtensionHost();

  /** Dynamic-context blocks for this DO activation (core volatile-context.ts),
   *  re-read and re-woven at every model step by the shared step pipeline.
   *  In-memory only — hibernation/reset empties it, so a cold start attaches
   *  exactly one fresh block; the compaction extension's onOutcome resets it
   *  whenever the model-visible stream changed shape ('planned'/'invalidated')
   *  because the frozen block positions are meaningless against a rewritten
   *  stream. */
  private readonly dynamicLedger = new DynamicContextLedger();
  protected _cliCwd: string | null = null;
  /** Whether the message that opened the CURRENT turn was a conversational
   *  reply or an independent one-shot task (`kinu exec` against this
   *  workspace). Set in beforeTurn from the chat request; read at turn end to
   *  decide whether this turn may be parked awaiting a follow-up verdict.
   *  Defaults to a conversation — every non-CLI surface (web chat, API, the
   *  REPL) is one. */
  private _turnContinuity: TurnContinuity = 'conversation';
  // Current turn identity for the device daemon's pre-mutation shadow-git
  // snapshot (set in beforeTurn; the daemon dedupes per turnId). Survives the
  // turn so background tool continuations keep tagging their originating turn.
  private _turnCheckpoint: { turnId: string; sessionId: string } | null = null;

  // The prepared streamText opts of the LAST live chat inference, stashed at
  // the end of beforeTurn — Think 0.8's one turn-assembly hook on the live
  // inference path (the effective TurnConfig: final system/messages/tools/
  // model; Think then only wraps tool execute and re-applies the same values,
  // so a replay of these opts is the same request modulo per-step cache
  // markers, which are inert decoration). The shadow eval replays these for
  // the pending scaffold's host.defaultInference so the A/B measures the
  // scaffold delta, not a context handicap: the live answer saw the whole
  // conversation while the shadow's reconstruction used to see only the task
  // text — structurally tie-prone. Also the task source for the evolved-
  // scaffold inference transform. In-memory only: turns are serialized on
  // the TurnQueue and the shadow eval captures the reference synchronously
  // in the same onChatResponse, so it cannot be overwritten by a later turn;
  // after a DO restart the shadow falls back to the task-only reconstruction.
  protected _lastTurnOpts: Parameters<typeof streamText>[0] | null = null;

  getCliCwdForDevice(): string | null {
    return this._cliCwd;
  }

  getCheckpointMetaForDevice(): { turnId: string; sessionId: string } | null {
    return this._turnCheckpoint;
  }

  // ── Bound SQL executor ────────────────────────────────────────────────
  // `this.sql` is a plain method on the Agent base class — it needs `this`
  // bound to reach `this.ctx.storage.sql`. Passing `this.sql` as a bare
  // function reference to any helper (readForkLineage, forkWorkspaceStorage)
  // loses the binding and fails with `Cannot read properties of undefined
  // (reading 'ctx')`. This closure captures `this` once and can be safely
  // passed by reference.
  private _boundSql: SqlExecutor | null = null;
  protected get boundSql(): SqlExecutor {
    if (!this._boundSql) this._boundSql = bindAgentSql(this);
    return this._boundSql;
  }

  private _tracing: AgentTracing | null = null;
  /**
   * The tracing seam, one per construction of this object.
   *
   * LAZY, and that is what makes `isolateGen` correct rather than merely present.
   * The generation is bumped on FIRST use inside an activation, so exactly one
   * bump happens per construction — including the case a boot-time counter cannot
   * see, `ctx.facets.abort()`, which reuses the isolate and is how a Kinu fork
   * most commonly dies. It is deliberately NOT bumped in `onStart`: that runs
   * inside `ctx.blockConcurrencyWhile`, where every added write stalls every
   * request on this object and 30s of it RESETS the object
   * (`do.block_concurrency.cancel_ms`), and an observability counter has no
   * business on that path.
   *
   * `selfPath` rather than `ctx.id`: measured on the deployed runtime, two facets
   * with distinct ids both reported under the ROOT's `durableObjectId`, so an
   * id-keyed trace collapses every head and subordinate into one orchestrator
   * (`do.facet.id_is_root_namespace`).
   */
  protected get tracing(): AgentTracing {
    if (!this._tracing) {
      this._tracing = createAgentTracing({
        tracer: createWorkersTracer(),
        isolateGen: this.config.countIsolateGeneration(),
        selfPath: this.selfPath,
      });
    }
    return this._tracing;
  }

  protected logActivity(event: string, detail?: string) {
    const elapsed = this._turnT0 > 0 ? Math.round(performance.now() - this._turnT0) : 0;
    const now = Date.now();
    void this.sql`INSERT INTO activity_log (event, detail, elapsed_ms, created_at)
      VALUES (${event}, ${detail ?? null}, ${elapsed}, ${now})`;
  }

  protected get rt(): CFRuntime {
    if (!this._rt) {
      // No onToolRegistered hook: PreambleCraftedExecutor reads craftStore.list()
      // fresh on every execute_tools call, so mid-turn saves propagate
      // without any registry plumbing (see docs/CRAFT-ARCHITECTURE.md §3).
      // `this` (a subclass) DOES have access to its protected env/ctx; cast to
      // the AgentHost view createCFRuntime needs.
      const runtime = createCFRuntime(this, {
        env: this.env,
        ctx: this.ctx,
        acc: () => this.acc,
        getCliCwdForDevice: () => this.getCliCwdForDevice(),
        getCheckpointMetaForDevice: () => this.getCheckpointMetaForDevice(),
      }, {
        ownerUserId: () => this.getOwnerUserId(),
        workspaceName: this.workspaceName(),
        shellId: this.shellId(),
        scaffoldPath: this.scaffoldPath(),
        capabilityToken: () => this.workspaceCapabilityToken(),
      }, {
        deferrals: () => this.deferralChannel(),
        reportModelCall: (report) => this.reportModelCall(report),
      });
      this.configureRuntime(runtime);
      this._rt = runtime;
    }
    return this._rt;
  }

  /** Synchronous post-construction hook for actor-specific mounts. The runtime
   * is not cached until this returns, so implementations must use the argument
   * and must not re-enter `this.rt`. */
  protected configureRuntime(_runtime: CFRuntime): void {}

  /**
   * Where a gated command goes when nobody is there to approve it.
   *
   * None here. A subordinate has no needs-you queue of its own — it is a
   * workspace-level surface reached through its orchestrator — so parking an
   * action on this actor would put a decision somewhere nobody looks. It keeps
   * 'strict''s explanatory refusal, and the orchestrator (which owns the queue,
   * the UI and the wake) overrides this.
   *
   * Resolved at exec time, never during runtime construction: reaching the
   * queue means reaching `this.orch` for the wake's signal seam, and the
   * runtime is built inside this actor's own lazy `rt` getter.
   */
  protected deferralChannel(): DeferredApprovalChannel | undefined { return undefined; }

  /** `memory.*` / `tasks.*` — unconditional on every ActorAgent (orchestrator
   *  and subordinate alike), the same way the native `memory` and `tasks`
   *  tools are. Deps read live per provider's own convention (memory's facts/
   *  vectorStore can rebind; tasks reuses `this.taskList`, the same
   *  TaskListStore instance the dynamic-context snapshot reads). */
  private baseCodemodeProviders(): CodemodeProvider[] {
    return [
      createMemoryCodemodeProvider(() => ({
        memory: this.rt.memory, vectorStore: this.rt.vectorStore,
        facts: this.facts, sql: this.rt.storage.sql,
      })),
      createTasksCodemodeProvider(this.taskList, this.config),
    ];
  }

  /** Build (or return cached) this DO's execute_tools tool. Construction (see
   *  execute-tools.ts) is once per DO lifetime; crafted tools saved mid-turn
   *  still become callable because the executor re-reads craftStore per call. */
  private getExecuteToolsTool(mode: WorkMode, profileKey: string): ReturnType<typeof createExecuteToolsTool> {
    const key = `${mode === 'plan' ? 'plan' : 'default'}:${profileKey}`;
    if (!this._craftExecTools.has(key)) {
      this._craftExecTools.set(key, createExecuteToolsTool({
        loader: this.env.LOADER,
        rt: this.rt,
        sql: this.boundSql,
        registry: this.providerRegistry(),
        modelSpec: () => this.getStoredModelId(),
        webSearch: this.getWebSearchProvider(),
        // `agents.*` in the sandbox — the same deps the top-level tool holds,
        // so a script delegates through the one path with the one action gate.
        agents: () => this.getAgentsToolDeps(mode),
        // Plan mode is the only turn whose codemode provider set differs:
        // `release` is physically absent from the type declaration and the
        // dispatcher, while every ordinary executor/provider stays present.
        extraProviders: () => [...this.baseCodemodeProviders(), ...this.extraCodemodeProviders()]
          .filter((provider) => mode !== 'plan' || provider.name !== 'release'),
        // Record which executor the agent actually works in, so the UI (diff /
        // file manager) defaults to where work happened. One upsert per executor
        // per turn (debounced via _executorsUsedThisTurn, reset in beforeTurn).
        onExecutorUsed: (name) => {
          if (this._executorsUsedThisTurn.has(name)) return;
          this._executorsUsedThisTurn.add(name);
          this.config.setLastActiveExecutor(name);
        },
      }));
    }
    const tool = this._craftExecTools.get(key);
    if (tool === undefined) throw new Error(`execute_tools profile ${key} was not built`);
    return tool;
  }

  // ── Model resolution ───────────────────────────────────────────

  protected providerRegistry(): AgentProviderRegistry {
    return this.ownedModelServices.providerRegistry();
  }

  protected getOwnerUserDO(): UserHubClient | null {
    const userId = this.getOwnerUserId();
    if (!userId) return null;
    const stub: Pick<Fetcher, 'fetch'> = this.env.UserDO.get(this.env.UserDO.idFromName(userId));
    // SAFETY: the generated UserDO namespace contract provides both the
    // standard Fetcher surface and every UserDO RPC method in UserHubClient.
    return stub as UserHubRpcClient;
  }

  protected requireOwnerUserDO(): UserHubClient {
    const stub = this.getOwnerUserDO();
    if (!stub) throw new Error('Agent has no owner yet. Open it through the authenticated app or CLI first.');
    return stub;
  }

  /** The identity this actor presents on every privileged user-level call.
   *  Throws rather than falling back when no token exists — an unclaimed
   *  workspace reaches nothing. */
  protected async userCaller(): Promise<UserCaller> {
    const workspaceToken = await this.workspaceCapabilityToken();
    if (!workspaceToken) {
      throw new Error('This workspace has not been issued a capability token yet. Open it through the authenticated app or CLI first.');
    }
    return { workspaceToken };
  }

  /** The owner's UserDO paired with this actor's identity — the two things
   *  every privileged user-level call needs. */
  protected async userHub(): Promise<{ stub: UserHubClient; caller: UserCaller }> {
    return { stub: this.requireOwnerUserDO(), caller: await this.userCaller() };
  }

  // ── Parent workspace file plane (worker-side DO RPC only) ──────────────

  /** A fork reaches these through its `parent` executor. They deliberately
   * carry no `@callable`: only a worker-held parent stub can reach them. */
  private workspaceFileFailure<T, Thrown>(path: string, error: Thrown): ParentRpcResult<T> {
    return {
      ok: false,
      error: {
        code: isVfsError(error) ? error.code : 'EIO',
        message: renderThrownChain({ cause: error }),
        path,
      },
    };
  }

  async readWorkspaceFile(path: string): Promise<ParentRpcResult<Uint8Array>> {
    try {
      const content = await this.rt.localVfs.readFile(path);
      return { ok: true, value: v.is(v.string(), content) ? new TextEncoder().encode(content) : content };
    } catch (error) {
      return this.workspaceFileFailure(path, error);
    }
  }

  async writeWorkspaceFile(input: ParentRpcWrite): Promise<ParentRpcResult<null>> {
    try {
      if (input.kind === 'file') await this.rt.localVfs.writeFile(input.path, input.data);
      else await this.rt.localVfs.mkdir(input.path, { recursive: input.recursive });
      return { ok: true, value: null };
    } catch (error) {
      return this.workspaceFileFailure(input.path, error);
    }
  }

  async listWorkspaceFiles(path: string): Promise<ParentRpcResult<string[]>> {
    try {
      return { ok: true, value: await this.rt.localVfs.readdir(path) };
    } catch (error) {
      return this.workspaceFileFailure(path, error);
    }
  }

  async statWorkspaceFile(path: string): Promise<ParentRpcResult<{ size: number; mtimeMs: number; isDir: boolean } | null>> {
    try {
      return { ok: true, value: await this.rt.localVfs.stat(path) };
    } catch (error) {
      return this.workspaceFileFailure(path, error);
    }
  }

  async deleteWorkspaceFile(path: string): Promise<ParentRpcResult<null>> {
    try {
      await this.rt.localVfs.unlink(path);
      return { ok: true, value: null };
    } catch (error) {
      return this.workspaceFileFailure(path, error);
    }
  }

  /**
   * Run a command in THIS workspace's shell on behalf of a fork.
   *
   * The reason `parent` is worth being an executor rather than a file view: a
   * fork searching its parent used to walk the tree one RPC per file through an
   * emulated shell; this is one round trip into the real one, with the whole
   * coreutils set behind it.
   */
  async execWorkspaceCommand(command: string): Promise<ParentRpcResult<ParentExecResult>> {
    const shell = this.rt.shell;
    if (!shell) return this.workspaceFileFailure('', new Error('this workspace has no shell'));
    try {
      return { ok: true, value: await shell.exec(command) };
    } catch (error) {
      return this.workspaceFileFailure('', error);
    }
  }

  /** The web search + fetch provider — built once per DO lifetime. Key-less by
   *  default (DuckDuckGo + Markdown-for-Agents); a stored `tavily` credential,
   *  resolved through the registry's getAuth seam, upgrades search. HTML→markdown
   *  routes through env.AI.toMarkdown when the AI binding is present. */
  private getWebSearchProvider(): WebSearchProvider {
    return this.ownedModelServices.getWebSearchProvider();
  }

  /** Stored model spec, or null when unset (registry will pick the default). */
  protected getStoredModelId(): string | null {
    return this.config.getModel();
  }

  // ── The control plane every root exposes ────────────────────────
  //
  // Declared twice, once per root, over the same core implementations: a chat is a
  // chat, so what stops a turn and what changes the model are the same question
  // wherever the chat is. `ensureSchema()` first on each, because a native DO RPC
  // does not route through partyserver and can land before `onStart` — the race
  // `installWorkspaceCapability` documents. It is flag-gated and idempotent.

  /**
   * One page of the durable transcript, oldest-first within the page, newest
   * page when called with no cursor.
   *
   * `@callable()` because a chat pane calls it over the socket. The pane is
   * SEEDED by the SDK's own `get-messages` route — `Think.messages`, a bounded
   * newest window governed by `hydrationByteBudget` — and this is the only way
   * to reach anything older than that window.
   *
   * On the substrate rather than on the workspace root, because a facet runs
   * `initWorkspaceSchema` against its own `ctx.storage.sql` and therefore has
   * its own conversation. Declared on the root alone, a subordinate's chat had
   * no way to ask for a page of its own history, so the column drove its
   * scroller with nothing to fetch and everything past the hydration window was
   * unreachable rather than slow.
   */
  @callable()
  async getChatHistoryPage(request?: PageRequest): Promise<Page<ChatHistoryEntry>> {
    this.ensureSchema();
    return getChatHistoryPage(this.boundSql, request ?? {});
  }

  /** The agent's stored model spec. The UI preselects a menu entry with it; the
   *  available-models list comes from /api/user/models so it stays user-scoped. */
  @callable()
  async getStoredModelSpec(): Promise<{ spec: string | null }> {
    this.ensureSchema();
    return getStoredModelSpec(this.config);
  }

  @callable()
  async setModel(spec: string) {
    this.ensureSchema();
    return setModel({
      config: this.config,
      normalize: (s) => this.providerRegistry().normalizeSpecSync(s),
      onChanged: () => this.invalidateModelCaches(),
    }, spec);
  }

  /**
   * Steer the running turn with something the user just typed — the third
   * composer action beside Stop and Branch, and the only one that neither
   * abandons the turn nor forks it.
   *
   * `'idle'` means the turn ended before this arrived and NOTHING was buffered, so
   * the caller must send the text as an ordinary message: "it went into the
   * running turn" and "it started a new one" are different events for the person
   * who typed it.
   */
  @callable()
  async steerTurn(text: string): Promise<{ landed: UserSteerOutcome }> {
    this.ensureSchema();
    return { landed: this.acceptUserSteer(text) };
  }

  /** Stop everything this actor is doing — the composer's Stop button. */
  @callable()
  async cancelCurrentWork(): Promise<CancelWorkOutcome> {
    this.ensureSchema();
    return cancelCurrentWork({
      jobRunner: this.jobRunner,
      activeToolControllers: this._activeToolControllers,
      broadcast: (payload) => this.broadcast(payload),
      interruptSteers: () => this.interruptUserSteers(),
      onCancelled: (outcome) => this.onWorkCancelled(outcome),
    });
  }

  /**
   * What this root does once its work is actually cancelled — the ONE thing that
   * differed between the two copies above, kept as a difference: the orchestrator
   * clears its in-flight flag and files an activity line, and whether a root's
   * Stop settles its own turn state is that root's business, not the substrate's.
   */
  protected onWorkCancelled(_outcome: Omit<CancelWorkOutcome, 'ok'>): void {}

  // ── Think lifecycle overrides ──────────────────────────────────

  /** Think calls `getModel()` synchronously per turn. The memo lives in
   *  OwnedModelServices, which every actor shares, so there is one cache and one
   *  invalidation rather than a per-class copy. */
  getModel(): LanguageModel {
    this.logActivity("getmodel");
    return this.ownedModelServices.resolveModel(this.getStoredModelId());
  }

  /**
   * Delegates to @kinu.run/core's canonical prompt builder (F1 fix: documents
   * `codemode.*` — the real namespace crafted tools land in — instead of the
   * former `tools.*` lie). Cached across turns; invalidated when the soul
   * text or the registered executor set changes.
   */
  protected _cachedSystemPrompt: string | null = null;
  protected _cachedSystemPromptKey: string = "";
  /**
   * Cached SOUL.md text, refreshed at turn start and invalidated by setSoul().
   *
   * A cache rather than a read because `getSystemPrompt` is synchronous — Think
   * calls it that way, and the prompt it builds is the byte-stable cacheable
   * prefix — while the soul is a FILE in the workspace filesystem. So the read
   * happens where there is a promise to await (refreshSoulText, from
   * beforeTurn), and the prefix builder only ever consults what is already
   * loaded. A cold activation that has not reached a turn yet renders the
   * default identity, exactly as an unwritten SOUL.md always did.
   */
  protected _cachedSoulText: string | null = null;
  protected async loadSoulText(): Promise<string> {
    return (await readSoul(this.rt.storage.vfs)) ?? '';
  }
  protected async refreshSoulText(): Promise<void> {
    this._cachedSoulText = await this.loadSoulText();
  }
  private getSoulText(): string {
    return this._cachedSoulText ?? '';
  }

  getSystemPrompt(): string {
    this.logActivity("getsystemprompt_start");
    const execs = this.rt.executionRouter?.listExecutors() ?? [];
    const execKey = execs.map(e =>
      `${e.name}:${e.available ? 1 : 0}:${e.configured ? 1 : 0}:${e.active ? 1 : 0}:${e.status}`,
    ).join(",");
    const model = this.promptModelContext();
    const actorDeps = this.actorToolDeps();
    const availableTools = actorActiveTools(actorDeps);
    const agentsActions = actorAgentsActions(actorDeps);
    // The stance is durable agent state, the same class as the soul and the
    // model — so it belongs in the cacheable base AND in its cache key.
    const stance = this.config.getStance();
    const key = `${this.getSoulText()}\u0000${execKey}\u0000${model.provider ?? ''}/${model.id ?? ''}\u0000${availableTools.join(',')}\u0000${agentsActions.join(',')}\u0000${stance}`;
    let base: string;
    if (this._cachedSystemPrompt && this._cachedSystemPromptKey === key) {
      base = this._cachedSystemPrompt;
      this.logActivity("getsystemprompt_end", "cache hit");
    } else {
      // Always build the BASE prompt here — no turn-scoped state. The
      // authoritative per-turn prompt (skills, MCP tools, fresh device
      // status, change notice) is assembled in `beforeTurn` and ALWAYS
      // returned via TurnConfig.system, which overrides this one for chat
      // turns (Think calls getSystemPrompt() BEFORE beforeTurn()). Mixing
      // turn state in here would poison the cache across turns.
      base = buildSystemPromptSync(this.rt, {
        soulOverride: this.getSoulText(),
        executors: execs,
        availableTools,
        agentsActions,
        // The RLM provider is unconditionally wired in buildCfExecuteTools,
        // so the constant needs no cache-key component.
        rlmAvailable: true,
        backend: 'cf',
        model,
        stance,
      });
      this._cachedSystemPrompt = base;
      this._cachedSystemPromptKey = key;
      this.logActivity("getsystemprompt_end", `${base.length} chars`);
    }
    // BYTE-STABLE: no per-turn state rides here. The volatile half (facts,
    // executor status, device notice, skill activations) is appended to the
    // turn's MESSAGES in beforeTurn — see prompting/volatile-context.ts.
    return base;
  }

  /**
   * Compute a lightweight cache key from CraftStore + score state.
   * Includes craft_scores.MAX(last_used_at) because effective-score filtering
   * depends on recency — without it, the cached ToolSet would keep re-using a
   * stale score-filtered view across turns even as usage shifts.
   */
  private _craftCacheKey(): string {
    const craft = this.sql<{ cnt: number; latest: number }>`
      SELECT COUNT(*) as cnt, COALESCE(MAX(updated_at), 0) as latest FROM crafted_tools`;
    const scores = this.sql<{ lastUsed: number }>`
      SELECT COALESCE(MAX(last_used_at), 0) as lastUsed FROM craft_scores`;
    const { cnt, latest } = craft[0] ?? { cnt: 0, latest: 0 };
    const lastUsed = scores[0]?.lastUsed ?? 0;
    return `${cnt}:${latest}:${lastUsed}`;
  }

  getTools(): ToolSet {
    // The Think chat loop's tool source (first hook called by _runInferenceLoop).
    // Returns the CHAT view = the raw surface + the auto-background wrap (#173).
    // Internal eval side-streams use getRawTools() instead, so a >30s tool run
    // inside a shadow-eval / scaffold / GEPA evaluation never detaches a job or
    // injects an unsolicited "job completed" turn into the user's chat.
    this._turnT0 = performance.now();
    this.logActivity("gettools_start");
    return this.wrapToolsForBackground(this.getRawTools());
  }

  /** The UNWRAPPED tool surface — built + cached. Shared by the chat path (via
   *  getTools, which adds the background wrap) and by internal eval side-streams
   *  that must run tools to completion inline (never auto-background). */
  protected getRawTools(): ToolSet {
    return this.getRawToolsForWorkMode(this.turnWorkMode());
  }

  protected getRawToolsForWorkMode(mode: WorkMode): ToolSet {
    const actorDeps = this.actorToolDeps();
    const profileKey = actorActiveTools(actorDeps).join(',');
    // Cache key includes CraftStore updated_at AND craft_scores last_used_at
    // because effective-score filtering depends on recency. The actor profile
    // is turn-sensitive for subordinate reporting: an owner chat must never
    // reuse an assigned turn's upward-reporting surface.
    const cacheKey = `${mode}:${profileKey}:${this._craftCacheKey()}`;
    if (this._cachedTools && cacheKey === this._cachedToolsKey) {
      return this._cachedTools;
    }
    this.logActivity("gettools_rebuilding", `${this._cachedToolsKey} → ${cacheKey}`);

    try {
      // No registry sync: PreambleCraftedExecutor reads craftStore.list()
      // fresh at every execute. See docs/CRAFT-ARCHITECTURE.md §5.6.

      const builtinDeps: Parameters<typeof buildActorTools>[0] = {
        rt: this.rt,
        preBuiltExecuteTool: this.getExecuteToolsTool(mode, profileKey),
        // The turn's cumulative bulk budget lives on the accumulator, so the
        // cached toolset holds a stable reference across turns and the reset
        // rides the turn's own accounting.
        contextBudget: this.acc.context,
        // Same ownership: read-before-edit state and the per-edit outcome
        // counters ride the accumulator, so the cached toolset sees the turn's
        // ledger and the reset rides the turn's own accounting.
        fileLedger: this.acc.files,
        // Same turn-scoped ownership as fileLedger: the `run` dispatch records
        // each escalation decision here, and the settle spine above writes the
        // durable row.
        escalations: this.acc.escalations,
        // The unified `agents` delegation tool — fork substrate (heads / mcts
        // settle) is universal; hire/ask/send actions appear only when this
        // actor's profile wires the team/peers transports. Owner resolution
        // stays lazy per action, so the cached toolset stays valid across
        // claimOwner.
        agents: this.getAgentsToolDeps(mode),
        // Vectorize-backed semantic memory. memory.search auto-uses
        // hybrid retrieval when this is provided + available; FTS5-only fallback.
        vectorStore: this.rt.vectorStore,
        // Typed, keyed world-model store — exposes the `fact` tool.
        facts: this.facts,
        // The remaining actor-profile dep: the subordinate report spine.
        // The release lane is codemode-only now (release.* — see
        // getExecuteToolsTool below), not a BuiltinToolDeps field.
        // Web research — key-less default, codemode web.* wired below.
        webSearch: this.getWebSearchProvider(),
      };
      if (actorDeps.report) builtinDeps.report = actorDeps.report;
      if (mode === 'plan' && actorDeps.submitPlan) builtinDeps.submitPlan = actorDeps.submitPlan;
      const tools = buildActorTools(builtinDeps);

      // Anthropic prompt-caching: one breakpoint on the last tool caches the
      // whole stable tool surface (tools precede system+messages in Anthropic's
      // cache hierarchy). Namespaced → inert for non-Anthropic providers.
      markLastToolForAnthropicCache(tools, this.config.getCacheRetention());

      this._cachedTools = tools;
      this._cachedToolsKey = cacheKey;
      this.logActivity("gettools_end", `rebuilt — ${Object.keys(tools).length} tools`);
      return tools;
    } catch (err) {
      diagnostics.failure('tool.surface_build_failed', toKinuError({
        doing: 'assembling the turn tool surface',
        cause: err,
        otherwise: 'io',
      }), { mode });
      throw err;
    }
  }

  /**
   * Lazily build the HeadController that spawns ExplorationAgent Facets in
   * head mode (initHead / runAsHead / abortHead). Driven by the `agents`
   * tool's fork action; inheritedContext + the onPhase event sink are
   * injected per call via readInheritedContext() / emitHeadPhase().
   */
  private getHeadController(): HeadController {
    if (this._headController) return this._headController;
    // The HeadRuntime flows through the BackendHost seam (CLI supplies a
    // subprocess-backed one or undefined → single-shot degrade).
    const runtime = this.host.headRuntime;
    if (!runtime) throw new Error('Agent has no owner — branching heads need UserDO access for auth.');
    this._headController = new HeadController(runtime, this.headJournal);
    return this._headController;
  }

  /** Alternate-Takes capture of a completed agents fork (merge settle) run
   *  (core recordGroundedHeadsTake). */
  private recordHeadsTake(merge: MergeResult, task: string): void {
    recordGroundedHeadsTake(this.boundSql, merge, task);
  }

  /** Build the CF HeadRuntime (Facet spawner + merge LLM) once per DO lifetime,
   *  lazily — heads need the agent's owner for UserDO auth. undefined when the
   *  agent has no owner; surfaced via host.headRuntime. */
  private _cfHeadRuntime: HeadRuntime | null = null;
  protected getCFHeadRuntime(): HeadRuntime | undefined {
    if (this._cfHeadRuntime) return this._cfHeadRuntime;
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) return undefined;
    const grounding: HeadGrounding = this.rt.judgeModel
      ? { executor: this.rt.executor, explorer: this.rt.llm, judge: this.rt.judgeModel }
      : { executor: this.rt.executor, explorer: this.rt.llm };
    this._cfHeadRuntime = createHeadRuntime({
      host: this,
      identity: async () => ({
        ownerUserId,
        capabilityToken: await this.workspaceCapabilityToken(),
        // The REGISTERED workspace, never this actor's own DO name — the file
        // plane is keyed by it, so a self-named head derives a second, empty
        // filesystem (unit-head-fork.test.ts).
        sharedParent: this.workspaceName(),
      }),
      models: this.ownedModelServices,
      mergeModelSpec: () => this.getStoredModelId(),
      reportModelCall: (report) => this.reportModelCall(report),
      grounding,
    });
    return this._cfHeadRuntime;
  }

  /**
   * Run a tool-using node's loop in an `ExplorationAgent` facet.
   *
   * Undefined before the agent has an owner, for `getCFHeadRuntime`'s reason: a
   * facet reaches the owner's credentials as its workspace, so without an owner
   * there is nothing to attenuate. Undefined is not a failure here — an absent
   * host runs the same loop in this isolate.
   *
   * The arbiter is published under this node's id for the LIFE OF THE RUN and
   * withdrawn in `finally`, because that registration is the only route a facet
   * has back to a budget that exists solely in this isolate. Withdrawing it is
   * not tidiness: an entry that outlived its run would answer a later node
   * against a settled search, and `nodeArbitrate` refuses rather than granting
   * children nobody would create.
   *
   * A facet per node buys a storage boundary and a teardown verb, NOT
   * parallelism — `do.facet.cpu_shared` is the governing fact, so a wave of
   * hosted nodes serialises exactly as one isolate's `Promise.allSettled`
   * already did. No concurrency bound is imposed here because none is needed for
   * that reason: the width cap the search already enforces bounds how many
   * facets exist at once, and adding a second limiter would be one policy in two
   * places.
   */
  protected getCFNodeHost(): NodeLoopHost | undefined {
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) return undefined;
    return async (spec, arbitrate) => {
      const release = arbitrate
        ? this.registerNodeArbiter(spec.headInput.id, arbitrate)
        : null;
      try {
        const node = await spawnNodeFacet(this, spec, {
          ownerUserId,
          capabilityToken: await this.workspaceCapabilityToken(),
          // The PARENT's workspace, never this facet's own name: the file plane
          // is keyed by it, so a self-named node would derive a second, empty
          // filesystem — the regression unit-head-fork.test.ts pins.
          sharedParent: this.workspaceName(),
        });
        return await node.run();
      } finally {
        release?.();
      }
    };
  }

  /**
   * The arbiters of searches running in THIS isolate right now, by node id.
   *
   * In memory and not a table, because that is what it is: a verdict is decided
   * against a live remaining-children count, so an entry outliving its wave would
   * be answering for a budget that no longer exists. A `Map` rather than a record
   * because the keys are minted ids and entries are added and deleted as waves
   * open and settle.
   */
  private readonly nodeArbiters = new Map<string, NodeArbiter>();

  /**
   * Arbitrate a HOSTED node's branch request, on behalf of the search that owns
   * the budget.
   *
   * Why this exists when `recordHeadStep` was reusable and this is not: a step is
   * a write to a table this actor holds, so any caller can perform it. A verdict
   * is a decision against a LIVE budget — the remaining-children count of a
   * search that is running right now, in this isolate — and that budget is not a
   * row anyone can read. So the arbiter registers itself here for the life of its
   * wave and this method is the route a facet reaches it by.
   *
   * Refuses rather than assumes when no arbiter is registered. A node whose
   * search has already settled must not be handed a grant nobody will honour: the
   * children would be reserved against a budget that is gone, and the node would
   * report having been given work the engine never created.
   *
   * TRACED as its own invocation, because that is exactly what it is: an RPC
   * INTO this object from a facet running elsewhere, and the node is blocked on
   * the answer. A node that stalls waiting for a verdict and a node that stalls
   * before asking for one are indistinguishable from the node's side and from
   * every row either writes.
   */
  async nodeArbitrate(nodeId: string, proposal: BranchProposal): Promise<BranchDecision> {
    return await this.tracing.invocation('rpc', 'swarm.arbitrate', async (_invocation, span) => {
      span.setAttribute('kinu.node_id', nodeId);
      const arbiter = this.nodeArbiters.get(nodeId);
      if (!arbiter) {
        // `budget-exhausted` rather than a sixth policy value: the vocabulary is
        // closed on purpose, and this IS that fact — a settled search has no
        // remaining children, so none can be reserved. The prose carries the
        // detail, and the prose is what the node reads.
        span.setAttribute('kinu.arbiter_registered', false);
        return {
          kind: 'refused',
          policy: 'budget-exhausted',
          error: 'The search that spawned this node is no longer arbitrating, so no branch can be '
            + 'reserved. Finish your own task and report.',
        };
      }
      span.setAttribute('kinu.arbiter_registered', true);
      const decision = await arbiter(proposal);
      span.setAttribute('kinu.decision', decision.kind);
      return decision;
    });
  }

  /**
   * Register a hosted node's arbiter for the life of its run, and return the
   * handle that unregisters it.
   *
   * A returned disposer rather than a second `unregister` call, because the two
   * MUST be paired: an entry that outlived its wave would answer a later node
   * against a settled budget, which is the exact failure the refusal above
   * describes and this shape makes hard to cause.
   */
  registerNodeArbiter(nodeId: string, arbiter: NodeArbiter): () => void {
    this.nodeArbiters.set(nodeId, arbiter);
    return () => { this.nodeArbiters.delete(nodeId); };
  }

  /**
   * The parent's recent conversation, handed to each spawned head so it sees
   * the full context. Capped to the last N messages to bound head LLM context
   * over long sessions (Think Session already compacts the table at the
   * orchestrator level; this is a second safety net for head spawns).
   */
  protected readInheritedContext(): SerializedMessage[] {
    // The agents SDK's session provider creates assistant_messages on its first
    // append, so an agent that has not run a turn has none. Asked directly:
    // catching instead made "no conversation yet" indistinguishable from a read
    // that blew up, and a head handed [] reports "I found nothing" rather than
    // "I could not see the parent" — the defect owners actually hit.
    if (!tableExists(this.boundSql, 'assistant_messages')) return [];
    type Row = { id: string; role: string; content: string; created_at: string };
    const rows = this.sql<Row>`
      SELECT id, role, content, created_at
      FROM (
        SELECT id, role, content, created_at
        FROM assistant_messages
        ORDER BY created_at DESC
        LIMIT ${INHERITED_CONTEXT_CAP}
      ) sub
      ORDER BY created_at ASC`;
    const total = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM assistant_messages`[0]?.n ?? rows.length;
    return inheritedContextFromRows(
      rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: uiMessageText(r.content),
        createdAt: Date.parse(r.created_at) || 0,
      })),
      total,
    );
  }

  /** Stream head_split / head_merge into the durable event log so SSE
   *  subscribers + MCP `list_run_events` see the split lifecycle.
   *
   *  `runId` is captured at fork DISPATCH (getAgentsToolDeps' onPhase
   *  factory), not read live off `_currentRunId`: a fork on the interactive
   *  surface now detaches the instant it spawns, so the calling turn's own
   *  run can close — and `_currentRunId` moves on to whatever turn runs next
   *  — before 'split' fires and always before 'merge' does (it only fires once
   *  the whole exploration finishes). Reading live would misattribute a late
   *  phase to an unrelated later turn instead of dropping it silently, which
   *  is worse. Passing '' (a closed run) is deliberate and distinct from
   *  omitting it. */
  private emitHeadPhase(event: SplitPhaseEvent, runId: string): void {
    try {
      if (!runId) return;
      this.eventRecorder.emit(runId, headPhaseRunEvent(event));
    } catch (err) {
      diagnostics.failure('event.head_phase_emit_failed', toKinuError({
        doing: 'recording a head split/merge phase run event',
        cause: err,
        otherwise: 'io',
      }), { runId, phase: event.kind, rootId: event.rootId });
    }
  }

  /**
   * Fetch the user's MCP tool descriptors and reconstruct AI-SDK Tool
   * adapters whose `execute` closures dispatch back to UserDO via RPC.
   *
   * Cache invalidation:
   *   - UserDO holds a monotonic `mcp_updated_at` watermark, bumped on
   *     add/remove/edit + on OAuth-callback completion.
   *   - We cache descriptors + closures by that integer; rebuild only when
   *     it changes. Result is stable across turns until the user actually
   *     reconfigures something.
   *
   * Closure boundary: the descriptor that crosses RPC carries only the JSON
   * Schema + name + serverId; we re-construct the AI-SDK `Tool` here so the
   * `execute` arrow can capture `userDOStub`, the caller identity, `serverId`,
   * and `name` lexically. The identity is the workspace capability token, so a
   * facet dispatches as its parent workspace and cannot name another.
   */
  private async buildUserMcpTools(): Promise<ToolSet> {
    const userId = this.getOwnerUserId();
    if (!userId) return {};
    const userDOStub = this.env.UserDO.get(this.env.UserDO.idFromName(userId));

    // No identity, no user-level tools: advertising descriptors the actor can
    // no longer dispatch just spends context on calls that will be refused.
    // Asked rather than caught: userCaller() throws only when no token has been
    // issued, and a real failure reading one must not silently empty the surface.
    if (!(await this.workspaceCapabilityToken())) return {};
    const caller = await this.userCaller();

    let watermark: number;
    try { watermark = await userDOStub.userMcp_updatedAt(caller); }
    catch (err) {
      diagnostics.failure('mcp.watermark_fetch_failed', toKinuError({
        doing: 'reading the user MCP configuration watermark from UserDO',
        cause: err,
        otherwise: 'unavailable',
      }), { userId });
      return this._cachedMcpTools;
    }
    if (watermark === this._cachedMcpToolsKey && Object.keys(this._cachedMcpTools).length > 0) {
      return this._cachedMcpTools;
    }
    // Watermark = 0 means UserDO has never seen an MCP mutation. Skip the
    // descriptor fetch entirely so cold UserDOs don't pay for MCP plumbing.
    if (watermark === 0) {
      this._cachedMcpTools = {};
      this._cachedMcpToolsKey = 0;
      return this._cachedMcpTools;
    }

    let descriptors: SerializableToolDescriptor[];
    try {
      const answer = v.parse(
        McpToolSurfaceSchema,
        JSON.parse(await userDOStub.userMcp_toolDescriptors(caller)),
      );
      descriptors = answer.descriptors;
      // A configured server whose tools never arrived is stated in the turn's
      // dynamic context, not just logged: the model is otherwise left planning
      // around a capability it was promised and cannot see.
      this._mcpUnavailable = answer.unavailable.map((u) => ({
        source: `MCP server "${u.server}"`, reason: u.reason,
      }));
    } catch (err) {
      diagnostics.failure('mcp.descriptor_fetch_failed', toKinuError({
        doing: 'fetching the user MCP tool descriptors from UserDO',
        cause: err,
        otherwise: 'unavailable',
      }), { userId, watermark });
      return this._cachedMcpTools;
    }

    const tools: ToolSet = {};
    for (const d of descriptors) {
      const serverId = d.serverId;
      const mcpName = d.name;
      tools[d.toolKey] = tool({
        description: d.description ?? `${d.serverName}/${mcpName}`,
        inputSchema: jsonSchema<JsonObject>(d.inputSchema ?? { type: 'object' }),
        execute: async (args) => {
          try {
            const rawResult = await userDOStub.userMcp_callTool(caller, serverId, mcpName, args);
            return projectJsonValue({ value: v.parse(JsonValueSchema, JSON.parse(rawResult)) });
          } catch (err) { return { isError: true, error: renderThrownChain({ cause: err }) }; }
        },
      });
    }
    // An MCP server is a bulk producer like any other — a 2MB API response
    // rots the session exactly as a big `cat` does. Same clamp, same spill
    // path, same turn budget as the builtins.
    const clamped = withClampedToolResults(tools, {
      vfs: this.rt.storage.vfs, budget: this.acc.context, producer: 'external_tool',
    });
    this._cachedMcpTools = clamped;
    this._cachedMcpToolsKey = watermark;
    this.logActivity('mcp_tools_rebuilt', `${Object.keys(clamped).length} tools @ wm=${watermark}`);
    return clamped;
  }

  configureSession(session: Session): Session {
    // The agent's durable context is `getSystemPrompt()` (soul + tools) plus
    // the persisted conversation and the dynamic/turn-local context split —
    // a single source of truth, not Think's freezable context blocks. No
    // Session policy attaches here: compaction is the transformContext
    // extension (registerCompactionExtension), which rewrites the turn's
    // model-visible history without ever touching the stored messages.
    return session;
  }

  /** Resolved `<provider>/<modelId>` the next turn will actually use — the
   *  same resolution getModel() applies. Computing the threshold from the raw
   *  stored spec leaves an unset model on the generic context window instead
   *  of the resolved default model's real limit. Falls back to the raw spec
   *  only pre-claim (no provider registry yet). */
  private effectiveModelSpec(): string {
    const stored = this.getStoredModelId();
    try {
      return this.providerRegistry().normalizeSpecSync(stored);
    } catch {
      return stored ?? '';
    }
  }

  protected effectiveModelProviderFamily(): string {
    const spec = this.effectiveModelSpec();
    if (!spec) return '';
    return parseModelSpec(spec).provider;
  }

  /** Prompt model context from the RESOLVED spec. The raw stored id is null
   *  on default-configured agents, which used to leave model-family guidance
   *  inert on the primary hosted path — the same raw-spec class of bug
   *  effectiveModelSpec() fixed for the compaction threshold. */
  private promptModelContext(): PromptModelContext {
    const spec = this.effectiveModelSpec();
    if (!spec) return {};
    try {
      const { provider, modelId } = parseModelSpec(spec);
      return { id: modelId, provider };
    } catch {
      return { id: spec };
    }
  }

  /** The shared catalog view of the resolved model (core model-catalog):
   *  one cached, non-blocking lookup per spec; static fallbacks (window
   *  table / conservative media policy) answer until it lands. */
  private readonly modelCatalog = new ModelCatalogSession({
    effectiveSpec: () => this.effectiveModelSpec(),
    lookup: async (spec) => {
      if (!spec) return null;
      const { provider, modelId } = parseModelSpec(spec);
      const reg = this.providerRegistry();
      return catalogModelInfo(reg.registry.get(provider), reg.deps, modelId);
    },
  });

  /** The resolved model's context window — feeds the compaction extension
   *  through the transformContext seam. */
  protected sessionContextWindow(): number {
    return this.modelCatalog.contextWindow();
  }

  /** Media kinds the next turn's model request can carry — the attachment
   *  sanitizer's policy input (the proven Workers AI PDF-400 fix). */
  private sessionAcceptedMedia(): ReadonlySet<MediaModality> {
    return this.modelCatalog.acceptedMedia();
  }

  // ── Think lifecycle hooks ──────────────────────────────────────

  // Tools the model is allowed to call. Think merges workspace tools (read, write,
  // edit, list, find, grep, delete) with ours, bloating the request by ~2800 tokens.
  // activeTools restricts the model to the built-in tools + session context tools,
  // preventing Think's workspace tools from being sent in the request payload.
  // ACTIVE_TOOLS is sourced from @kinu.run/core/tools/registry (single truth).

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    // The scaffold and the soul are both files this turn is about to read, and
    // this is the first place with a promise to await them on.
    await this.ensureOwnedScaffold();
    if (this._cachedSoulText === null) await this.refreshSoulText();
    // Per-turn accounting reset + the turn's mission scope, together: what the
    // turn is allowed to spend is part of what the turn is.
    // The continuation flag resets mid-turn signal splice state: a continuation
    // turn re-absorbs the just-settled signals so they ride into it the way the
    // queued path's durable message does. Signals still waiting ride either way.
    this.orch.beginTurn(Date.now(), this.turnUserMetadata(), ctx.continuation);
    this._executorsUsedThisTurn.clear();
    const body = jsonObject(ctx.body);
    this._cliCwd = readCliCwd(body);
    this._turnContinuity = readTurnContinuity(body);
    this._inFlight = true;
    // Fresh splice coordinates for this streamText call. Steers already
    // buffered survive — they were typed for the turn that is about to run.
    this.userSteer.beginTurn();
    this.logActivity("beforeturn", "streamText() called next");
    // A real user message is the verdict on the previous turn — dispatch the
    // detached outcome review (Hermes-style forked background review). Runs
    // concurrently with this turn; never blocks it. Programmatic turns
    // (reactor / job wake) are not user verdicts.
    if (!this.lastUserTurnIsProgrammatic()) {
      this.orch.observeUserTurn(extractLastUserText(ctx.messages), this._turnContinuity);
    }
    // Start a new run for the event log, with provenance so cross-run history
    // (Supervise altitude) can show what kicked each run off. This is the chat
    // path → caused_by:'chat'; event-triggered runs set ingress_kind/trigger_id.
    this._currentRunId = `run-${nanoid()}`;
    // Tag this turn for device-side file checkpoints: the user message id is
    // what the web turn card holds, so restore-by-turn resolves directly.
    {
      const userMessages = this.messages.filter((m) => m.role === 'user');
      const lastUserId = userMessages[userMessages.length - 1]?.id;
      this._turnCheckpoint = { turnId: lastUserId ?? this._currentRunId, sessionId: 'default' };
    }
    openTurnRun(this.eventRecorder, this._currentRunId, {
      agentId: this.name,
      causedBy: 'chat',
      userMessage: extractLastUserText(ctx.messages),
      turnIndex: this.orch.sessionTurnIndex,
    });

    // ── Skills resolution for this turn (core turn-surface) ──────────────
    this._turnActiveSkills = null;
    // The actor's REAL tool surface: deps-gated builtins (report) are
    // advertised only when this actor class wires them, and the agents
    // ladder renders only the actions this profile supports — then
    // restricted to the active skills' allowed union (core turn-surface).
    const turnActorDeps = this.actorToolDeps();
    const workMode = this.turnWorkMode();
    let activeTools: BuiltinToolName[] = actorActiveTools(turnActorDeps);
    const { available: availableSkills, activeSkills: activeSetForPrompt } = await resolveTurnSkills({
      vfs: this.getSkillsVfs(),
      config: this.config,
      userText: extractLastUserText(ctx.messages),
    });
    if (activeSetForPrompt) {
      this._turnActiveSkills = activeSetForPrompt;
      activeTools = filterToolNamesBySkills(activeTools, activeSetForPrompt);
      this.logActivity('skills_active',
        activeSetForPrompt.active.map(s => s.name).join(',') || '(none)');
    }

    // Per-user MCP tools — fetched from UserDO, dispatched back via RPC.
    // Failure is non-fatal; the turn proceeds with builtins only and the UI
    // surfaces the broken-server status via /api/user/mcp/servers polling.
    let mcpTools: ToolSet = {};
    try { mcpTools = await this.buildUserMcpTools(); }
    catch (err) {
      diagnostics.failure('mcp.tool_surface_failed', toKinuError({
        doing: 'building the user MCP tool adapters for this turn',
        cause: err,
        otherwise: 'unavailable',
      }));
    }

    // Expose MCP tool keys to the active-tools allowlist so Think doesn't
    // strip them out. Builtin names + MCP `mcp_<server>_<name>` keys are
    // disjoint by construction (assertion above).
    const mcpToolNames = Object.keys(mcpTools);
    const planToolNames = workMode === 'plan' && turnActorDeps.submitPlan ? ['submit_plan'] : [];
    const effectiveActiveTools = [...activeTools, ...planToolNames, ...mcpToolNames];
    const effectiveTools = mcpToolNames.length > 0 ? mcpTools : undefined;

    // ── Per-turn device awareness ────────────────────────────────
    // One authoritative hub check (a cheap DO-to-DO RPC) so the executor list
    // below reflects the CURRENT device state — the transport's TTL-cached
    // snapshot can lag a mid-session `kinu connect` by a turn. The persisted
    // watermark is only a diff anchor for the one-turn change notice; the hub
    // stays the single source of truth.
    let deviceNotice: string | null = null;
    try {
      const status = await this.rt.deviceTransport.refreshStatus();
      deviceNotice = observeDevicePresence(this.config, status).notice;
    } catch (err) {
      diagnostics.failure('device.status_refresh_failed', toKinuError({
        doing: 'refreshing the device hub presence for this turn',
        cause: err,
        otherwise: 'unavailable',
      }));
    }

    // AGENTS.md (agents.md standard) — agent VFS root + the sandbox workspace
    // when one is already active. Like skills/MCP, this is turn-scoped state,
    // so it rides the beforeTurn system override, not the cached base prompt.
    const agentsMd = await collectWorkspaceAgentsMd(
      this.rt.storage.vfs,
      this.rt.executionRouter?.getProvider('sandbox') ?? undefined,
    );

    // The per-turn system prompt is ALWAYS assembled here (TurnConfig.system
    // overrides) — Think calls getSystemPrompt() BEFORE beforeTurn, so only
    // this path can reflect the turn's active skills and MCP tools. It is the
    // byte-stable cache prefix: it changes only on real agent events (soul,
    // model, skill set, tool surface, AGENTS.md). System state — facts, the
    // live executor status — rides the dynamic ledger's frozen blocks, and
    // turn-local state — the device notice, activation reasons — rides one
    // trailing message (prompting/volatile-context.ts), so neither ever
    // re-prefills the prefix.
    const execs = this.rt.executionRouter?.listExecutors() ?? [];
    const model = this.promptModelContext();
    const promptOptions: NonNullable<Parameters<typeof buildSystemPromptSync>[1]> = {
      soulOverride: this.getSoulText(),
      executors: execs,
      availableTools: activeTools,
      agentsActions: actorAgentsActions(turnActorDeps),
      // `createRLMProvider` is unconditional in buildCfExecuteTools, so
      // `llm.query` is wired on every turn this backend runs. Omitting the flag
      // here defaulted it false and made the ONE authoritative prompt (this
      // object; TurnConfig.system overrides getSystemPrompt's cached base) the
      // only surface that never said so — 143 tokens of decomposition doctrine
      // and the ladder's zeroth rung, absent from every shipped turn.
      rlmAvailable: true,
      externalTools: mcpToolNames.map((name) => ({ name, source: 'mcp' as const })),
      backend: 'cf',
      workMode,
      provenance: this.turnProvenance(),
      stance: this.config.getStance(),
      planSubmissionAvailable: workMode === 'plan' && turnActorDeps.submitPlan !== undefined,
      model,
      currentDate: currentDateForPrompt(),
      // Prompt sections the evolution loop promoted. Read here, not inside the
      // builder: the builder is the byte-stable cacheable prefix and does no
      // I/O, exactly as with the soul.
      sectionOverrides: activePromptSectionOverrides(this.rt.storage.sql),
    };
    if (availableSkills.length > 0) promptOptions.availableSkills = availableSkills;
    if (activeSetForPrompt) promptOptions.activeSkills = activeSetForPrompt;
    if (agentsMd.length > 0) promptOptions.agentsMd = agentsMd;
    const systemOverride = buildSystemPromptSync(this.rt, promptOptions);
    this.recordSystemPromptHash(systemOverride);

    const cfg: TurnConfig = { system: systemOverride };

    // The measured compaction trigger, read from the durable state by core in
    // the one correct order (orchestrator/turn-context.ts). Attachment
    // sanitization is per-part in-place replacement, so the raw count IS the
    // sanitized durable length — and it is stashed because
    // recordTurnTelemetry writes the next measurement against the same number.
    const rawMessages = this._cliCwd ? withCliCwdContext(ctx.messages, this._cliCwd) : ctx.messages;
    this._turnDurableLength = rawMessages.length;
    this._turnContextWindow = this.sessionContextWindow();
    const measured = measureCompactionTrigger(this.compactionState, this.name, rawMessages.length);
    // The forced rebuild was armed either by overflow recovery (onChatResponse,
    // on a context_length failure) or by the agent itself (agent.compactNow).
    if (measured.trigger === 'force') this.logActivity('compaction_forced', 'forced context rebuild');
    // The newest MEMORY.md lessons/reflections ride the dynamic block too (the
    // same bounded tail the CLI supplies) — the reflection loop assumes the
    // model sees its latest lessons in-turn. Read once here rather than per
    // step: it is the one dynamic-context input that needs an await.
    this._turnMemoryTail = await readMemoryTail(this.rt.memory);
    const turnLocalOptions: Parameters<typeof turnLocalContextMessage>[0] = { deviceNotice };
    if (this._turnActiveSkills) turnLocalOptions.activeSkills = this._turnActiveSkills;
    const turnLocal = turnLocalContextMessage(turnLocalOptions);
    // The shared turn-context assembly (core orchestrator/turn-context.ts) —
    // the SAME ordering runChat runs on the CLI: attachment sanitize →
    // extension onTurnStart → awaited transformContext (compaction, over the
    // DURABLE history only) → turn-local tail. Dynamic context is NOT assembled
    // here: it is re-read and re-woven at every step by beforeStep.
    const assembly: Parameters<typeof assembleTurnMessages>[0] = {
      system: systemOverride,
      history: rawMessages,
      attachments: {
        accepts: this.sessionAcceptedMedia(), vfs: this.rt.storage.vfs, budget: this.acc.context,
      },
      extensions: this.extensions,
      turnLocal: turnLocal ? [turnLocal] : [],
      sessionKey: this.name,
      contextWindow: this._turnContextWindow,
      trigger: measured.trigger,
    };
    if (measured.providerReportedTokens !== undefined) {
      assembly.providerReportedTokens = measured.providerReportedTokens;
    }
    cfg.messages = await assembleTurnMessages(assembly);

    // Extension-contributed tools join the turn's ToolSet without ever
    // shadowing a built-in or MCP tool (runChat's merge order, mirrored:
    // caller tools win, only extension-vs-extension collisions throw).
    const extensionTools = Object.fromEntries(
      Object.entries(this.extensions.tools())
        .filter(([name]) => !(name in ctx.tools) && !(name in mcpTools)),
    );
    const extensionToolNames = Object.keys(extensionTools);
    const extraTools: ToolSet = { ...extensionTools, ...effectiveTools };
    if (Object.keys(extraTools).length > 0) cfg.tools = extraTools;
    cfg.activeTools = extensionToolNames.length > 0
      ? [...effectiveActiveTools, ...extensionToolNames]
      : effectiveActiveTools;

    // Prompt-cache plan for this turn — the same core derivation `runChat`
    // uses (prompting/cache-breakpoints.ts `promptCachePlan`), so a change to
    // strategy resolution, system eligibility or routing reaches both loops.
    // Only the message tail differs: request-level cache routing rides
    // TurnConfig.providerOptions, while the cache-eligible system message and
    // the rolling tail breakpoints for marker providers (Anthropic) ride
    // beforeStep — PrepareStepResult carries typed system/messages overrides
    // for every step's request, whereas TurnConfig.system is string-typed.
    const cachePlan = promptCachePlan({
      providerId: model.provider,
      modelId: model.id,
      system: systemOverride,
      sessionKey: this.ownedModelServices.affinityKey,
      retention: this.config.getCacheRetention(),
    });
    this._turnCachePlan = hasCacheMarkers(cachePlan.strategy)
      ? { strategy: cachePlan.strategy, system: cachePlan.system }
      : null;
    const cacheOptions = cachePlan.providerOptions;
    const reasoningOptions = reasoningEffortOptions(
      this.config.getReasoningEffort() ?? REASONING_EFFORT_FOR_STAGE.chat,
      this.effectiveModelProviderFamily(),
    );
    const providerOptions = mergeProviderOptions(cacheOptions, reasoningOptions);
    if (providerOptions) cfg.providerOptions = providerOptions;

    // Shadow-eval context parity + the evolved-scaffold task source (see the
    // _lastTurnOpts field doc): the effective opts the streamText Think runs
    // next will see — final system/messages/merged tools/model. Think only
    // adds its tool-decision wrapping and, per step, the cache markers and the
    // dynamic-context block — all inert for a replay.
    const lastTurnOpts: Parameters<typeof streamText>[0] = {
      model: ctx.model,
      system: systemOverride,
      messages: cfg.messages,
      tools: { ...ctx.tools, ...cfg.tools },
      activeTools: cfg.activeTools,
      stopWhen: stepCountIs(this.maxSteps),
    };
    if (providerOptions) lastTurnOpts.providerOptions = providerOptions;
    this._lastTurnOpts = lastTurnOpts;
    // The turn's constants for the per-step context breakdown. Tool schemas
    // ride every request of the turn and are otherwise invisible to anyone
    // asking where the window went.
    this.acc.composition.openTurn({ system: systemOverride, tools: this._lastTurnOpts.tools });
    return cfg;
  }

  /** The in-flight turn's prompt-cache plan — set in beforeTurn, non-null only
   *  for marker strategies (Anthropic / OpenRouter-Claude), whose breakpoints
   *  beforeStep re-rolls onto the newest tail each step. */
  private _turnCachePlan: { strategy: PromptCacheStrategy; system: string | SystemModelMessage } | null = null;

  /** The in-flight turn's resolved context window — set in beforeTurn, read
   *  by beforeStep's prune budget every step. */
  protected _turnContextWindow = 0;

  /** The bounded MEMORY.md tail read at turn assembly — the one dynamic-context
   *  input behind an await, so the per-step snapshot closes over it. */
  private _turnMemoryTail: string | undefined;

  /**
   * The live state of this agent, read fresh for ONE model step.
   *
   * Every field comes from its existing store — nothing here holds state of its
   * own — and nothing is clock-derived: a wall-clock field would re-fingerprint
   * the block on every request and append a block per step.
   */
  protected dynamicContextSnapshot(): DynamicContext {
    return collectDynamicContext({
      rt: this.rt,
      stores: this.stores,
      memoryTail: this._turnMemoryTail,
      missingCapabilities: this._mcpUnavailable,
    });
  }

  beforeStep(ctx: PrepareStepContext): StepConfig | void {
    // The shared step pipeline (core prompting/prepare-step.ts, identical on
    // the CLI): extension prepareStep rewrites first, step-boundary tool-output
    // pruning against the window budget next, then the dynamic-context weave,
    // then the cache plan rolls the tail breakpoints onto the FINAL message
    // array so each request of the agentic loop reads the prefix the previous
    // step wrote.
    return composePrepareStep({
      extensions: this.extensions,
      cache: this._turnCachePlan,
      prune: this._turnContextWindow > 0 ? { contextWindow: this._turnContextWindow } : null,
      budget: this.budget,
      dynamic: { ledger: this.dynamicLedger, snapshot: () => this.dynamicContextSnapshot() },
      meter: this.acc.composition,
    }, { stepNumber: ctx.stepNumber, messages: ctx.messages });
  }

  /** The byte-stability invariant as telemetry: the system prompt hash should
   *  change only on real agent events (soul/skill/craft/device/model), never
   *  between two vanilla consecutive turns. A "(changed)" entry in the
   *  activity log without a nearby skills_active / device / craft event is a
   *  cache-prefix regression. */
  private _lastSystemPromptHash: string | null = null;
  private recordSystemPromptHash(system: string): void {
    const { hash, status } = observeSystemPromptHash(this._lastSystemPromptHash, system);
    this._lastSystemPromptHash = hash;
    this.logActivity('system_prompt_hash', status === 'first' ? hash : `${hash} (${status})`);
  }

  onChunk(_ctx: ChunkContext): void {
    this.acc.onFirstChunk();
  }

  /** Whether the in-flight turn was injected programmatically (an event drain,
   *  a background-job wake, an overflow retry) — a queued signal stamps
   *  kinuEvent metadata on the saved user message; real chat messages carry
   *  none. */
  protected lastUserTurnIsProgrammatic(): boolean {
    return this.turnUserMessageEvent(null) !== null;
  }

  /** The surface THIS turn runs on. A chat turn is interactive — a human is
   *  watching the stream, so slow work must hand back a handle fast. Anything
   *  driven by a queued signal (an event drain, a background-job wake, a timer,
   *  an overflow retry) has nobody watching and is one-shot: detaching there
   *  buys nothing and costs a truncated turn plus a synthesis turn, and the
   *  model answers by polling its own jobs instead of working. */
  protected turnSurface(): SessionSurface {
    // Two independent ways a turn can have nobody watching a stream, and both
    // count. A CLI one-shot invocation against this workspace stamps `oneShot`
    // on the request body (readTurnContinuity → 'independent_task'). A turn a
    // queued signal drove — an event drain, a background-job wake, a timer, an
    // overflow retry — carries `kinuEvent` metadata on the message that
    // drives it, the same discriminator every other programmatic-turn decision
    // reads. Continuity alone would miss the whole autonomous population,
    // which is the population the one-shot policy was measured on.
    const programmatic = this.turnUserMessageEvent(this._activeProgrammaticUserMessage) !== null;
    return programmatic || this._turnContinuity === 'independent_task' ? 'one-shot' : 'interactive';
  }

  /** The turn's kinuEvent metadata value — from the active programmatic
   *  message when one drove the turn, else the last durable user message.
   *  Null for real chat turns. */
  protected turnUserMessageEvent(programmaticUserMessage: { metadata?: unknown } | null): string | null {
    const metadata = programmaticUserMessage ? programmaticUserMessage.metadata : this.turnUserMetadata();
    const parsed = v.safeParse(JsonObjectSchema, metadata);
    if (!parsed.success) return null;
    return v.is(v.string(), parsed.output.kinuEvent) ? parsed.output.kinuEvent : null;
  }

  /** What the turn may do. Plan is explicit user intent on the driving
   * message; everything else is ordinary unconstrained work. */
  protected turnWorkMode(): WorkMode {
    return workModeForTurnMetadata(this.turnDrivingMetadata());
  }

  /** Why the turn is running — read from the event alone, never from the work
   * mode stamped beside it. */
  protected turnProvenance(): TurnProvenance {
    return turnProvenanceForMetadata(this.turnDrivingMetadata());
  }

  /** The metadata of the message driving this turn: the active programmatic
   * message when one drove it, else the last durable user message. Parsed at
   * this boundary so both axes read one already-narrowed shape. */
  private turnDrivingMetadata(): JsonObject | undefined {
    if (!this._activeProgrammaticUserMessage) return this.turnUserMetadata();
    const parsed = v.safeParse(JsonObjectSchema, this._activeProgrammaticUserMessage.metadata);
    return parsed.success ? parsed.output : undefined;
  }

  /** What this turn was started BY: the metadata on the message that drives it
   *  — a signal's `kinuEvent` / `signalId` / mission labels, or nothing at
   *  all for a chat turn the operator typed. */
  protected turnUserMetadata(): JsonObject | undefined {
    const source = this.messages.filter(m => m.role === 'user').at(-1);
    if (!source) return undefined;
    const parsed = v.safeParse(JsonObjectSchema, source.metadata);
    return parsed.success ? parsed.output : undefined;
  }

  async beforeToolCall(ctx: ThinkToolCallContext): Promise<void> {
    // Extension observation before the tool's execute runs (returning void =
    // allow with the original input — the seam observes, it does not gate).
    await this.extensions.emitToolCall({
      toolName: ctx.toolName,
      args: jsonObject(ctx.input),
    });
  }

  async afterToolCall(ctx: ToolCallResultContext): Promise<void> {
    // Think 0.4 shape (toolName/input/output/success/durationMs) → the core
    // accumulator records it + fires the activity log + run-event sinks.
    const input = jsonObject(ctx.input);
    const recorded: Parameters<TurnAccumulator['recordToolCall']>[0] = {
      toolName: ctx.toolName,
      input,
      durationMs: ctx.durationMs,
      success: ctx.success,
    };
    if (ctx.success && ctx.output !== undefined) recorded.output = projectJsonValue({ value: ctx.output });
    if (!ctx.success) recorded.error = ctx.error;
    this.acc.recordToolCall(recorded);
    await this.extensions.emitToolResult({
      toolName: ctx.toolName,
      args: input,
      // Same shape the CLI seam emits: the FULL stringified result. The turn
      // steering hashes this as the call's identity and reads it to decide
      // failure, so a head slice made two different outputs sharing a long
      // preamble indistinguishable and hid every >1000-char structured error.
      result: String(ctx.success ? ctx.output ?? '' : ctx.error ?? ''),
      success: ctx.success,
    });
  }

  onStepFinish(ctx: StepContext): void {
    // The SDK seam. Two things are read here and nowhere else: the provider's
    // usage dialect, normalized once so everything downstream speaks `Usage`,
    // and the getter-backed fields of the SDK's StepResult — `text`,
    // `toolCalls` and `toolResults` live on its PROTOTYPE (ai
    // dist/index.js:3964-3994), so handing the object on by spread would drop
    // them and the step would log as empty.
    this.acc.recordStep({
      text: ctx.text,
      finishReason: ctx.finishReason,
      toolCalls: ctx.toolCalls,
      toolResults: ctx.toolResults,
      usage: normalizeUsage(ctx.usage),
      response: ctx.response,
    });
  }

  /** The shared background wrap (core jobs/background-wrap): shallow clone, 30s
   *  threshold on the named set (with its per-call gate — `agents` detaches only
   *  the search rung), per-call AbortController merged with the turn's signal. The
   *  tracking hook keeps foreground cancellation working until a call settles or
   *  detaches. An ACTOR names the full set; a confined surface names its own, which
   *  is what keeps containment structural rather than incidental. */
  private wrapToolsForBackground(raw: ToolSet): ToolSet {
    return wrapToolsForBackground(raw, {
      jobRunner: this.jobRunner,
      backgroundable: BACKGROUNDABLE_TOOLS,
      mode: () => this.turnWorkMode(),
      trackController: (controller) => {
        this._activeToolControllers.add(controller);
        return () => this._activeToolControllers.delete(controller);
      },
    });
  }

  /** Model for review/judge tasks: the operator's `review_model`, else a
   *  different-vendor model when one is connected, else the chat model — the
   *  self-preference policy in core's selectJudgeModel. Async because
   *  cross-family availability is a credential-aware registry query; the
   *  answer is cached until the owner's provider set is invalidated. */
  protected getModelForReview(): Promise<import('ai').LanguageModel> {
    return this.ownedModelServices.resolveJudgeModel({
      reviewSpec: this.config.getRoleModel('judge'),
      chatSpec: this.getStoredModelId(),
    });
  }

  // ── Fiber recovery — durable execution surviving DO eviction ──
  //
  // The MCTS engine (mcts/engine.ts) calls rt.schedule.fiber('mcts', fn) which
  // delegates to agent.runFiber(). Per-iteration ctx.stash(phase) checkpoints
  // progress to cf_agents_runs. If the DO is evicted mid-MCTS, the Agent SDK
  // re-invokes onFiberRecovered with the last snapshot on cold-start.
  //
  // The default base implementation just warns; we override to:
  //   • log the recovery into evolution_events for the UI
  //   • broadcast a "recovered" event so the chat panel can show the resume
  //   • write a memory note so future turns know about the interruption
  override async onFiberRecovered(ctx: {
    id: string;
    name: string;
    snapshot: unknown;
    createdAt: number;
  }): Promise<void> {
    try {
      const snapshot = ctx.snapshot === null || ctx.snapshot === undefined
        ? null
        : projectJsonValue({ value: ctx.snapshot });
      const summary = JSON.stringify(snapshot).slice(0, 400);
      diagnostics.event('fiber.recovered', { fiber: ctx.name, fiberId: ctx.id });
      // Background-job fiber (bg:*) is operational plumbing, not an evolution
      // event: the runner re-fails + wakes an orphaned 'running' job (a 'settled'
      // one already recorded its outcome + woke), skipping the MEMORY.md note +
      // evolution_events INSERT that the user-facing recovery path emits.
      if (ctx.name.startsWith('bg:')) {
        await this.jobRunner.recover(snapshot);
        // A cold start is also the moment to settle jobs whose fiber row did
        // NOT survive with them: nothing in this isolate owns a job yet, so any
        // other row still marked `running` is an orphan no recovery callback
        // will ever arrive for.
        await this.jobRunner.recoverOrphans();
        return;
      }
      // Persist for the UI's evolution-events stream.
      void this.sql`INSERT INTO evolution_events (id, type, message, data, created_at)
        VALUES (${nanoid()}, 'fiber_recovered',
                ${`Fiber "${ctx.name}" recovered after interruption`},
                ${JSON.stringify({ name: ctx.name, fiberId: ctx.id, snapshot, createdAt: ctx.createdAt })},
                ${Date.now()})`;
      await this.rt.memory.append(
        'memory/MEMORY.md',
        `\n### Fiber recovery (${new Date().toISOString().split('T')[0]})\n` +
        `Fiber "${ctx.name}" was interrupted (likely DO eviction) and recovered. ` +
        `Snapshot at interruption: ${summary}\n`,
      );
    } catch (err) {
      diagnostics.failure('fiber.recovery_failed', toKinuError({
        doing: 'handling a fiber recovered after eviction',
        cause: err,
        otherwise: 'io',
      }), { fiber: ctx.name, fiberId: ctx.id });
    }
  }

  /** Invalidate every cache that depends on the resolved model so the next
   *  getModel() / providerRegistry() call rebuilds. */
  protected invalidateModelCaches(): void {
    // Drops the resolved model AND the provider registry, which caches
    // per-agent OAuth refreshers — rebuilt so a disconnected provider stops
    // being marked available.
    this.ownedModelServices.invalidate();
  }

  // ── Credentials & Codex OAuth ─────────────────────────────────────
  //
  // All credentials live in UserDO (single source of truth across the user's
  // agents). The orchestrator no longer stores, refreshes, or even reads
  // raw credentials — providers resolve auth headers through the UserDO
  // stub at fetch time. Use the `/api/user/codex/*` routes (or the user
  // settings UI) to connect ChatGPT / save BYO API keys.

  /** Worker fan-out target (user/workspace-access notifyWorkspacesCredentialsChanged):
   *  invoked after credential mutations in UserDO so cached provider/model
   *  state in this agent is dropped. Cheap; no-op if nothing is cached. */
  async onCredentialsChanged(): Promise<{ ok: true }> {
    this.invalidateModelCaches();
    return { ok: true };
  }

  // ── Internal: MCTS session writer ──────────────────────────────

  private createMCTSSession(): SessionWriter {
    // The shared durable writer (core mcts-session): the messages table is
    // the source of truth so a resumed search reconstructs ancestry (B6).
    return createDurableMctsSession(this.boundSql);
  }

  /** Re-drive an evicted background job from its durable checkpoint (B6) —
   *  the shared resume gate (core background-tools) over the RAW surface, so a
   *  re-drive can't detach a second job. Rows stored under the removed `fork`
   *  action, and 'think' rows older still, translate onto the search path. */
  protected resumeBackgroundJob(
    kind: string,
    input: JsonValue,
    mode: WorkMode,
    signal: AbortSignal,
  ): Promise<JsonValue | undefined> {
    return resumeBackgroundJob(
      (resumeMode) => this.getRawToolsForWorkMode(resumeMode),
      kind,
      input,
      mode,
      signal,
    );
  }
}
