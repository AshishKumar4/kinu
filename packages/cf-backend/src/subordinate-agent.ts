import { callable } from 'agents';
import { convertToModelMessages } from 'ai';
import type { ChatResponseResult } from '@cloudflare/think';
import { initCompactionStateTable } from '@proteus/compaction';
import {
  EvolutionEngine,
  bootstrapScaffold,
  createParentRpcMountVFS,
  initAllTables,
  initBackgroundJobsTable,
  initCraftScoreTables,
  initCurriculumTable,
  initEventsHubTables,
  initFactsTable,
  initGepaTables,
  initHeadsTables,
  initRunEventTables,
  initScaffoldTables,
  initSearchTables,
  initShadowTables,
  initTurnOutcomeTables,
  seedSoul,
  type CompletedTurn,
  type ParentRpcFileHandle,
  type SubordinateReportStatus,
} from '@proteus/core';
import {
  ActorAgent,
  type ActorToolDeps,
} from './actor-agent.js';
import { OrchestratorAgent } from './orchestrator.js';
import {
  SubordinateIdentityStore,
  admitSubordinateTask,
} from './subordinate-support.js';

export interface SetSubordinateIdentityInput {
  name: string;
  displayName: string;
  role: string;
  mission: string;
  model?: string;
}

export class SubordinateAgent extends ActorAgent {
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

  protected workspaceName(): string {
    const parentWorkspace = this.identity.workspaceName();
    if (!parentWorkspace) throw new Error('Subordinate identity has not been seeded by its parent workspace.');
    return parentWorkspace;
  }

  protected get engine(): EvolutionEngine {
    if (!this._engine) this._engine = new EvolutionEngine(this.rt, { enabled: true });
    return this._engine;
  }

  protected actorToolDeps(): ActorToolDeps {
    return {
      report: {
        report: async (input) => {
          const result = await this.sendReport(input.status, input.content);
          this.reportedThisTurn = true;
          return result;
        },
      },
    };
  }

  protected notifyOwner(subject: string, body: string): void {
    void this.sendReport('progress', `${subject}\n\n${body}`).catch((error: unknown) => {
      console.warn('[subordinate] parent notification failed:', error);
    });
  }

  private ensureSchema(): void {
    if (this._schemaReady) return;
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);
    initAllTables(execRaw);
    initSearchTables(execRaw);
    initScaffoldTables(execRaw);
    initCraftScoreTables(execRaw);
    initTurnOutcomeTables(execRaw, this.boundSql);
    initEventsHubTables(this.ctx.storage.sql);
    initHeadsTables(execRaw);
    initShadowTables(execRaw);
    initRunEventTables(execRaw);
    initFactsTable(execRaw);
    initCurriculumTable(execRaw);
    initGepaTables(execRaw);
    initBackgroundJobsTable(execRaw);
    initCompactionStateTable(execRaw);
    execRaw(`CREATE TABLE IF NOT EXISTS agent_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    this.identity.ensureSchema();
    this._schemaReady = true;
  }

  private async mountParentWorkspace(): Promise<void> {
    const parent = await this.parentAgent(OrchestratorAgent);
    const handle: ParentRpcFileHandle = {
      read: (path) => parent.readWorkspaceFile(path),
      write: (input) => parent.writeWorkspaceFile(input),
      list: (path) => parent.listWorkspaceFiles(path),
      stat: (path) => parent.statWorkspaceFile(path),
      delete: (path) => parent.deleteWorkspaceFile(path),
    };
    this.rt.compositeVfs.mount('workspace', {
      vfs: createParentRpcMountVFS(handle),
      policy: {
        readOnly: false,
        rootPath: '',
        consistency: 'durable',
        credentialsStayInHost: true,
      },
    });
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
    seedSoul(this.boundSql, {
      name: input.displayName,
      mission: `Role: ${input.role}\n\n${input.mission}`,
    });
    this.config.setDisplayName(input.displayName);
    const model = input.model ?? bootstrap.model;
    if (model) this.config.setModel(model);
    this._cachedSoulText = null;
    this._cachedSystemPrompt = null;
    this.invalidateModelCaches();
    await this.mountParentWorkspace();
    if (!(await this.rt.identity.scaffold.exists())) await bootstrapScaffold(this.rt);
    return { ok: true };
  }

  async onStart(): Promise<void> {
    this.ensureSchema();
    if (this.identity.read()) {
      await this.mountParentWorkspace();
      if (!(await this.rt.identity.scaffold.exists())) await bootstrapScaffold(this.rt);
    }
  }

  async enqueueSubordinateTask(input: {
    kind: 'task' | 'message';
    body: string;
    deliverable?: string;
    deadlineHint?: string;
  }): Promise<{ id: string; admitted: boolean }> {
    this.ensureSchema();
    const result = admitSubordinateTask(this.eventLog, {
      fromWorkspace: this.workspaceName(),
      kind: input.kind,
      body: input.body,
      ...(input.deliverable ? { deliverable: input.deliverable } : {}),
      ...(input.deadlineHint ? { deadlineHint: input.deadlineHint } : {}),
      now: Date.now(),
    });
    if (result.admitted) this.orch.scheduleDrain();
    return result;
  }

  async getSubordinateStatus(): Promise<{ lastActivity: number | null }> {
    this.ensureSchema();
    const row = this.ctx.storage.sql.exec(
      `SELECT MAX(created_at) AS last_activity FROM activity_log`,
    ).toArray()[0];
    return { lastActivity: typeof row?.last_activity === 'number' ? row.last_activity : null };
  }

  private async sendReport(status: SubordinateReportStatus, content: string): Promise<unknown> {
    const identity = this.identity.read();
    if (!identity) throw new Error('Subordinate identity is not initialized.');
    const parent = this.env.OrchestratorAgent.get(
      this.env.OrchestratorAgent.idFromName(identity.parentWorkspace),
    );
    return parent.receiveSubordinateEvent({
      fromSubordinate: identity.name,
      status,
      content,
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

    const turn: CompletedTurn = {
      userMessage: userText,
      assistantResponse: assistantText,
      toolCalls: this.acc.toolCalls,
      steps: this.acc.stepCount,
      durationMs: this.acc.startedAt > 0 ? Date.now() - this.acc.startedAt : 0,
      feedback: null,
      hadError: this.acc.hadError,
      ...(result.message.id ? { turnId: result.message.id } : {}),
      sessionId: 'default',
      origin: programmaticUserMessage || this.lastUserTurnIsProgrammatic() ? 'programmatic' : 'user',
    };
    this.orch.recordTurn(turn);

    if (!this.reportedThisTurn && assistantText.trim()) {
      void this.sendReport('progress', assistantText).catch((error: unknown) => {
        console.warn('[subordinate] turn-end report failed:', error);
      });
    }
    this.reportedThisTurn = false;
    void this.orch.drainPendingEvents();
  }
}
