import * as v from 'valibot';
import { callable, getAgentByName, type AgentContext, type SubAgentClass } from 'agents';
import { SUBORDINATE_RPC_SURFACE, sealRpcSurface } from './rpc-surface';
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
  type RoleSelection, type InlineSteer,
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
import type { NimbusSandboxHandle } from '@kinu.run/core';
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
import { TERMINAL_LANE_FIBER } from './fiber-recovery';

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
  /** Current role selection. The child's agent_config row is authoritative. */
  role: RoleSelection;
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

export class SubordinateAgent extends ActorAgent {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, SUBORDINATE_RPC_SURFACE);
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
    if (!this._identity) this._identity = new SubordinateIdentityStore(this.ctx.storage.sql, this.boundSql);
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

  /** A subordinate hires the same facet class it is. */
  protected subordinateFacet(): SubAgentClass<SubordinateAgent> {
    return SubordinateAgent;
  }

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
      const workspace = await getAgentByName<Env, OrchestratorAgent>(
        this.env[WORKSPACE_ACTOR_CLASS], this.workspaceName(),
      );
      this._workspaceTitle = await workspace.workspaceTitle();
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

  /**
   * The leading block of the identity section — the SAME position the
   * freeform line always occupied. A catalog hire shows its role id; a
   * pre-catalog hire keeps its original text as a LABELLED legacy block, so
   * no user prose silently changes shape or place, until an explicit catalog
   * assignment replaces and clears it.
   */
  private identityRoleBlock(role: RoleSelection): string {
    if (role.kind === 'catalog') return `Role: ${role.roleId}`;
    return [
      'Legacy role (assigned before this workspace had a role catalog):',
      role.text,
      'You keep these instructions until you are explicitly assigned a catalog role.',
    ].join('\n');
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
    // Every field here comes from the PARENT's answer, `depth` included. The
    // input carries no depth to ignore, and the parent refuses at the cap, so a
    // subordinate cannot be seeded past it however it was asked for.
    this.identity.seed({
      name: input.name,
      mission: input.mission,
      parentWorkspace: bootstrap.parentWorkspace,
      ownerUserId: bootstrap.ownerUserId,
      depth: bootstrap.depth,
      lifetime: input.lifetime,
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

  /** Synchronous by contract — see `OrchestratorAgent.onStart`. The scaffold this
   *  subordinate runs is bootstrapped where it is needed: at identity seeding
   *  above, and on the turn path (`ActorAgent.beforeTurn`). */
  onStart(): void {
    this.ensureSchema();
    // The same budget-first prune the root runs: a subordinate carries the same
    // four durable lanes, so it accumulates the same interrupted-fiber rows.
    // One budget here; a pass that filled it is finished by the terminal wake,
    // whose tick re-runs every budgeted sweep.
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
      // An unseeded subordinate has run no turn and can owe no transition —
      // and its terminal ledger deps need the parent identity to build at all.
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
    role: RoleSelection;
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
    // The identity of THIS terminal sequence: the durable turn plus the response
    // being settled. Both, because Think fires this hook once per response and a
    // continuation keeps the turn's user-message id.
    //
    // NOTHING FROM HERE TO `settle` MAY AWAIT, for the reason the root says it
    // there: Think has already persisted the answer, so an await before the claim
    // exists is a window where recovery finds a durable answer with no incomplete
    // transition and replays nothing. The response-to-model-message conversion
    // lives inside the `turn_end_extensions` body, where the claim already exists.
    // An EMPTY assistant id is not an identity, exactly as the root reads it:
    // every per-effect scope derives from this value, so two such responses would
    // share one scope and the second would read the first's work as its own.
    const durableTurnId = this.durableTurnId();
    const transition = durableTurnId === null || result.message.id === ''
      ? null
      : { turnId: durableTurnId, messageId: result.message.id };

    const userMessages = this.messages.filter((message) => message.role === 'user');
    const lastUserMessage = programmaticUserMessage ?? userMessages.at(-1);
    const userText = lastUserMessage?.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? '';
    const assistantText = result.message.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? '';

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
}
