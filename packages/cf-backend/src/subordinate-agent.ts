import * as v from 'valibot';
import { callable, getAgentByName, type AgentContext, type SubAgentClass } from 'agents';
import { SUBORDINATE_AGENT_BOOT_SURFACE, EXPLORATION_RPC_SURFACE, SUBORDINATE_RPC_SURFACE, sealRpcSurface } from './rpc-surface';
import type { ChatResponseResult } from '@cloudflare/think';
import {
  EvolutionEngine,
  initWorkspaceSchema,
  renderSoulMarkdown,
  snapshotCompletedTurn,
  projectJsonValue, nanoid,
  shadowTrialPlan, trimTrialContext,
  type SubordinateEventResult,
  type SubordinateHandoff,
  type WorkMode,
  type SubordinateReportStatus,
  type SubordinateLifetime,
  type TaskTurnEnding,
  temporaryRunSettles,
  terminalTaskReport,
  // report.* — codemode projection of the native `report` tool.
  createReportCodemodeProvider, type CodemodeProvider,
  type DelegationBudget,
  type PlanReview,
  planReviewAwaitingDecision,
  subordinateDescriptorSource,
  type InlineSteer,
  type RoleId,
  type TierId,
  type InstructionApproval,
  type PromptIdentity,
  TIER_IDS,
} from '@kinu.run/core';
import {
  terminalEffect, declareTerminalRoster, SUBORDINATE_REPORT_STATUSES,
  WorkModeSchema,
  type TerminalEffectTable,
} from '@kinu.run/core';
import {
  ActorAgent,
  type ActorToolDeps,
} from './actor-agent';
import type { AgentKind } from './analytics/record';
import type { OrchestratorAgent } from './orchestrator';
import { createWorkspaceBoxClient, workspaceBoxOwner } from './workspace-box-rpc';
import type { HostedFacetHomes } from './node-home';
import { agentCred, agentHome, agentTmpRoot, subordinateAgentName, type NimbusSandboxHandle } from '@kinu.run/core';
import {
  SubordinateIdentityStore,
  admitSubordinateTask,
  describeSubordinateHandoff,
  readSubordinateLiveStatus,
  subordinateRelaysTurnEnd,
  type SubordinateReportOrigin, type SubordinateLiveStatus,
  type TerminalTurnParts,
} from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { MODEL_OPERATION_LANE_FIBER, TERMINAL_LANE_FIBER } from './fiber-recovery';
import { generateText, type ToolSet } from 'ai';
import {
  beginModelOperation,
  explorePrompt,
  formatInheritedContext,
  isWorkMode,
  normalizeUsage,
  reflectionPrompt,
  resolveModelRoute,
  type BranchExploration,
  type BranchReflection,
  type CraftedTool,
  type Decision,
  type HeadBudget,
  HeadCapture,
  type HeadId,
  type HeadInput,
  type HeadJournalPort,
  type HeadReport,
  type HeadStep,
  type MergeResult,
  type MergeStrategy,
  type MissionScope,
  type ModelOperationEvent,
  type ModelOperationSink,
  type NodeLoopDeps,
  type NodeLoopResult,
  type NodeRunSpec,
  type ReportHeadDelta,
  type ResolvedTurnProfile,
  type WebSearchProvider,
  HeadController,
  buildHeadToolSet,
  runHeadInference,
  runNodeLoop,
  MODEL_OPERATION_KINDS, MODEL_OPERATION_OUTCOMES, MODEL_OPERATION_PHASES, SPEND_SOURCES,
} from '@kinu.run/core';
import { createConsoleLogger, renderThrownChain } from '@kinu.run/core/obs';
import { OwnedModelServices } from './owned-model-services';
import { FacetIdentity } from './facet-identity';
import { FacetActivation } from './facet-activation';
import { createHeadRuntime } from './head-runtime';
import {
  createCFRuntime,
  type CFRuntime, type CFRuntimeHooks, type HostedNodeHome,
} from './runtime';
import { createExecuteToolsFactory } from './execute-tools';
import { codemodeEgress } from './codemode-egress';
import { forwardFacetModelOperation } from './obs/facet-operations';
import { openAnalyticsWindow } from './analytics/writer';
import type { UserCaller } from './user/workspace-capability';

/** The workspace root's class name, which is also its Durable Object binding
 *  name — the equality the SDK itself relies on when it resolves a top-level
 *  parent as `env[cls.name]`. `satisfies keyof Env` keeps it tied to the binding. */
const WORKSPACE_ACTOR_CLASS = 'OrchestratorAgent' satisfies keyof Env;

export interface SetSubordinateIdentityInput {
  name: string;
  /** The title to seed. EMPTY is legal and meaningful: the owner added this
   *  agent without naming it, so it has no honest title yet and the
   *  first-interaction policy will give it one. */
  displayName: string;
  /** Whose title `displayName` is — `auto` for anything derived or blank,
   *  `user` for one the owner typed. `user` is what makes auto-titling
   *  refuse for good (`planWorkspaceTitle`). */
  nameOrigin: 'user' | 'auto';
  /** Current role id. The child's agent_config row is authoritative. */
  role: RoleId;
  /** Optional tier override for this child. */
  tier?: TierId | null;
  mission: string;
  /** How long this child is meant to live. It rides the SEED because only the
   *  child sees its own turn end, and a `task` child owes its blocked caller one
   *  terminal report for every way that turn can end. */
  lifetime: SubordinateLifetime;
  /** The PARENT workspace's capability token, pushed down at spawn so this
   *  facet reaches the owner's UserDO as its workspace — and is attenuated
   *  with it. Refreshed by the parent's installWorkspaceCapability fan-out if
   *  it is ever reissued. */
  capabilityToken?: string;
}

/** Both report lanes are fire-and-forget, so a rejection has nowhere to go but
 *  a log line. `lane` names which one — the event name stays literal. */
function reportSubordinateFailure(lane: string) {
  return <Thrown,>(thrown: Thrown): void => {
    diagnostics.failure('subordinate.report_failed', toKinuError({
      doing: 'reporting to the parent workspace',
      cause: thrown,
      otherwise: 'unavailable',
    }), { lane });
  };
}

const ModelOperationEventSchema = v.object({
  operationId: v.string(),
  source: v.picklist(SPEND_SOURCES),
  op: v.picklist(MODEL_OPERATION_KINDS),
  phase: v.picklist(MODEL_OPERATION_PHASES),
  outcome: v.optional(v.picklist(MODEL_OPERATION_OUTCOMES)),
  usage: v.optional(v.object({
    input: v.optional(v.number()),
    output: v.optional(v.number()),
    cacheRead: v.optional(v.number()),
    cacheWrite: v.optional(v.number()),
    cacheWrite1h: v.optional(v.number()),
    reasoning: v.optional(v.number()),
    neurons: v.optional(v.number()),
  })),
  spec: v.optional(v.string()),
  modelId: v.optional(v.string()),
  error: v.optional(v.string()),
});

interface ModelOperationOutboxRow {
  readonly id: number;
  readonly event_json: string;
}

interface ModelOperationDrain {
  promise: Promise<void> | null;
}

/**
 * One turn of the conversation a BRANCH is asked to continue from.
 *
 * Named rather than left as an inline `{ role, content }` on the RPC signature: this
 * is a public `@callable` boundary, so the shape is a contract two isolates agree on
 * and the caller's own value is checked against a name rather than against a literal
 * repeated at the call site.
 */
interface PriorTurn {
  readonly role: string;
  readonly content: string;
}

/** One head a recursive split asks for: what it works on, and why it exists. Named
 *  for the same reason {@link PriorTurn} is — it crosses the facet-spawn boundary. */
interface SubheadRequest {
  readonly task: string;
  readonly rationale: string;
}

/** The one UserDO method an exploration facet's credential compare reads. Named
 *  as a contract rather than asserted through `unknown`: the namespace binding
 *  already declares the method, so the narrow shape is a statement about what
 *  this caller is allowed to reach, and it is checked. */
interface CredentialsRevisionReader {
  getCredentialsRevision(caller: UserCaller): Promise<number>;
}

/** Which family a facet was seeded into, read off its durable rows. */
export type FacetKind = 'subordinate' | 'head' | 'node' | 'branch';

export class SubordinateAgent extends ActorAgent {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, SUBORDINATE_AGENT_BOOT_SURFACE);
  }

  /** A persistent helper facet inside someone else's workspace. Distinct from
   *  the orchestrator on the operational dataset because its turns are the
   *  delegated ones, and a rate that pools the two answers no question. */
  protected actorKind(): AgentKind {
    return 'subordinate';
  }

  private _schemaReady = false;
  private _identity: SubordinateIdentityStore | null = null;
  private _engine: EvolutionEngine | null = null;
  private reportedThisTurn = false;
  /**
   * Has a report that SETTLES a temporary run already gone out this turn?
   *
   * A second bit rather than a reuse of {@link reportedThisTurn}, because the two
   * questions are genuinely different and conflating them hung an ask: a task
   * child is invited to file a mid-task `progress` note, that note sets
   * `reportedThisTurn`, and `temporaryRunSettles` correctly does NOT treat it as
   * the answer — so a child that filed one and then answered had its terminal
   * report suppressed while its caller waited forever. `reportedThisTurn` still
   * means "spoke this turn", which is what the DURABLE relay policy asks; this
   * means "already answered", which is what the temporary rung asks.
   */
  private settledRunThisTurn = false;

  private get identity(): SubordinateIdentityStore {
    if (!this._identity) this._identity = new SubordinateIdentityStore(this.ctx.storage.sql);
    return this._identity;
  }

  /**
   * This subordinate's own room in the tree, read from the identity row its
   * parent seeded — DURABLE, which is the point. A Durable Object is evicted
   * routinely, so a depth held only in memory would reset on resume and let a
   * woken subordinate rebuild the whole tree beneath itself; storage is what
   * makes the cap a cap rather than a property of trees that never sleep.
   * An unseeded facet reads as exhausted (support.ts delegationBudget), so
   * "nobody has told me where I am" can never come out as "I am the root".
   */
  protected delegationBudget(): DelegationBudget {
    return this.identity.delegationBudget();
  }

  /** A hire and a split alike run as the class this facet is. */
  facetClass(): SubAgentClass<SubordinateAgent> {
    return SubordinateAgent;
  }

  /**
   * Which family this facet was seeded into, read off its durable rows — the
   * address discriminant the shared roster and report ingress key on. A
   * subordinate row wins: it is only ever written by the hire seed. An
   * activation row names a head or a node. Neither row means an exploration
   * facet whose mode needs no init (an MCTS branch), which builds no tools
   * and acquires no runtime.
   */
  protected facetKind(): FacetKind {
    // The rows decide, so their tables exist first. Flag-guarded, so asking
    // twice costs one schema build.
    this.ensureSchema();
    if (this.identity.read()) return 'subordinate';
    if (this.activation.headInput()) return 'head';
    if (this.activation.nodeSpec()) return 'node';
    return 'branch';
  }

  /**
   * Narrow this instance's stub-reachable surface to the exploration family's.
   * The constructor seals the boot union; the seed that decides the family
   * shadows the other family's names the same way, so a head cannot reach a
   * subordinate seed across a stub (and the reverse). In-process calls are
   * untouched — the seal only governs stub resolution.
   */
  private sealExplorationSurface(): void {
    sealRpcSurface(this, EXPLORATION_RPC_SURFACE);
  }

  /** The subordinate family's half of {@link sealExplorationSurface}. */
  private sealSubordinateSurface(): void {
    sealRpcSurface(this, SUBORDINATE_RPC_SURFACE);
  }

  // ── Exploration-mode state (a subordinate turn never touches these) ──
  private headInput: HeadInput | null = null;
  private headAborted = false;
  private headAbortReason: string | null = null;
  private nodeSpec: NodeRunSpec | null = null;

  /** Owner, capability token and parent workspace — one store, one schema.
   *  Every accessor below is a THUNK, never a construction-time value: a facet's
   *  logical `name` and its seeded identity are both set by the async
   *  `_cf_initAsFacet` AFTER this field initializes. */
  private readonly facetIdentity = new FacetIdentity(this.ctx.storage.sql);

  /** What this facet was initialized to RUN, durably. The instance fields above
   *  are the warm path; this is what makes an acked bootstrap survive an
   *  eviction between the init RPC and the run RPC. */
  private readonly activation = new FacetActivation(this.ctx.storage.sql);

  private readonly facetModelServices = new OwnedModelServices({
    env: this.env,
    agentName: () => this.name,
    appTitle: 'Kinu (exploration)',
    ownerRequired: false,
    getOwnerUserId: () => this.facetIdentity.ownerUserId(),
    getUserCaller: async () => {
      const workspaceToken = this.facetIdentity.capabilityToken();
      if (!workspaceToken) throw new Error('This exploration facet was seeded without a workspace capability token.');
      return { workspaceToken };
    },
    // Same revision compare the root runs: an exploration head caches the
    // provider listing it resolved under, and a rotation the fan-out missed
    // reaches it here rather than at the next spawn.
    getCredentialsRevision: async () => {
      const userId = this.facetIdentity.ownerUserId();
      const workspaceToken = this.facetIdentity.capabilityToken();
      if (!userId || !workspaceToken) return 0;
      const stub: CredentialsRevisionReader = this.env.UserDO.get(this.env.UserDO.idFromName(userId));
      return stub.getCredentialsRevision({ workspaceToken });
    },
  });

  /** Durable local outbox. A root RPC is deleted only after acknowledgement. */
  private modelOperationDrain: ModelOperationDrain | null = null;

  private ensureModelOperationOutbox(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS facet_model_operation_outbox (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json TEXT NOT NULL
      )
    `);
  }

  private enqueueModelOperation(event: ModelOperationEvent): void {
    this.ensureModelOperationOutbox();
    this.ctx.storage.sql.exec(
      'INSERT INTO facet_model_operation_outbox (event_json) VALUES (?)',
      JSON.stringify(event),
    );
    this.startModelOperationDrain();
  }

  private startModelOperationDrain(): void {
    if (this.modelOperationDrain !== null) return;
    const owner: ModelOperationDrain = { promise: null };
    this.modelOperationDrain = owner;
    owner.promise = (async () => {
      try {
        await this.runFiber(MODEL_OPERATION_LANE_FIBER, async (ctx) => {
          ctx.stash({ lane: MODEL_OPERATION_LANE_FIBER });
          await this.drainModelOperationOutbox();
        });
      } catch (cause) {
        diagnostics.failure('event.model_operation_emit_failed', toKinuError({
          doing: 'draining the facet model-operation outbox',
          cause,
          otherwise: 'io',
        }));
      } finally {
        if (this.modelOperationDrain === owner) this.modelOperationDrain = null;
      }
    })();
  }

  private async drainModelOperationOutbox(): Promise<void> {
    while (true) {
      const rows = this.sql<ModelOperationOutboxRow>`
        SELECT id, event_json
        FROM facet_model_operation_outbox
        ORDER BY id
        LIMIT 64
      `;
      if (rows.length === 0) return;
      for (const row of rows) {
        const event = v.parse(ModelOperationEventSchema, JSON.parse(row.event_json));
        await forwardFacetModelOperation(() => this.getSharedParentStub(), event);
        this.ctx.storage.sql.exec('DELETE FROM facet_model_operation_outbox WHERE id = ?', row.id);
      }
    }
  }

  private readonly facetModelOperations: ModelOperationSink =
    (event) => { this.enqueueModelOperation(event); };

  /**
   * A stub for this facet's IMMEDIATE parent: the workspace orchestrator at
   * depth 1, the subordinate that hired it deeper in.
   *
   * The branch reads `parentPath`, which the framework records at facet
   * creation, so it cannot disagree with where this facet actually hangs —
   * the subordinate branch lets `parentAgent` verify the class against that
   * same path, and the workspace-root branch — which resolves the binding
   * itself — repeats that check by hand. Nothing here reads
   * `identity.parentWorkspace`: that names the WORKSPACE, which past depth 1 is
   * not the parent, and using it as one is what would send a nested
   * subordinate's reports to the orchestrator instead of to whoever asked for
   * the work.
   */
  private async parentActor() {
    const parent = this.parentPath.at(-1);
    if (parent === undefined) {
      throw new Error('A subordinate must be a facet of the agent that hired it.');
    }
    if (parent.className === SubordinateAgent.name) return await this.parentAgent(SubordinateAgent);
    // The workspace root is a top-level DO, so its stub comes from its own
    // binding rather than an import of the class — `parentAgent` resolves
    // `env[cls.name]` to this same namespace, and importing the class here
    // closed a cycle (the orchestrator imports SubordinateAgent to spawn it).
    // The className check replaces the one `parentAgent` performs.
    if (parent.className !== WORKSPACE_ACTOR_CLASS) {
      throw new Error(
        `A subordinate's parent must be ${WORKSPACE_ACTOR_CLASS} or ${SubordinateAgent.name}, not ${parent.className}.`,
      );
    }
    return await getAgentByName<Env, OrchestratorAgent>(this.env[WORKSPACE_ACTOR_CLASS], parent.name);
  }

  /**
   * A facet shares the parent's VFS but not its actor SQL. Fetch the root
   * workspace authority before every turn so a child cannot mint a private
   * migration marker, grandfather a later file, or miss a root revocation.
   */
  protected override async refreshInstructionApprovalAuthority(): Promise<void> {
    this._workspaceInstructionApprovals =
      await (await this.parentActor()).getWorkspaceInstructionApprovals();
  }

  @callable()
  override async getWorkspaceInstructionApprovals(): Promise<readonly InstructionApproval[]> {
    return await (await this.parentActor()).getWorkspaceInstructionApprovals();
  }


  protected getOwnerUserId(): string | null {
    return this.identity.ownerUserId();
  }

  /** A subordinate's workspace is its parent's, so its exec planes, MCP
   *  dispatch, and credential reads all present the parent's identity — taint
   *  inheritance by construction rather than by bookkeeping. */
  protected workspaceName(): string {
    const parentWorkspace = this.identity.workspaceName();
    if (!parentWorkspace) throw new Error('Subordinate identity has not been seeded by its parent workspace.');
    return parentWorkspace;
  }

  protected scaffoldPath(): string {
    return `.kinu/agents/${encodeURIComponent(this.name)}/scaffold/agent.js`;
  }

  protected shellId(): string { return `subordinate:${this.name}`; }

  /**
   * The parent workspace's box, one Durable Object hop away.
   *
   * A subordinate is a facet with its own SQLite — private ledgers, private
   * scaffold, private transcript — and the workspace it works in is its
   * parent's. So it composes no filesystem of its own: composing one here would
   * be a SECOND, EMPTY workspace, which is the regression
   * tests/unit-head-fork.test.ts pins for heads and holds identically here.
   *
   * Resolved per call rather than cached: `workspaceName()` throws until the
   * parent has seeded this facet's identity, and that sentence is the one a
   * caller needs.
   */
  protected workspaceBox(shellId: string): NimbusSandboxHandle {
    return createWorkspaceBoxClient({
      owner: () => workspaceBoxOwner(this.env, this.workspaceName()),
      shellId,
    });
  }

  /**
   * The workspace itself — the ROOT orchestrator, whatever this facet's depth.
   * Distinct from {@link parentActor}: a nested subordinate's parent is the
   * subordinate that hired it, and the things only the root holds (the byte
   * plane, the home registry, the title) are reached here.
   */
  private async workspaceOwner(): Promise<DurableObjectStub<OrchestratorAgent>> {
    return await getAgentByName<Env, OrchestratorAgent>(this.env[WORKSPACE_ACTOR_CLASS], this.workspaceName());
  }

  /** Homes for this actor's own facets — its nested hires and its searches'
   *  nodes and heads — provisioned by the owner, because the registry is the
   *  owner's. */
  facetHomes(): HostedFacetHomes {
    return {
      provision: async (kind, id) => (await this.workspaceOwner()).provisionFacetHome(kind, id),
      release: async (kind, id) => (await this.workspaceOwner()).releaseFacetHome(kind, id),
    };
  }

  /**
   * The home this subordinate runs as, derived from its seeded identity: the
   * paths are the name's and the credential is the uid the owner allocated
   * at seeding. Undefined for a subordinate seeded before homes existed, which
   * then keeps running as the session user rather than as a uid nobody
   * allocated.
   */
  protected override facetHome(): HostedNodeHome | undefined {
    const identity = this.identity.read();
    if (!identity?.cred) return undefined;
    const agentName = subordinateAgentName(identity.name);
    return { home: agentHome(agentName), tmp: agentTmpRoot(agentName), cred: agentCred(identity.cred) };
  }

  /** What this subordinate is FOR. Its own mission, which for an agent the
   *  owner added without saying anything is the workspace's, inherited at
   *  creation. Also what its own further hires inherit. */
  protected ownMission(): string {
    return this.identity.read()?.mission ?? '';
  }

  /** A subagent's soul opens with the name a person calls it, and with the
   *  product name while it has none. NOT `|| identity.name`: that is the slug
   *  the tree addresses this facet by, and a slug is an address rather than a
   *  name — the reading that put `handwrought-walnut-4166c321` at the head of a
   *  workspace's own prompt. */
  protected async loadSoulText(): Promise<string> {
    const identity = this.identity.read();
    const descriptor = subordinateDescriptorSource(this.config).read();
    return identity && descriptor
      ? renderSoulMarkdown({
        name: descriptor.displayName,
        mission: `${this.identityRoleBlock(descriptor.role)}\n\n${identity.mission}`,
      })
      : '';
  }

  protected override async promptIdentity(): Promise<PromptIdentity> {
    return { agent: this.titleInputs().displayName, workspace: await this.workspaceTitle() };
  }

  /** The workspace's own title, one Durable Object hop away, held for this
   *  activation. `undefined` is "not asked yet"; `null` is "asked, and nobody
   *  has named the workspace".
   *
   *  A rename that lands mid-activation is not picked up, and a subagent
   *  outlives few of them. An unreachable workspace costs this facet its
   *  workspace's name for the activation and nothing else, so it is recorded
   *  and the turn goes on. */
  private _workspaceTitle: string | null | undefined;
  private async workspaceTitle(): Promise<string | null> {
    if (this._workspaceTitle !== undefined) return this._workspaceTitle;
    try {
      this._workspaceTitle = await (await this.workspaceOwner()).workspaceTitle();
    } catch (cause) {
      diagnostics.failure('subordinate.workspace_title_unreadable', toKinuError({
        doing: "reading the workspace title for a subagent's prompt",
        cause,
        otherwise: 'unavailable',
      }), { workspace: this.name });
      this._workspaceTitle = null;
    }
    return this._workspaceTitle;
  }

  /** The leading block of the identity section. It shows the role id. */
  private identityRoleBlock(role: RoleId): string {
    return `Role: ${role}`;
  }

  protected get engine(): EvolutionEngine {
    if (!this._engine) {
      this._engine = new EvolutionEngine(this.rt, {
        enabled: true,
        // The grading group as ONE unit, for the reason the root states: a
        // synchronous run in a Durable Object is already atomic, and answering
        // through the platform's own primitive keeps it so whatever core comes
        // to put between the statements.
        transaction: (body) => { this.ctx.storage.transactionSync(body); },
        // The turn review's own model calls debit the mission the reviewed turn
        // ran under — the same ledger, through the same seam, as the work it
        // reviews. Unbudgeted turns never reach it.
        governor: this.budget,
        ...this.shadowTrialPorts,
      });
    }
    return this._engine;
  }

  /** An owner chat owns this actor's review. Parent-assigned work keeps the
   * mode it was delegated with and never gets captured by an unrelated owner
   * review that happens to be pending on the same actor. */
  protected override turnWorkMode(): WorkMode {
    const requested = super.turnWorkMode();
    if (this.lastUserTurnIsProgrammatic()) return requested;
    return requested === 'build'
      && planReviewAwaitingDecision(this.planReviews.getActive('default'))
      ? 'plan'
      : requested;
  }

  /**
   * Two halves with different lifetimes, and that is why they gate differently.
   *
   * `report` is a per-TURN relationship — it exists on a turn its parent drove,
   * because an owner-driven chat with this subordinate is private to that chat.
   * The roster half is a standing CAPABILITY of the actor: a subordinate manages
   * the helpers it hired whoever is talking to it, so gating it on the parent's
   * turn would strand its own subtree the moment the owner opened its chat. It
   * gates on DEPTH instead, in `teamProfile()`.
   */
  protected actorToolDeps(): ActorToolDeps {
    const deps: ActorToolDeps = { ...this.teamProfile() };
    if (!this.lastUserTurnIsProgrammatic()) {
      return {
        ...deps,
        submitPlan: { submit: (edits) => this.submitPlanEdits(edits) },
      };
    }
    return {
      ...deps,
      report: {
        report: async (input) => {
          const { id, disposition } = await this.sendReport(input.status, input.content, 'report_tool');
          this.reportedThisTurn = true;
          // Only a run-SETTLING report counts as the answer. Same predicate the
          // parent's ingress settles the waiter on, so the child cannot come to
          // believe it has answered when the caller is still waiting.
          this.settledRunThisTurn ||= temporaryRunSettles({ status: input.status, origin: 'report_tool' });
          // Projected onto the tool's JSON contract. `disposition` is the useful
          // half now that the ingress dedupes: it says whether the parent took
          // this report or already held it.
          return { id, disposition };
        },
      },
    };
  }

  /** `report.*` mirrors the native report surface only on a parent-assigned
   * turn. Owner-driven subordinate chats are private to that chat. */
  protected extraCodemodeProviders(): CodemodeProvider[] {
    const report = this.actorToolDeps().report;
    return report ? [createReportCodemodeProvider(() => report)] : [];
  }

  protected isClientRpcMethodDenied(method: string): boolean {
    return method === 'setSubordinateIdentity';
  }

  /** A subordinate has no inbox of its own: the orchestrator's owner-notify lane
   *  (email) is reached by reporting to it. Automatic, not chosen, so it rides
   *  the `turn_end` origin — a job the OWNER's own conversation detached settles
   *  against no assignment and stops at the parent's ingress. */
  protected notifyOwner(subject: string, body: string): void {
    void this.sendReport('progress', `${subject}\n\n${body}`, 'turn_end')
      .catch(reportSubordinateFailure('parent_notification'));
  }

  protected ensureSchema(): void {
    if (this._schemaReady) return;
    // Every table a workspace has, on any backend — one list, in core.
    initWorkspaceSchema({
      execRaw: (ddl: string) => this.ctx.storage.sql.exec(ddl),
      sql: this.boundSql,
      exec: this.ctx.storage.sql,
    });
    // The one plane this root alone carries: its own identity row, seeded by
    // setSubordinateIdentity (declared per-root in core/conformance/manifest.ts).
    this.identity.ensureSchema();
    // The roster of this subordinate's OWN hires. Declared per-root in
    // core/conformance/manifest.ts (workspace_subordinates, wired on both cf
    // roots) and created here for the same reason the orchestrator creates it in
    // its own ensureSchema: a root's tables exist before anything reads them.
    this.subordinateRoster.ensureSchema();
    this._schemaReady = true;
  }

  @callable()
  async setSubordinateIdentity(input: SetSubordinateIdentityInput): Promise<{ ok: true }> {
    // `displayName` is deliberately NOT required: blank is the honest state of
    // an agent the owner added without naming, and the title policy fills it
    // on the first interaction.
    if (!input.name || !input.mission) {
      throw new Error('complete subordinate identity is required');
    }
    this.ensureSchema();
    if (input.name !== this.name) throw new Error('subordinate identity name must match its facet name');
    const parent = await this.parentActor();
    const bootstrap = await parent.getSubordinateBootstrapIdentity();
    const existing = this.identity.read();
    if (existing && (existing.name !== input.name
      || existing.parentWorkspace !== bootstrap.parentWorkspace
      || existing.ownerUserId !== bootstrap.ownerUserId
      || existing.depth !== bootstrap.depth)) {
      throw new Error('subordinate identity is immutable');
    }
    // The home before the row: the uid the owner allocates is part of who this
    // facet is, and every runtime built from the row runs as it. Provisioned
    // on the WORKSPACE, not the parent — a nested hire's parent is a
    // subordinate, and the registry is the workspace's. Idempotent, so a
    // parent retrying the seed after an interrupted RPC gets the same uid.
    const workspace = await getAgentByName<Env, OrchestratorAgent>(
      this.env[WORKSPACE_ACTOR_CLASS], bootstrap.parentWorkspace,
    );
    const home = await workspace.provisionFacetHome('subordinate', input.name);
    // Every other field here comes from the PARENT's answer, `depth` included.
    // The input carries no depth to ignore, and the parent refuses at the cap,
    // so a subordinate cannot be seeded past it however it was asked for.
    this.identity.seed({
      name: input.name,
      mission: input.mission,
      parentWorkspace: bootstrap.parentWorkspace,
      ownerUserId: bootstrap.ownerUserId,
      depth: bootstrap.depth,
      lifetime: input.lifetime,
      cred: { uid: home.cred.uid, gid: home.cred.gid },
    });
    // Both rows together: the shown title and WHOSE it is. Seeding the title
    // alone left `name_origin` unset, which the title policy reads as "never
    // titled" — so a role-derived name a parent chose was eligible to be
    // replaced by a model call the owner never asked for.
    this.config.setDisplayNameOrigin(input.displayName, input.nameOrigin);
    // The child config is the one current presentation authority.
    this.config.setRoleSelection(input.role);
    // An absent or unrecognised tier CLEARS the pin, which is the instruction to
    // derive from the role rather than a tier of its own. PARSED, not asserted:
    // `tier` arrives over RPC from the hiring actor, so this is its I/O boundary
    // and a bad value must never become a stored row a later read has to
    // tolerate. Same schema the turn resolver uses (profiles/resolve.ts).
    const pinnedTier = v.safeParse(v.picklist(TIER_IDS), input.tier);
    this.config.setAssignedTier(pinnedTier.success ? pinnedTier.output : null);
    if (input.capabilityToken) await this.installWorkspaceCapability(input.capabilityToken);
    // No concrete model is pinned from the caller: the child's own turn
    // resolution maps its tier (or the default) onto a model at its next turn.
    this._cachedSoulText = null;
    this.invalidateModelCaches();
    await this.ensureOwnedScaffold();
    // The seed decides the family: a hired facet answers the subordinate
    // surface from here on, and exploration seeds stop resolving across
    // a stub — the same boundary two classes used to draw.
    this.sealSubordinateSurface();
    return { ok: true };
  }

  /**
   * Write this subordinate's own naming state.
   *
   * Worker-side facet RPC from the parent, which owns the roster row the UI
   * reads and writes it in the same operation (`TeamToolDeps.rename`). Not a
   * client `@callable`: renaming is the parent's to do, so that one call
   * updates both halves and neither can be left behind.
   */
  async setSubordinateNaming(displayName: string, nameOrigin: 'user' | 'auto'): Promise<{ ok: true }> {
    this.ensureSchema();
    this.config.setDisplayNameOrigin(displayName, nameOrigin);
    this._cachedSoulText = null;
    this.broadcast(JSON.stringify({ type: 'workspace_renamed', displayName }));
    return { ok: true };
  }

  /**
   * Commit an auto title to this subordinate's OWN naming state.
   *
   * Local only. The parent's roster refresh is {@link propagateTitleToParent},
   * run after this by the effect that owes both — because the refresh re-reads
   * this child's descriptor, so notifying first published the previous name and
   * left nothing to correct it.
   */
  protected async persistAutoTitle(displayName: string): Promise<boolean> {
    // The owner's rename wins. Checked here rather than upstream because the
    // model call this follows takes seconds, and a name that landed during it is
    // a choice a person made.
    if (this.config.getNameOrigin() === 'user') return false;
    this.config.setDisplayNameOrigin(displayName, 'auto');
    this._cachedSoulText = null;
    this.broadcast(JSON.stringify({ type: 'workspace_renamed', displayName }));
    return true;
  }

  /**
   * Tell the parent this child's roster row should be re-read — the roster row
   * is the one every reader shows, so a title it never heard about is a title
   * nobody can see.
   *
   * Runs AFTER the local stamp, because the parent's refresh re-reads this
   * child's descriptor: notifying first published the previous name and left
   * nothing behind to correct it.
   */
  protected override async publishAutoTitle(): Promise<void> {
    if (this.config.getNameOrigin() !== 'auto') return;
    const displayName = this.config.getDisplayName();
    if (displayName === null) return;
    const parent = await this.parentActor();
    await parent.recordSubordinateTitle(this.name, displayName);
  }

  /**
   * The tables exploration modes need: the branch trace and the durable
   * model-operation outbox. Cheap DDLs, so every activation runs them — a
   * branch facet exists for one rollout, and lazily created tables would push
   * its first write into the run path. A pending outbox row resumes its drain,
   * for the eviction that landed between enqueue and acknowledgement.
   */
  private ensureFacetTables(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
        step INTEGER NOT NULL,
        text TEXT NOT NULL
      )
    `);
    this.ensureModelOperationOutbox();
    const pending = this.ctx.storage.sql.exec<{ id: number }>(
      'SELECT id FROM facet_model_operation_outbox ORDER BY id LIMIT 1',
    ).toArray();
    if (pending.length > 0) this.startModelOperationDrain();
  }

  /** Synchronous by contract — see `OrchestratorAgent.onStart`. The scaffold this
   *  subordinate runs is bootstrapped where it is needed: at identity seeding
   *  above, and on the turn path (`ActorAgent.beforeTurn`). */
  onStart(): void {
    this.ensureSchema();
    this.ensureFacetTables();
    // The same budget-first prune the root runs: every mode of this facet runs
    // its work through `runFiber` — the four durable lanes of a subordinate, the
    // model-operation drain of an exploration worker — so every mode accumulates
    // the same interrupted-fiber rows. One budget here; a pass that filled it is
    // finished by the terminal wake, whose tick re-runs every budgeted sweep.
    const sweepTruncated = this.sweepUnrecoverableFiberRows();
    // And the same terminal classification the root runs, for the same reason:
    // an interrupted transition replays SMTP and model work, and an activation
    // launches no external work. One bounded read decides; a wake due NOW is
    // one schedule row, and the alarm frame's `owedDeliveryWork` dispatches —
    // the carrier a sequence has even when the ledger could not arm its wake.
    this._terminalReported = this.runFiber(TERMINAL_LANE_FIBER, async () => {
      if (sweepTruncated) {
        await this.scheduleTerminalRetry(Date.now());
        return;
      }
      // A facet never hired as a subordinate has run no turn and can owe no
      // transition and no deferred job — and its terminal ledger deps need the
      // parent identity to build at all.
      if (this.identity.workspaceName() === null) return;
      if (this.terminal.nextRetryAt() !== null || this.terminal.hasIncomplete()) {
        await this.scheduleTerminalRetry(Date.now());
      }
      // The wake a deferred job owes, read the same way the root reads its live
      // jobs in `owedWorkExists`. The shared runner arms this wake when a claim
      // defers the next attempt, and an eviction between that write and the
      // schedule row loses the row. The root's first tick sweeps the registry
      // and re-arms every waiting instant. This actor's tick has no sweep and
      // serves a deferred job only once its instant is due, so the activation
      // arms that instant itself.
      const resumeAt = this.jobs.nextResumeAt();
      if (resumeAt !== null) await this.scheduleTerminalRetry(resumeAt);
    });
  }

  /**
   * Admit work from the parent and tell it what happened to it.
   *
   * The delivery branch is decided here and not guessed by the caller: this DO
   * is the only place that knows whether a turn is live right now. Delegated
   * work keeps its trusted Plan/Build mode and therefore queues as its own turn
   * when the subordinate is busy.
   */
  async enqueueSubordinateTask(input: {
    kind: 'task' | 'message';
    body: string;
    mode: WorkMode;
    deliverable?: string;
    deadlineHint?: string;
    inheritedContext?: string;
  }): Promise<{ id: string; admitted: boolean } & SubordinateHandoff> {
    this.ensureSchema();
    const busy = this._inFlight;
    const admission: Parameters<typeof admitSubordinateTask>[1] = {
      fromWorkspace: this.workspaceName(),
      kind: input.kind,
      body: input.body,
      mode: input.mode,
      now: Date.now(),
    };
    if (input.deliverable) admission.deliverable = input.deliverable;
    if (input.deadlineHint) admission.deadlineHint = input.deadlineHint;
    if (input.inheritedContext) admission.inheritedContext = input.inheritedContext;
    const result = admitSubordinateTask(this.eventLog, admission);
    if (result.admitted) this.orch.scheduleDrain();
    return {
      ...result,
      ...describeSubordinateHandoff({
        admission: result,
        turnInFlight: busy,
        live: readSubordinateLiveStatus(this.ctx.storage.sql),
      }),
    };
  }

  async getSubordinateStatus(): Promise<SubordinateLiveStatus> {
    this.ensureSchema();
    return readSubordinateLiveStatus(this.ctx.storage.sql);
  }

  @callable()
  async getSubordinateSnapshot(): Promise<{
    name: string;
    displayName: string;
    role: RoleId;
    tier: TierId | null;
    mission: string;
    model: string | null;
    activePlan: PlanReview | null;
    pendingSteers: InlineSteer[];
  }> {
    this.ensureSchema();
    const identity = this.identity.read();
    const descriptor = subordinateDescriptorSource(this.config).read();
    if (!identity || !descriptor) throw new Error('Subordinate identity is not initialized.');
    return {
      name: identity.name,
      displayName: descriptor.displayName,
      role: descriptor.role,
      tier: descriptor.tier,
      mission: identity.mission,
      model: this.getStoredModelId(),
      activePlan: await this.getActivePlanReview(),
      pendingSteers: this.pendingSteerRuns(),
    };
  }

  /** This child's own lifetime, off its immutable identity row. Absent before
   *  the seed, which reads as durable: nothing is waiting on an unseeded facet. */
  private ownLifetime(): SubordinateLifetime {
    return this.identity.read()?.lifetime ?? 'durable';
  }

  /**
   * The report this child owes for one ending, or null when it owes none.
   *
   * Thin on purpose: the DECISION is core's closed map (`terminalTaskReport`),
   * so the cloud child and the local one cannot come to word the same ending
   * differently, and a new ending cannot reach either without a decision.
   */
  private taskTerminalReport(ending: TaskTurnEnding, assistantText: string) {
    return terminalTaskReport({ lifetime: this.ownLifetime(), ending, assistantText });
  }


  private async sendReport(
    status: SubordinateReportStatus,
    content: string,
    origin: SubordinateReportOrigin,
    /** The terminal sequence that owes this report, and the mode the reported
     *  turn ran in. Both TRAVEL rather than being re-derived at either end: the
     *  sequence id is the parent's ingress dedupe key, so a replayed report is
     *  recognised as the one already held, and a cold replay must not turn a Plan
     *  report into a Build one because the live turn metadata moved on. */
    owedBy?: { readonly sequenceId: string; readonly mode: WorkMode },
  ): Promise<SubordinateEventResult> {
    const identity = this.identity.read();
    if (!identity) throw new Error('Subordinate identity is not initialized.');
    // The agent that HIRED this one, which past depth 1 is not the workspace
    // orchestrator. Its roster is the one holding this name, so it is the only
    // ingress that can admit the report against the task it asked for.
    const parent = await this.parentActor();
    return parent.receiveSubordinateEvent({
      fromSubordinate: identity.name,
      status,
      content,
      origin,
      mode: owedBy?.mode ?? this.turnWorkMode(),
      sequenceId: owedBy?.sequenceId ?? `live:${this.name}:${nanoid()}`,
    });
  }

  /**
   * The three effects a settled subordinate turn owes.
   *
   * `parent_report` is the one that made a durable disposition necessary here at
   * all: it is a cross-DO call, and a second report of one answer reads to the
   * parent as a second piece of progress. It is nonetheless replayable, because
   * the parent's ingress admits by dedupe key rather than by arrival — so a
   * re-drive of the SAME answer is recognised, while losing it silently is not
   * recoverable at all.
   */
  protected override terminalEffectTable(): TerminalEffectTable {
    return {
      ...this.sharedTerminalEffects(),
      auto_title: terminalEffect({
        input: v.object({ subject: v.string() }),
        // Once-only at its own boundary: persisting marks `name_origin`, after
        // which the shared policy does not match. The lane verdict is core's
        // one derivation, asked here rather than stashed by another effect, so a
        // replay whose spine ran on an earlier activation still gets an answer.
        run: async ({ subject }) => {
          await this.applyAutoTitle(subject);
          return { status: 'completed' };
        },
      }),

      parent_report: terminalEffect({
        input: v.object({
          text: v.string(), status: v.picklist(SUBORDINATE_REPORT_STATUSES),
          sequenceId: v.string(), mode: WorkModeSchema,
        }),
        // Replayable because the parent's ingress dedupes on the SEQUENCE ID this
        // carries: a re-drive of the same answer is recognised as the report the
        // parent already holds, while losing it silently is not recoverable at all.
        run: async ({ text, status, sequenceId, mode }) => {
          const { disposition } = await this.sendReport(
            status, text, 'turn_end', { sequenceId, mode },
          );
          return disposition === 'admitted'
            ? { status: 'completed' }
            : { status: 'completed', detail: `the parent reported it ${disposition}` };
        },
      }),
    };
  }

  async onChatResponse(result: ChatResponseResult): Promise<void> {
    const { programmaticUserMessage, errorText, completed, outputContinuation } =
      this.settleTurnEvents(result);
    // The seal's own classification comes back with it, so the roster reads the
    // same verdict instead of classifying the identical facts a second time.
    const { overflowRecovery, end } =
      this.recordTurnTelemetry(result, { errorText, completed, programmaticUserMessage });
    // The identity of THIS terminal sequence comes from the shared helper, so
    // the root and its facets key one response the same way.
    //
    // NOTHING FROM HERE TO `settle` MAY AWAIT: Think has already persisted the
    // answer, so an await before the claim exists is a window where recovery
    // finds a durable answer with no incomplete transition and replays nothing.
    // The response-to-model-message conversion lives inside the
    // `turn_end_extensions` body, where the claim already exists.
    const transition = this.transitionFor(result);
    const { userText, assistantText } = this.turnTextParts(result, programmaticUserMessage);

    // One read of who drove this turn, feeding both the turn's recorded origin
    // and whether its answer is the parent's to hear.
    const ownerDriven = !programmaticUserMessage && !this.lastUserTurnIsProgrammatic();

    const completedTurn: Parameters<typeof snapshotCompletedTurn>[1] = {
      userMessage: userText,
      assistantResponse: assistantText,
      sessionId: 'default',
      origin: ownerDriven ? 'user' : 'programmatic',
    };
    if (result.message.id) completedTurn.turnId = result.message.id;
    const turn = snapshotCompletedTurn(this.acc, completedTurn);
    // The name the durable run was sealed with, carried rather than re-derived:
    // the facts include the model's last word, which is the only thing that
    // separates a finished turn from one Think's own stop condition cut.
    const status = end.reason;
    const messageId = result.message.id;

    // Sampled only for a turn the promotion gate can learn from, and keyed on
    // that turn rather than rolled — the root's two reasons, which are this
    // facet's too.
    const sampledVersion = this.orch.improvementLanesOpen(status, this.turnWorkMode())
      ? shadowTrialPlan(this.scaffoldControl, messageId)
      : null;
    // Titled from the first thing its OWNER said to it, and the mission is
    // deliberately not the source. A subordinate's mission is either its hire
    // brief — already turned into a role-derived name its parent chose — or, for
    // an agent the owner added with nothing to say, the workspace's own mission,
    // which every sibling shares. Titling from that would name them all the same.
    // WHICH report this turn owes its parent, decided once and carried by the
    // claimed effect below rather than by a detached send.
    //
    // A `task` child owes its caller a terminal answer on EVERY ending, because
    // an `agents.ask` is blocked on it: a branch that returns without one simply
    // goes quiet and the caller never comes back. A `durable` child
    // relays only a completed turn worth relaying. Both are suppressed by a
    // report that already SETTLED the run — a mere progress note leaves the
    // caller waiting and therefore leaves the answer owed, while a second
    // settling message would reach it as a second result for one question.
    const ending: TaskTurnEnding = completed
      ? 'answered'
      : result.status === 'aborted' ? 'interrupted' : 'errored';
    const taskReport = this.settledRunThisTurn ? null : this.taskTerminalReport(ending, assistantText);
    const parentReport = taskReport ?? (
      completed && subordinateRelaysTurnEnd({
        reportedThisTurn: this.reportedThisTurn, ownerDriven, assistantText,
      })
        ? { status: 'progress' as const, content: assistantText }
        : null
    );
    const scopedTurn = projectJsonValue({ value: this.orch.scopedTurn(turn) });
    const shadowTrial = sampledVersion === null ? undefined : {
      pendingVersion: sampledVersion,
      trialContext: projectJsonValue({
        value: trimTrialContext(this._lastTurnOpts?.messages ?? []),
      }),
    };
    const autoTitle = ownerDriven ? { subject: userText } : undefined;
    const parentReportPart = parentReport === null ? undefined : {
      text: parentReport.content,
      status: parentReport.status,
      // A live report with no terminal sequence behind it still needs an
      // identity nothing else shares: keyed on an empty message id, the
      // parent's ingress dedupes every later report as the first one.
      sequenceId: transition === null
        ? `live:${this.name}:${nanoid()}`
        : this.terminal.sequenceId(transition),
    };
    const parts: TerminalTurnParts = {
      overflowRetry: overflowRecovery?.enqueueRetry === true,
      // A facet's truncated answer is its PARENT's problem too: the report it
      // owes carries whatever the turn produced, so an answer cut mid-sentence
      // is what the caller gets unless the continuation runs.
      outputContinuation,
      turnEndExtensions: { message: projectJsonValue({ value: result.message }) },
      advisor: projectJsonValue({ value: this.advisorSnapshotFor(this.orch.scopedTurn(turn)) }),
      shadowTrial,
      autoTitle,
      parentReport: parentReportPart,
    };
    const owed = declareTerminalRoster({
      messageId,
      status,
      workMode: this.turnWorkMode(),
      continuity: this._turnContinuity,
      completed,
      userText,
      assistantText,
      scopedTurn,
      recordedAt: Date.now(),
      evolutionEnabled: this._turnEvolutionEnabled,
    }, parts);
    this.reportedThisTurn = false;
    this.settledRunThisTurn = false;

    // The same core state machine the root drives, with this facet's own effect
    // bodies and its own fiber behind the close. There is no second copy of the
    // choreography here any more: the guard, the claim, the roster freeze and the
    // close are all one implementation.
    await this.terminal.settle({
      transition,
      declare: () => owed,
      hold: (claimed, close) => { this.holdTerminalClose(claimed, close, result.requestId); },
    });
  }

  // ── Exploration modes: head, node, branch ──────────────────────────
  //
  // One class, four modes; the seed decides which. A subordinate seed drives
  // the Think turn loop above. A head or node seed drives core's inference
  // loops over the parent's file plane, with the tool surface each mode
  // admits and nothing else. A branch (no seed at all) reasons through one
  // bare model call: no ToolSet, no runtime, so storage isolation holds by
  // DO identity alone and a branch never acquires the head runtime below.

  /**
   * The parent workspace's resolved turn profile — the one thing a facet must
   * NOT resolve for itself.
   *
   * Every model a facet builds routes through `MODEL_ROUTE_POLICY`, and the
   * routes it needs split two ways. `mcts`, `head` and `swarm` are `invocation`:
   * the tier the parent's ACTIVE ROLE selected for the turn this work belongs
   * to, which a facet cannot know — it has no role and no turn. The lanes its
   * runtime exposes (`reflection`, `judge`, `fast`, `advisor`) are fixed tiers,
   * which it could read from any envelope, but resolving a second time can
   * still disagree with the first: the provider snapshot moves whenever a
   * credential does, so a facet resolving moments later can land a different
   * `providerRevision` and a different digest. A search whose branches ran
   * under a profile the parent never resolved is unreproducible, which is the
   * reason the digest exists at all.
   *
   * One RPC per activation, memoized on the PROMISE so concurrent lanes share
   * the one round trip rather than racing three. A rejection is not cached: a
   * facet that outlived a transient parent fault would otherwise refuse every
   * later call citing a failure that has already passed.
   */
  private _facetProfile: Promise<ResolvedTurnProfile> | null = null;
  /** Bumped per fetch. A fetch that fails clears the memo only if it is still
   *  the current one, so a stale failure cannot discard a newer fetch. */
  private _facetProfileGeneration = 0;
  private facetProfile(): Promise<ResolvedTurnProfile> {
    if (this._facetProfile) return this._facetProfile;
    const parent = this.getSharedParentStub();
    if (!parent) {
      throw new Error(
        'This facet was spawned without a parent workspace, so it cannot reach the '
        + 'profile that decides its model; setSharedParent must run before it does any model work.',
      );
    }
    const generation = ++this._facetProfileGeneration;
    this._facetProfile = (async (): Promise<ResolvedTurnProfile> => {
      try {
        return await parent.facetTurnProfile();
      } catch (cause) {
        // Dropped rather than kept: a facet that outlived a transient parent
        // fault would otherwise refuse every later call citing a failure that
        // has already passed. The rejection still reaches this call's own
        // caller — only the MEMO is discarded.
        if (this._facetProfileGeneration === generation) this._facetProfile = null;
        diagnostics.failure('facet.turn_profile_unavailable', toKinuError({
          doing: "fetching the parent workspace's resolved turn profile",
          cause,
          otherwise: 'io',
        }), { facet: this.name });
        throw cause;
      }
    })();
    return this._facetProfile;
  }

  /**
   * The spec this facet's work runs on: the one its parent NAMED for it, or the
   * route's when the parent named none.
   *
   * The pin wins deliberately — heterogeneous heads are a real feature, and a
   * search that assigned one head a different model meant it. The fallback must
   * resolve through the profile: reaching `resolveModel(null)` asks the REGISTRY
   * for the account default and never consults it, so a role running on any tier
   * but the default has its heads, its nodes and its crafted scripts served by a
   * model it did not select, while its spend files against the route that chose
   * differently.
   */
  private async facetModelSpec(
    source: 'head' | 'swarm',
    pinned: string | null | undefined,
  ): Promise<string> {
    if (pinned) return pinned;
    const route = resolveModelRoute(source, await this.facetProfile());
    if (!route) throw new Error(`a facet's ${source} work cannot use the fixed platform model route`);
    return route.model;
  }

  /** A facet's private plane over the PARENT's file plane: private SQL ledgers and
   *  private shell state, from the one `createCFRuntime` call every mode that has a
   *  runtime at all shares.
   *
   *  `workspaceName` is the parent workspace and never this facet's own name, and
   *  the box is the PARENT'S — reached over one Durable Object hop into the
   *  orchestrator that holds Nimbus over its own SQLite. A facet that composed a
   *  workspace of its own, or named itself when asking for one, would get a
   *  SECOND, EMPTY filesystem — the empty-workspace regression pinned by
   *  tests/unit-head-fork.test.ts.
   *
   *  `id` is the worker's own id, the head or node id its seed named. It keys
   *  the durable shell and the scaffold path, so `head:<id>` and
   *  `.kinu/heads/<id>/…` read the id the journal carries rather than the
   *  `exp:`-marked facet key `this.name` holds. */
  private facetRuntime(
    scope: 'head' | 'node',
    id: string,
    hooks: CFRuntimeHooks,
    workspaceExecution?: HostedNodeHome,
  ): CFRuntime {
    const parent = this.getSharedParentStub();
    const workspaceName = this.facetIdentity.parentWorkspace();
    if (!parent || !workspaceName) {
      throw new Error(`This ${scope} was spawned without a parent workspace; setSharedParent must run before it can run.`);
    }
    const runtimeHooks: CFRuntimeHooks = {
      ...hooks,
      resolveProfile: () => this.facetProfile(),
    };
    if (workspaceExecution !== undefined) runtimeHooks.workspaceExecution = workspaceExecution;
    return createCFRuntime(this, {
      env: this.env,
      ctx: this.ctx,
      workspaceBox: (shellId) => createWorkspaceBoxClient({
        owner: () => workspaceBoxOwner(this.env, workspaceName),
        shellId,
      }),
    }, {
      ownerUserId: () => this.facetIdentity.ownerUserId(),
      workspaceName,
      shellId: `${scope}:${id}`,
      scaffoldPath: `.kinu/${scope}s/${encodeURIComponent(id)}/scaffold/agent.js`,
      capabilityToken: () => this.facetIdentity.capabilityToken(),
    }, runtimeHooks);
  }

  /** A head's runtime: the shared plane above wrapped with this run's observer
   *  before tools are built, so writes are attributable without another executor
   *  or VFS. */
  private headFacetRuntime(id: HeadId, capture: HeadCapture, home: HostedNodeHome): CFRuntime {
    return this.facetRuntime('head', id, { workspaceObserver: capture.files }, home);
  }

  /** Exploration facets inherit ownership from the orchestrator that spawned
   *  them; the parent calls setOwner immediately after subAgent() returns
   *  the stub. The workspace capability token comes down with it, so a head's
   *  model calls reach the owner's credentials as the PARENT workspace and are
   *  attenuated exactly as it is. Persisted to SQL so hibernation between spawn
   *  + run is safe. */
  @callable()
  async setOwner(userId: string, capabilityToken: string | null): Promise<{ ok: true }> {
    if (!userId) throw new Error('userId required');
    this.facetIdentity.setOwner(userId, capabilityToken);
    this.facetModelServices.invalidate();
    this._facetProfile = null;
    return { ok: true };
  }

  /** The ROOT workspace this head forks: whose canonical Nimbus session and
   *  execution planes it shares, where the whole split's findings accumulate,
   *  and — since C2 — where every journal row the subtree writes lands. Set by
   *  the spawner right after subAgent() and propagated UNCHANGED to recursive
   *  sub-heads, so an intermediate head never becomes the tree's workspace.
   *  Persisted for hibernation. */
  @callable()
  async setSharedParent(agentName: string): Promise<{ ok: true }> {
    if (!agentName) throw new Error('agentName required');
    this.facetIdentity.setParentWorkspace(agentName);
    this._facetProfile = null;
    return { ok: true };
  }

  /** Stub to the root workspace orchestrator — the head's parent — or null if
   *  unset (an MCTS branch never has one). */
  private getSharedParentStub(): DurableObjectStub<OrchestratorAgent> | null {
    const name = this.facetIdentity.parentWorkspace();
    if (!name) return null;
    return this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name));
  }

  /** The root workspace a tooled mode cannot run without. `doing` names the
   *  call so the refusal says which RPC needed the parent it never got. */
  private requireSharedParent(doing: string): DurableObjectStub<OrchestratorAgent> {
    const parent = this.getSharedParentStub();
    if (!parent) {
      throw new Error(`This facet was spawned without a parent workspace; setSharedParent must run before ${doing}.`);
    }
    return parent;
  }

  // ── MCTS mode @callables ────────────────────────────────────────
  // Deliberately toolless and runtime-free: a branch reasons, it does not act.
  // Nothing here may reach headFacetRuntime().

  /** Traced because this is the ONE model call a branch makes, so its span IS the
   *  branch's latency — and a 120s branch-RPC cap once silently killed every
   *  rollout against turns measuring 151/294/509s. A measured span is what makes
   *  the next such number arguable instead of guessed.
   *
   *  The model follows MODEL_ROUTE_POLICY.mcts at the invoking turn's tier.
   *
   *  Spend is reported by the ENGINE, not here, and deliberately: it returns
   *  `usage` to `mcts/engine.ts`, which files one `mcts` row per branch call
   *  from it (engine.ts:244) because only the engine can tell a completed call
   *  from a rejected or malformed one. A second report here would double-count
   *  every rollout. The OPERATION frame has no such owner — the engine holds no
   *  operation sink and could not open one across the RPC — so it belongs to the
   *  seam that makes the call, which is this one. */
  @callable()
  async explore(
    priorHistory: readonly PriorTurn[],
    craftedTools: CraftedTool[],
    languages: readonly [string, ...string[]],
    mode: WorkMode,
    siblings: readonly string[] = [],
  ): Promise<BranchExploration> {
    // Every work entry on this class reopens the analytics write window. The
    // platform's 250-point budget is per INVOCATION and the constructor's
    // install opens one per ACTIVATION, so a long exploration on a hot facet
    // host spent one budget across the whole run and then went silent — on the
    // rows that are the only fleet evidence exploration ran at all.
    openAnalyticsWindow(this.env);
    // A branch never runs a mode init, so its first work entry is what narrows
    // the boot seal to the exploration family.
    this.sealExplorationSurface();
    if (!isWorkMode(mode)) throw new Error('Branch exploration requires a trusted work mode');
    return await this.tracing.invocation('rpc', 'mcts.branch', async (invocation) => {
      const route = resolveModelRoute('mcts', await this.facetProfile());
      if (!route) throw new Error('an MCTS branch cannot use the fixed platform model route');
      const { model, providerOptions } = this.facetModelServices.resolveModelWithEffort(
        route.model, route.reasoningEffort,
      );
      const { system, user } = explorePrompt({
        mode,
        context: formatInheritedContext(priorHistory),
        craftedTools,
        languages,
        siblings,
      });

      const request: Parameters<typeof generateText>[0] = {
        model,
        system,
        messages: [{ role: "user" as const, content: user }],
      };
      if (providerOptions) request.providerOptions = providerOptions;
      // Opened BEFORE the request so a branch killed mid-call leaves a start row
      // naming the rollout rather than nothing at all — which is the whole of
      // what `swarm.node_silent` could not distinguish.
      const operation = beginModelOperation(
        { source: 'mcts', operations: this.facetModelOperations },
        'complete',
        { spec: route.model },
      );
      const { text, usage } = await invocation.span('mcts.branch.model', async (span) => {
        let answer;
        try {
          answer = await generateText(request);
        } catch (cause) {
          operation.failed({ cause });
          throw cause;
        }
        span.setAttribute('kinu.output_tokens', answer.usage.outputTokens ?? 0);
        return answer;
      });
      const normalized = normalizeUsage(usage);
      operation.completed({ usage: normalized, modelId: route.model });

      const trimmed = text.trim();
      void this.sql`INSERT INTO traces (step, text) VALUES (1, ${trimmed})`;
      return { text: trimmed, usage: normalized };
    });
  }

  /** The failure post-mortem for a branch that has already been scored. Same
   *  route, same reporting split and same reason as {@link explore}: `mcts` is
   *  `invocation`, and the engine files this call's spend from the `usage`
   *  returned here (engine.ts:443), so only the operation frame is ours. */
  @callable()
  async generateReflection(task: string, outcome?: string): Promise<BranchReflection> {
    openAnalyticsWindow(this.env);
    this.sealExplorationSurface();
    const traces = this.sql<{ text: string }>`SELECT text FROM traces ORDER BY step`;
    const route = resolveModelRoute('mcts', await this.facetProfile());
    if (!route) throw new Error('an MCTS reflection cannot use the fixed platform model route');
    const { model, providerOptions } = this.facetModelServices.resolveModelWithEffort(
      route.model, route.reasoningEffort,
    );
    const request: Parameters<typeof generateText>[0] = {
      model,
      messages: [{
        role: "user" as const,
        content: reflectionPrompt(task, traces.map(t => t.text).join("\n"), outcome),
      }],
    };
    if (providerOptions) request.providerOptions = providerOptions;
    const operation = beginModelOperation(
      { source: 'mcts', operations: this.facetModelOperations },
      'complete',
      { spec: route.model },
    );
    let result;
    try {
      result = await generateText(request);
    } catch (cause) {
      operation.failed({ cause });
      throw cause;
    }
    const usage = normalizeUsage(result.usage);
    operation.completed({ usage, modelId: route.model });
    return { text: result.text.trim(), usage };
  }

  // ── Head mode @callables  ───────────────────────────────────

  /** Initialize this facet as a branching-heads worker. */
  @callable()
  async initHead(input: HeadInput): Promise<{ ok: true; id: HeadId }> {
    // BEFORE the ack, so an acknowledged bootstrap is a durable one. The
    // instance fields stay as the warm path; the row is what a cold activation
    // reads.
    this.activation.store({ kind: 'head', input });
    this.headInput = input;
    this.headAborted = false;
    this.headAbortReason = null;
    this.sealExplorationSurface();
    return { ok: true, id: input.id };
  }

  @callable()
  async abortHead(reason: string): Promise<{ ok: true }> {
    this.headAborted = true;
    this.headAbortReason = reason;
    return { ok: true };
  }

  /** Run the head's inference loop over the forked runtime and return its
   *  HeadReport. The ToolSet — and what is deliberately absent from it — is
   *  declared in @kinu.run/core head-tools.
   *
   *  Traced with the same two phases as `runAsNode`, for the same reason: a head
   *  that produces no report has either failed to acquire its model and tools or
   *  failed inside the loop, and those are different defects with the same
   *  observable. */
  @callable()
  async runAsHead(): Promise<HeadReport> {
    openAnalyticsWindow(this.env);
    // The stored row is the fallback, not the primary: a warm facet answers from
    // its own field, and only a facet evicted between initHead and here pays the
    // read. Absent from BOTH is a genuine protocol error and still throws.
    const input = this.headInput ?? this.activation.headInput();
    if (!input) throw new Error("SubordinateAgent.runAsHead() called before initHead()");
    return await this.tracing.invocation('rpc', 'head.run', async (invocation, root) => {
      root.setAttribute('kinu.head_id', input.id);
      const capture = new HeadCapture();
      // The loop + report assembly live in core (runHeadInference); the Facet
      // supplies its model + the forked tool surface. Abort is driven by
      // abortHead() flipping this.headAborted.
      const modelSpec = await this.facetModelSpec('head', input.model);
      const parent = this.requireSharedParent('runAsHead');
      // Its home first, from the owner: the runtime below is built as that
      // uid on both planes, the way a node's is, so the head's writes land in
      // `/home/head-<id>` and never in a sibling's or the origin's tree.
      const home = await invocation.span('head.home', () => parent.provisionFacetHome('head', input.id));
      const headOptions = invocation.span('head.deps', (): Parameters<typeof runHeadInference>[1] => {
        const mission = this.missionScope(input);
        const options: Parameters<typeof runHeadInference>[1] = {
          model: this.facetModelServices.resolveModel(modelSpec),
          tools: this.buildHeadTools(input, capture, home),
          capture,
          workspaceLayout: 'private-scratch',
          isAborted: () => this.headAborted,
          abortReason: () => this.headAbortReason,
          reportStep: this.stepSink(parent, input.id),
          reportDelta: this.deltaSink(parent, input.id),
        };
        if (mission) options.mission = mission;
        return options;
      });
      return await invocation.span('head.inference', async (span) => {
        const report = await runHeadInference(input, headOptions);
        span.setAttribute('kinu.head_status', report.status);
        return report;
      });
    });
  }

  // ── Node mode @callables ────────────────────────────────────────

  /** Initialize this facet as one swarm node's host. */
  @callable()
  async initNode(spec: NodeRunSpec): Promise<{ ok: true; id: string }> {
    this.activation.store({ kind: 'node', spec });
    this.nodeSpec = spec;
    this.sealExplorationSurface();
    return { ok: true, id: spec.headInput.id };
  }

  /**
   * Run this node's loop and return everything the search takes out of it.
   * Journals nothing — the ledger is the parent's, which is why the step sink and
   * the arbiter below are RPCs back to it rather than local writes.
   *
   * TRACED as one invocation with two sibling phases, and the split is the
   * diagnosis rather than decoration. `swarm.node.deps` covers everything before
   * the loop: the facet runtime, the model resolution (which reaches the owner's
   * credentials over RPC and can therefore block), the tool surface. `swarm.node.loop`
   * covers `runNodeLoop`. A node reported silent for 600s with zero steps and
   * zero model calls is now a question with an answer — whichever of the two spans
   * has no end is the one that blocked — where before it was two indistinguishable
   * hypotheses over the same absence of rows.
   */
  @callable()
  async runAsNode(): Promise<NodeLoopResult> {
    openAnalyticsWindow(this.env);
    const spec = this.nodeSpec ?? this.activation.nodeSpec();
    if (!spec) throw new Error("SubordinateAgent.runAsNode() called before initNode()");
    return await this.tracing.invocation('rpc', 'swarm.node', async (invocation, root) => {
      root.setAttribute('kinu.node_id', spec.headInput.id);
      const modelSpec = await this.facetModelSpec('swarm', spec.headInput.model);
      const parent = this.requireSharedParent('runAsNode');
      const nodeId = spec.headInput.id;
      const workspaceExecution = await invocation.span(
        'swarm.node.home',
        () => parent.provisionFacetHome('node', nodeId),
      );
      if (workspaceExecution.home !== spec.home) {
        throw new Error(`Node ${nodeId} home differs from the provisioned node spec`);
      }
      const deps = invocation.span('swarm.node.deps', (): NodeLoopDeps => {
        const rt = this.facetRuntime('node', nodeId, {}, workspaceExecution);
        const webSearch = this.facetModelServices.getWebSearchProvider();
        const built: NodeLoopDeps = {
          rt,
          model: this.facetModelServices.resolveModel(modelSpec),
          logger: createConsoleLogger(),
          // The runtime half of the arbitration rule. Its build-time half is
          // `spec.canPropose`, which the search decided: a stub is always non-null, so
          // presence alone cannot answer whether a branch could be granted.
          arbitrate: spec.canPropose ? (proposal) => parent.nodeArbitrate(nodeId, proposal) : null,
          reportStep: this.stepSink(parent, nodeId),
          reportDelta: this.deltaSink(parent, nodeId),
          executeTool: this.facetExecuteTool(rt, webSearch),
          webSearch,
        };
        // Assigned rather than spread: an unbudgeted node must leave the key ABSENT,
        // because the loop reads presence to decide whether the ledger exists at all.
        const mission = this.missionScope(spec.headInput);
        if (mission) built.mission = mission;
        return built;
      });
      return await invocation.span('swarm.node.loop', async (span) => {
        const result = await runNodeLoop(spec, deps);
        // The two facts that distinguish every outcome the search cares about
        // from the silent one: a node that never reached a model call reports
        // neither a status nor a report, and this span then has no end at all.
        span.setAttribute('kinu.node_status', result.report.status);
        span.setAttribute('kinu.node_reported', result.reported !== null);
        return result;
      });
    });
  }

  /**
   * Where this facet's finished steps go: the parent's journal, over RPC, as each
   * one lands.
   *
   * Same shape and same reason as {@link missionScope} — the journal lives on the
   * orchestrator and a facet cannot write it directly. It is what makes a running
   * branch readable: the trace is the only thing that can say what a head is
   * doing before it reports, and the surface renders it as it arrives.
   *
   * ONE sink for a head and a node alike, because a node's rows ARE head-journal
   * rows — `insertSpawn` takes a `HeadInput` and `appendStep` writes the same
   * table. The stub is passed in rather than resolved here because only one caller
   * has an absence to handle: a node has already refused to run without a parent,
   * and a head without one is an MCTS branch, which has no multi-step trace.
   */
  private stepSink(parent: DurableObjectStub<OrchestratorAgent>, headId: HeadId) {
    return async (seq: number, step: HeadStep): Promise<void> => {
      await parent.recordHeadStep(headId, seq, step);
    };
  }

  /**
   * Where this facet's transient frames go: the parent's socket, over the stub it
   * already holds. One sink for a head and a node alike, for the same reason
   * {@link stepSink} is one.
   *
   * NOT AWAITED, and that is the difference from {@link stepSink}. A step is the
   * branch's durable record and the next request must not be issued while it is
   * in flight; a frame is a repaint. One frame is one provider delta, so awaiting
   * would put the model's own stream behind a cross-isolate round trip per delta
   * — paid for nothing, since the step that lands afterwards states the same
   * text.
   *
   * A rejection is therefore reported and dropped. The client is corrected by the
   * `head_activity` the parent sends when this step lands, so a channel that has
   * gone quiet costs a stale pane and never the run.
   */
  private deltaSink(
    parent: DurableObjectStub<OrchestratorAgent>,
    headId: HeadId,
  ): ReportHeadDelta {
    return (kind, delta) => this.keepAliveWhile(async () => {
      // A frame is a repaint, so the stream does not wait for its cross-isolate
      // round trip. The keep-alive owner holds delivery after the producer moves
      // on, and the lexical catch narrows the one untrusted rejection value.
      try {
        await parent.publishHeadStream(headId, kind, delta);
      } catch (cause) {
        diagnostics.event('head.stream_frame_dropped', {
          headId,
          reason: renderThrownChain({ cause }),
        });
      }
    });
  }

  /**
   * The mission ledger this head charges, or null when it charges none.
   *
   * The ledger lives on the parent workspace — a facet has its own storage and
   * resolves its own model, so nothing the parent wrapped around `rt.llm`
   * reaches these calls. The port is therefore an RPC back to the actor that
   * declared the budget: guard before each step, debit after it.
   *
   * Null for a head with no labels, which is every head of an ordinary
   * unbudgeted run: no stub is taken, no RPC is issued, and the parent's
   * mission table is never opened.
   */
  private missionScope(input: HeadInput): MissionScope | null {
    const labels = input.missionLabels ?? [];
    if (labels.length === 0) return null;
    const parent = this.getSharedParentStub();
    if (!parent) return null;
    return {
      labels,
      port: {
        guard: (seam, scope) => parent.missionGuard(seam, scope),
        debit: (tokens, opts) => parent.missionDebit(tokens, opts),
      },
    };
  }

  // ── Head-mode tool builders ─────────────────────────────────────

  private buildHeadTools(input: HeadInput, capture: HeadCapture, home: HostedNodeHome) {
    const rt = this.headFacetRuntime(input.id, capture, home);
    const webSearch = this.facetModelServices.getWebSearchProvider();
    return buildHeadToolSet({
      input,
      capture,
      rt,
      executeTool: this.facetExecuteTool(rt, webSearch),
      webSearch,
      split: (request) => this.runRecursiveSplit(request, input.budget, input),
    });
  }

  /** The `execute_tools` surface a facet's mode gets over its own runtime. ONE
   *  builder for a head and a node: they differ in nothing this tool can see,
   *  now that a crafted script has no model of its own to call. Handed to the
   *  head surface as a function of the finished set, so its `tools.*`
   *  declaration lists exactly the head's own tools. */
  private facetExecuteTool(rt: CFRuntime, webSearch: WebSearchProvider) {
    const factory = createExecuteToolsFactory({
      loader: this.env.LOADER,
      egress: codemodeEgress(),
      rt,
      sql: this.boundSql,
      workspace: this.facetIdentity.parentWorkspace() ?? this.name,
      webSearch,
    });
    return (finished: ToolSet) => factory.toolFor(finished);
  }

  // ── Recursive split — head spawns more heads (facets in head mode)
  private async runRecursiveSplit(
    request: {
      readonly rationale: string;
      readonly heads: readonly SubheadRequest[];
      readonly mergeStrategy: MergeStrategy;
    },
    parentBudget: HeadBudget,
    parentInput: HeadInput,
  ): Promise<{
    narrative: string;
    decisions: readonly Decision[];
    unresolvedQuestions: readonly string[];
    blindSpots: readonly string[];
    childHeadIds: readonly HeadId[];
    headCount: number;
  }> {
    // The subtree's journal belongs to the ROOT, never to this intermediate
    // facet. Journalling locally is the C2 defect: a depth-1 head wrote its
    // children's spawn/report rows into its OWN SQLite while their step rows
    // were recorded on the root, so the surface's head_journal -> head_steps
    // join could never match and a depth-2 head was unreadable from anywhere.
    // One place for both halves, reached over the same cross-DO port the
    // mission ledger uses.
    const parent = this.getSharedParentStub();
    if (!parent) {
      throw new Error(
        'A recursive split needs its root workspace; setSharedParent must run before split_subheads.',
      );
    }
    const journal: HeadJournalPort = {
      recordSplit: (rootId, rationale, spawnedAt) =>
        parent.headJournalRecordSplit(rootId, rationale, spawnedAt),
      insertSpawn: (childInput) => parent.headJournalInsertSpawn(childInput),
      recordReport: (report) => parent.headJournalRecordReport(report),
      cacheMerge: (rootId, result, strategy) =>
        parent.headJournalCacheMerge(rootId, result, strategy),
    };
    const runtime = createHeadRuntime({
      host: this,
      identity: async () => ({
        ownerUserId: this.facetIdentity.ownerUserId(),
        capabilityToken: this.facetIdentity.capabilityToken(),
        // The ROOT orchestrator, propagated unchanged so the whole subtree
        // shares one findings scratch (not this intermediate head).
        sharedParent: this.facetIdentity.parentWorkspace(),
      }),
      models: this.facetModelServices,
      // The merge resolves `judge` — the account-wide deep tier — off this
      // profile. Resolving off `parentInput.model` runs a synthesis filed as
      // deep-tier grading on whatever model the head itself was given.
      profile: () => this.facetProfile(),
      // Reported to the root over the same cross-DO port the journal above uses,
      // because that is where the workspace's total is assembled.
      reportModelCall: (report) => this.keepAliveWhile(async () => {
        // Cost reporting must not hold the recursive merge, but its keep-alive
        // owner retains the cross-isolate RPC until the root acknowledges it.
        try {
          await parent.reportFacetModelCall(report);
        } catch (cause) {
          diagnostics.failure('event.model_call_emit_failed', toKinuError({
            doing: 'forwarding a model_call report to the root workspace',
            cause,
            otherwise: 'io',
          }), { source: report.source });
        }
      }),
      // The merge's operation frames go to the root beside its cost report.
      operations: this.facetModelOperations,
      // No `grounding`: a subtree's merge stays n=1 with neutral head scores.
      // Grounding one multiplies it into `mergeSamples` syntheses plus a judge
      // pass per head, and whether every level pays that is a heads-policy call.
    });

    const controller = new HeadController(runtime, journal);
    const controllerInput: Parameters<HeadController['run']>[0] = {
      parentHeadId: parentInput.id,
      parentDepth: parentInput.depth,
      rootId: parentInput.rootId,
      inheritedContext: parentInput.inheritedContext,
      request: { rationale: request.rationale, heads: [...request.heads], mergeStrategy: request.mergeStrategy },
      parentBudget,
      mode: parentInput.mode,
      model: parentInput.model,
      // A subtree charges the same mission its root does — otherwise a head
      // escapes its budget simply by splitting again.
    };
    if (parentInput.missionLabels?.length) controllerInput.missionLabels = parentInput.missionLabels;
    const result: MergeResult = await controller.run(controllerInput);

    return {
      narrative: result.mergedNarrative,
      decisions: result.selectedDecisions,
      unresolvedQuestions: result.unresolvedQuestions,
      blindSpots: result.blindSpots,
      childHeadIds: result.headIds,
      headCount: result.costSummary.headCount,
    };
  }
}
