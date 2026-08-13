import { callable, type AgentContext } from 'agents';
import { SUBORDINATE_RPC_SURFACE, sealRpcSurface } from './rpc-surface.js';
import { convertToModelMessages } from 'ai';
import type { ChatResponseResult } from '@cloudflare/think';
import {
  EvolutionEngine,
  bootstrapScaffold,
  createParentExecutor, createParentWorkspaceVfs,
  initWorkspaceSchema,
  seedSoul,
  snapshotCompletedTurn,
  type CompletedTurn,
  type ParentWorkspaceHandle, type ParentRpcWrite,
  type SubordinateHandoff,
  type SubordinateReportStatus,
  // Read models — the same control-plane implementations the orchestrator uses.
  cancelCurrentWork, getStoredModelSpec, setModel, type CancelWorkOutcome,
  // report.* — codemode projection of the native `report` tool.
  createReportCodemodeProvider, type CodemodeProvider,
} from '@proteus/core';
import {
  ActorAgent,
  type ActorToolDeps,
} from './actor-agent.js';
import { OrchestratorAgent } from './orchestrator.js';
import {
  SubordinateIdentityStore,
  admitSubordinateTask,
  describeSubordinateHandoff,
  readSubordinateLiveStatus,
  subordinateRelaysTurnEnd,
  type SubordinateLiveStatus,
  type SubordinateReportOrigin,
} from '@proteus/core';

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
    if (!this._identity) this._identity = new SubordinateIdentityStore(this.ctx.storage.sql);
    return this._identity;
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

  protected get engine(): EvolutionEngine {
    if (!this._engine) {
      this._engine = new EvolutionEngine(this.rt, {
        enabled: true,
        ...this.shadowTrialPorts,
      });
    }
    return this._engine;
  }

  protected actorToolDeps(): ActorToolDeps {
    return {
      report: {
        report: async (input) => {
          const result = await this.sendReport(input.status, input.content, 'report_tool');
          this.reportedThisTurn = true;
          return result;
        },
      },
    };
  }

  /** `report.*` — the same ReportToolDeps the native `report` tool holds, so
   *  a codemode-scripted report and a direct tool call reach the SAME
   *  sendReport path. Unconditional here: every subordinate has one. */
  protected extraCodemodeProviders(): CodemodeProvider[] {
    return [createReportCodemodeProvider(() => this.actorToolDeps().report!)];
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
      .catch((error: unknown) => {
        console.warn('[subordinate] parent notification failed:', error);
      });
  }

  private ensureSchema(): void {
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
    this._schemaReady = true;
  }

  private async registerParentWorkspace(): Promise<void> {
    const parent = await this.parentAgent(OrchestratorAgent);
    const handle: ParentWorkspaceHandle = {
      read: (path: string) => parent.readWorkspaceFile(path),
      write: (input: ParentRpcWrite) => parent.writeWorkspaceFile(input),
      list: (path: string) => parent.listWorkspaceFiles(path),
      stat: (path: string) => parent.statWorkspaceFile(path),
      delete: (path: string) => parent.deleteWorkspaceFile(path),
      exec: (command: string) => parent.execWorkspaceCommand(command),
    };
    // An executor named `parent`, not a directory of this subordinate's own
    // filesystem: the parent workspace is another Durable Object reached over
    // async RPC, exactly like the sandbox and the user's machine.
    this.rt.executionRouter?.register(createParentExecutor({ handle }));
  }

  @callable()
  async setSubordinateIdentity(input: SetSubordinateIdentityInput): Promise<{ ok: true }> {
    if (!input.name || !input.displayName || !input.role || !input.mission) {
      throw new Error('complete subordinate identity is required');
    }
    this.ensureSchema();
    if (input.name !== this.name) throw new Error('subordinate identity name must match its facet name');
    const parent = await this.parentAgent(OrchestratorAgent);
    const bootstrap = await parent.getSubordinateBootstrapIdentity();
    const existing = this.identity.read();
    if (existing && (existing.name !== input.name
      || existing.parentWorkspace !== bootstrap.parentWorkspace
      || existing.ownerUserId !== bootstrap.ownerUserId)) {
      throw new Error('subordinate identity is immutable');
    }
    this.identity.seed({
      name: input.name,
      displayName: input.displayName,
      role: input.role,
      mission: input.mission,
      parentWorkspace: bootstrap.parentWorkspace,
      ownerUserId: bootstrap.ownerUserId,
    });
    await seedSoul(this.rt.storage.vfs, this.boundSql, {
      name: input.displayName,
      mission: `Role: ${input.role}\n\n${input.mission}`,
    });
    this.config.setDisplayName(input.displayName);
    if (input.capabilityToken) await this.installWorkspaceCapability(input.capabilityToken);
    const model = input.model ?? bootstrap.model;
    if (model) this.config.setModel(model);
    this._cachedSoulText = null;
    this._cachedSystemPrompt = null;
    this.invalidateModelCaches();
    await this.registerParentWorkspace();
    if (!(await this.rt.identity.scaffold.exists())) await bootstrapScaffold(this.rt);
    return { ok: true };
  }

  async onStart(): Promise<void> {
    this.ensureSchema();
    if (this.identity.read()) {
      await this.registerParentWorkspace();
      if (!(await this.rt.identity.scaffold.exists())) await bootstrapScaffold(this.rt);
    }
  }

  /**
   * Admit work from the parent and tell it what happened to it.
   *
   * The delivery branch is decided here and not guessed by the caller: this DO
   * is the only place that knows whether a turn is live right now, and the
   * drain it schedules will splice into that turn rather than queue behind it
   * (BackendHost.turnInFlight). Reading `_inFlight` before admission
   * keeps the answer about the turn the batch will actually reach.
   */
  async enqueueSubordinateTask(input: {
    kind: 'task' | 'message';
    body: string;
    deliverable?: string;
    deadlineHint?: string;
    inheritedContext?: string;
  }): Promise<{ id: string; admitted: boolean } & SubordinateHandoff> {
    this.ensureSchema();
    const busy = this._inFlight;
    const result = admitSubordinateTask(this.eventLog, {
      fromWorkspace: this.workspaceName(),
      kind: input.kind,
      body: input.body,
      ...(input.deliverable ? { deliverable: input.deliverable } : {}),
      ...(input.deadlineHint ? { deadlineHint: input.deadlineHint } : {}),
      ...(input.inheritedContext ? { inheritedContext: input.inheritedContext } : {}),
      now: Date.now(),
    });
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

  @callable()
  async getStoredModelSpec(): Promise<{ spec: string | null }> {
    this.ensureSchema();
    return getStoredModelSpec(this.config);
  }

  @callable()
  async setModel(spec: string): Promise<{ ok: true; spec: string }> {
    this.ensureSchema();
    return setModel({
      config: this.config,
      normalize: (s) => this.providerRegistry().normalizeSpecSync(s),
      onChanged: () => this.invalidateModelCaches(),
    }, spec);
  }

  @callable()
  async cancelCurrentWork(): Promise<CancelWorkOutcome> {
    this.ensureSchema();
    return cancelCurrentWork({
      jobRunner: this.jobRunner,
      activeToolControllers: this._activeToolControllers,
      broadcast: (payload) => this.broadcast(payload),
    });
  }

  private async sendReport(
    status: SubordinateReportStatus,
    content: string,
    origin: SubordinateReportOrigin,
  ): Promise<unknown> {
    const identity = this.identity.read();
    if (!identity) throw new Error('Subordinate identity is not initialized.');
    const parent = this.env.OrchestratorAgent.get(
      this.env.OrchestratorAgent.idFromName(identity.parentWorkspace),
    );
    return parent.receiveSubordinateEvent({
      fromSubordinate: identity.name,
      status,
      content,
      origin,
    });
  }

  async onChatResponse(result: ChatResponseResult): Promise<void> {
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

    const turn: CompletedTurn = snapshotCompletedTurn(this.acc, {
      userMessage: userText,
      assistantResponse: assistantText,
      ...(result.message.id ? { turnId: result.message.id } : {}),
      sessionId: 'default',
      origin: ownerDriven ? 'user' : 'programmatic',
    });
    this.settleCompletedTurn(turn);

    if (subordinateRelaysTurnEnd({ reportedThisTurn: this.reportedThisTurn, ownerDriven, assistantText })) {
      void this.sendReport('progress', assistantText, 'turn_end').catch((error: unknown) => {
        console.warn('[subordinate] turn-end report failed:', error);
      });
    }
    this.reportedThisTurn = false;
    void this.orch.drainPendingEvents();
  }
}
