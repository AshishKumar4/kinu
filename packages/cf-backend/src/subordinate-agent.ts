import * as v from 'valibot';
import { callable, getAgentByName, type AgentContext, type SubAgentClass } from 'agents';
import { SUBORDINATE_RPC_SURFACE, sealRpcSurface } from './rpc-surface';
import { convertToModelMessages } from 'ai';
import type { ChatResponseResult } from '@cloudflare/think';
import {
  EvolutionEngine,
  initWorkspaceSchema,
  renderSoulMarkdown,
  snapshotCompletedTurn,
  // Names how this turn ended, from facts. Never a string chosen here.
  classifyRunEnd,
  type SubordinateHandoff,
  type WorkMode,
  type SubordinateReportStatus,
  // report.* — codemode projection of the native `report` tool.
  createReportCodemodeProvider, type CodemodeProvider,
  type DelegationBudget,
  type PlanReview,
  planReviewAwaitingDecision,
  subordinateDescriptorSource,
  type RoleSelection,
  type TierId,
  TIER_IDS,
} from '@kinu.run/core';
import {
  ActorAgent,
  type ActorToolDeps,
} from './actor-agent';
import type { AgentKind } from './analytics/record';
import type { OrchestratorAgent } from './orchestrator';
import {
  SubordinateIdentityStore,
  admitSubordinateTask,
  describeSubordinateHandoff,
  readSubordinateLiveStatus,
  subordinateRelaysTurnEnd,
  type SubordinateLiveStatus,
  type SubordinateReportOrigin,
} from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

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

  /** What this subordinate is FOR. Its own mission, which for an agent the
   *  owner added without saying anything is the workspace's, inherited at
   *  creation. Also what its own further hires inherit. */
  protected ownMission(): string {
    return this.identity.read()?.mission ?? '';
  }

  protected async loadSoulText(): Promise<string> {
    const identity = this.identity.read();
    const descriptor = subordinateDescriptorSource(this.config).read();
    return identity && descriptor
      ? renderSoulMarkdown({
        name: descriptor.displayName || identity.name,
        mission: `${this.identityRoleBlock(descriptor.role)}\n\n${identity.mission}`,
      })
      : '';
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
          const result = await this.sendReport(input.status, input.content, 'report_tool');
          this.reportedThisTurn = true;
          return result;
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
    this._cachedSystemPrompt = null;
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
    this._cachedSystemPrompt = null;
    this.broadcast(JSON.stringify({ type: 'workspace_renamed', displayName }));
    return { ok: true };
  }

  /**
   * An auto title lands on this subordinate's own config first, then on the
   * parent's roster row — which is the one every roster reader shows, so
   * skipping it would leave the owner looking at a blank tab for an agent
   * that has named itself.
   *
   * The parent write is not swallowed: a title only this facet knows about is
   * a title nobody can see, and reporting `false` would claim the owner
   * renamed it, re-arming a titling pass that already spent a model call.
   */
  protected async persistAutoTitle(displayName: string): Promise<boolean> {
    if (this.config.getNameOrigin() === 'user') return false;
    this.config.setDisplayNameOrigin(displayName, 'auto');
    this._cachedSoulText = null;
    this._cachedSystemPrompt = null;
    this.broadcast(JSON.stringify({ type: 'workspace_renamed', displayName }));
    const parent = await this.parentActor();
    await parent.recordSubordinateTitle(this.name, displayName);
    return true;
  }

  /** Synchronous by contract — see `OrchestratorAgent.onStart`. The scaffold this
   *  subordinate runs is bootstrapped where it is needed: at identity seeding
   *  above, and on the turn path (`ActorAgent.beforeTurn`). */
  onStart(): void {
    this.ensureSchema();
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
    };
  }

  private async sendReport(
    status: SubordinateReportStatus,
    content: string,
    origin: SubordinateReportOrigin,
  ): Promise<{ id: string; admitted: boolean }> {
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
      mode: this.turnWorkMode(),
    });
  }

  async onChatResponse(result: ChatResponseResult): Promise<void> {
    const { programmaticUserMessage, errorText, completed } = this.settleTurnEvents(result);
    this.recordTurnTelemetry(result, { errorText, completed, programmaticUserMessage });

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
    // The same settle spine the root uses, on every status. This method used to
    // early-return on a turn that did not complete, so a cut or errored
    // subordinate turn reached neither the outcome review nor its extensions —
    // the identical drop the root had, one class down. Plan turns still record
    // nothing; core's `turnEvolutionEnabled` gate owns that. The spine hands
    // back the SAME verdict core returned — whether the completed-build
    // improvement lanes may run — and the auto-title below consumes that, not
    // its own spelling of the condition.
    const improvementLanesOpen = await this.settleTurnSpine({
      status: classifyRunEnd({
        completed, interrupted: result.status === 'aborted', errorText,
        // Think reports 'completed' for a turn its own stop condition cut, so
        // the model's last word is the only thing that can tell the two apart.
        lastFinishReason: this.acc.lastFinishReason,
      }).reason,
      turn: snapshotCompletedTurn(this.acc, completedTurn),
      onTurnEnd: async () => {
        await this.extensions.emitTurnEnd({
          text: assistantText,
          responseMessages: await convertToModelMessages(
            [result.message], { ignoreIncompleteToolCalls: true },
          ),
        });
      },
    });
    if (!completed) {
      this.reportedThisTurn = false;
      return;
    }

    // Title this agent from the first thing its OWNER said to it.
    //
    // The mission is deliberately not the source here, and that is the one
    // place this differs from the workspace root. A subordinate's mission is
    // either its hire brief — already turned into a role-derived name its
    // parent chose — or, for an agent the owner added with nothing to say,
    // the workspace's own mission, which every sibling shares. Titling from
    // it would name them all the same thing. What actually distinguishes this
    // agent is what the owner brings to it, so that is what names it.
    //
    // Fire-and-forget and once-only: persisting marks `name_origin`, after
    // which the shared policy no longer matches. A programmatic turn is not a
    // trigger — a parent's assignment is not the owner talking.
    if (ownerDriven && improvementLanesOpen) void this.maybeAutoTitle(userText);

    if (subordinateRelaysTurnEnd({ reportedThisTurn: this.reportedThisTurn, ownerDriven, assistantText })) {
      void this.sendReport('progress', assistantText, 'turn_end')
        .catch(reportSubordinateFailure('turn_end'));
    }
    this.reportedThisTurn = false;
  }
}
