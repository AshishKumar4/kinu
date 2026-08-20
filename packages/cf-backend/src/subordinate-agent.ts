import { callable, getAgentByName, type AgentContext, type SubAgentClass } from 'agents';
import { SUBORDINATE_RPC_SURFACE, sealRpcSurface } from './rpc-surface';
import { convertToModelMessages } from 'ai';
import type { ChatResponseResult } from '@cloudflare/think';
import {
  EvolutionEngine,
  initWorkspaceSchema,
  renderSoulMarkdown,
  snapshotCompletedTurn,
  type CompletedTurn,
  type SubordinateHandoff,
  type WorkMode,
  type SubordinateReportStatus,
  // report.* — codemode projection of the native `report` tool.
  createReportCodemodeProvider, type CodemodeProvider,
  type DelegationBudget,
} from '@kinu/core';
import {
  ActorAgent,
  type ActorToolDeps,
} from './actor-agent';
import type { OrchestratorAgent } from './orchestrator';
import {
  SubordinateIdentityStore,
  admitSubordinateTask,
  describeSubordinateHandoff,
  readSubordinateLiveStatus,
  subordinateRelaysTurnEnd,
  type SubordinateLiveStatus,
  type SubordinateReportOrigin,
} from '@kinu/core';
import { diagnostics, toProteusError } from '@kinu/core/obs';

/** The workspace root's class name, which is also its Durable Object binding
 *  name — the equality the SDK itself relies on when it resolves a top-level
 *  parent as `env[cls.name]`. `satisfies keyof Env` keeps it tied to the binding. */
const WORKSPACE_ACTOR_CLASS = 'OrchestratorAgent' satisfies keyof Env;

export interface SetSubordinateIdentityInput {
  name: string;
  displayName: string;
  role: string;
  mission: string;
  model?: string;
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
    diagnostics.failure('subordinate.report_failed', toProteusError({
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
    return `.proteus/agents/${encodeURIComponent(this.name)}/scaffold/agent.js`;
  }

  protected shellId(): string { return `subordinate:${this.name}`; }

  protected async loadSoulText(): Promise<string> {
    const identity = this.identity.read();
    return identity
      ? renderSoulMarkdown({
        name: identity.displayName,
        mission: `Role: ${identity.role}\n\n${identity.mission}`,
      })
      : '';
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
    if (!this.lastUserTurnIsProgrammatic()) return deps;
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
    if (!input.name || !input.displayName || !input.role || !input.mission) {
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
      displayName: input.displayName,
      role: input.role,
      mission: input.mission,
      parentWorkspace: bootstrap.parentWorkspace,
      ownerUserId: bootstrap.ownerUserId,
      depth: bootstrap.depth,
    });
    this.config.setDisplayName(input.displayName);
    if (input.capabilityToken) await this.installWorkspaceCapability(input.capabilityToken);
    const model = input.model ?? bootstrap.model;
    if (model) this.config.setModel(model);
    this._cachedSoulText = null;
    this._cachedSystemPrompt = null;
    this.invalidateModelCaches();
    await this.ensureOwnedScaffold();
    return { ok: true };
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
    role: string;
    mission: string;
    model: string | null;
  }> {
    this.ensureSchema();
    const identity = this.identity.read();
    if (!identity) throw new Error('Subordinate identity is not initialized.');
    return {
      name: identity.name,
      displayName: identity.displayName,
      role: identity.role,
      mission: identity.mission,
      model: this.getStoredModelId(),
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
    const turnMode = this.turnWorkMode();
    const { programmaticUserMessage, errorText, completed } = this.settleTurnEvents(result);
    this.recordTurnTelemetry(result, { errorText, completed, programmaticUserMessage });
    if (!completed) {
      this.reportedThisTurn = false;
      return;
    }

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

    await this.extensions.emitTurnEnd({
      text: assistantText,
      responseMessages: await convertToModelMessages([result.message], { ignoreIncompleteToolCalls: true }),
    });

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
    const turn: CompletedTurn = snapshotCompletedTurn(this.acc, completedTurn);
    if (turnMode !== 'plan') this.settleCompletedTurn(turn);

    if (subordinateRelaysTurnEnd({ reportedThisTurn: this.reportedThisTurn, ownerDriven, assistantText })) {
      void this.sendReport('progress', assistantText, 'turn_end')
        .catch(reportSubordinateFailure('turn_end'));
    }
    this.reportedThisTurn = false;
    void this.orch.drainPendingEvents();
  }
}
