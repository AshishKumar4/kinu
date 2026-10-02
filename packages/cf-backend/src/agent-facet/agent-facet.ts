import { type VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
/** One non-main agent in its own loader isolate (D9). */
import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { Nimbus, type NimbusSandbox, type NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import type { ModelMessage, UIMessage } from 'ai';
import {
  jsonResultOrVoid, readAgentArchivePage,
  type AgentFigures,
  type AgentOwnInspection, type AnsweredEvolutionHelper, type ArchiveAgentPage, type ArchiveSqlCursor, type ChatHistoryPage,
  type NimbusSandboxHandle, type PositionPageRequest, type ProviderEnv, type SerializedMessage, type SubordinateInspectionResult,
  servedContextTree, type ContextEditor, type ContextTreeRemote, type SpendLedger, type StepSpendSource, type TurnRequestIndex, type TurnRequestPage, type ConversationSearchHit, type ConversationScrollResult, type ConversationSummary,
} from '@kinu.run/core';
import { AgentDatabase } from './agent-database';
import { queueAgentTask, type AgentWorkspace } from './agent-turn';
import type { AgentTurnOpening, AgentRecovery, AgentSnapshot, AgentTurnTask, TurnRequestAt } from '@kinu.run/core';

export type { AgentWorkspace } from './agent-turn';

export interface AgentFacetEnv {
  readonly WORKSPACE: AgentWorkspace;
  readonly WORKSPACE_NAME: string;
  readonly SHELL_ID: string;
  readonly HOME: string;
  readonly STATE_SHELL_ID: string;
  readonly AI?: ProviderEnv['AI'];
  readonly AI_GATEWAY_URL?: string;
  readonly WORKERS_AI_VIA_BINDING?: string;
}

function sandboxHandle(sandbox: NimbusSandbox): NimbusSandboxHandle {
  return {
    ready: () => sandbox.ready(),
    exec: (command, options) => sandbox.exec(command, options),
    execStream: (command, options) => sandbox.execStream(command, options),
    startProcess: (command, options) => sandbox.startProcess(command, options),
    runCode: (code, options) => sandbox.runCode(code, options),
    files: sandbox.files,
    runtimes: {
      ensure: (specs, options) => jsonResultOrVoid(sandbox.runtimes.ensure(specs, options)),
      install: (spec, options) => jsonResultOrVoid(sandbox.runtimes.install(spec, options)),
      list: () => jsonResultOrVoid(sandbox.runtimes.list()),
    },
    processes: {
      list: () => jsonResultOrVoid(sandbox.processes.list()),
      kill: (pid) => jsonResultOrVoid(sandbox.processes.kill(pid)),
      logs: (pid, options) => jsonResultOrVoid(sandbox.processes.logs(pid, options)),
    },
  };
}

class AgentContextTree extends RpcTarget implements ContextTreeRemote {
  constructor(private readonly served: ContextTreeRemote) { super(); }

  readFile(path: string) { return this.served.readFile(path); }
  readFileAtRevision(path: string, revision: VfsRevision, range?: { readonly offset: number; readonly length: number }) { return this.served.readFileAtRevision(path, revision, range); }
  readRange(path: string, offset: number, length: number) { return this.served.readRange(path, offset, length); }
  readdir(path: string) { return this.served.readdir(path); }
  stat(path: string, options?: { follow?: boolean }) { return this.served.stat(path, options); }
  writeFile(path: string, data: Uint8Array) { return this.served.writeFile(path, data); }
  writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision) { return this.served.writeFileIfRevision(path, data, expected); }
}

export interface AgentFacetCalls {
  deliver(snapshot: AgentSnapshot, task: AgentTurnTask): Promise<void>;
  holds(turnId: string): Promise<boolean>;
  openTurn(snapshot: AgentSnapshot, opening: AgentTurnOpening): Promise<void>;
  history(snapshot: AgentSnapshot, limit?: number): Promise<UIMessage[]>;
  historyPage(snapshot: AgentSnapshot, page: PositionPageRequest): Promise<ChatHistoryPage>;
  messageCount(snapshot: AgentSnapshot): Promise<number>;
  inspect(snapshot: AgentSnapshot, request: AgentOwnInspection): Promise<SubordinateInspectionResult>;
  inheritedContext(snapshot: AgentSnapshot): Promise<SerializedMessage[]>;
  workingContext(snapshot: AgentSnapshot): Promise<readonly ModelMessage[]>;
  turnRequests(snapshot: AgentSnapshot, turnId: string): Promise<TurnRequestIndex>;
  turnRequest(snapshot: AgentSnapshot, at: TurnRequestAt): Promise<TurnRequestPage>;
  spend(snapshot: AgentSnapshot, steps: readonly StepSpendSource[]): Promise<SpendLedger>;
  figures(snapshot: AgentSnapshot): Promise<AgentFigures>;
  context(snapshot: AgentSnapshot, editor: ContextEditor): Promise<ContextTreeRemote>;
  searchConversations(snapshot: AgentSnapshot, query: string, limit?: number): Promise<ConversationSearchHit[]>;
  scrollConversation(snapshot: AgentSnapshot, around: string, window?: number, maxChars?: number): Promise<ConversationScrollResult | null>;
  browseConversations(snapshot: AgentSnapshot, limit?: number): Promise<ConversationSummary[]>;
  admitted(snapshot: AgentSnapshot, id: string): Promise<boolean>;
  interrupt(snapshot: AgentSnapshot, turnId: string): Promise<void>;
  clear(snapshot: AgentSnapshot): Promise<void>;
  recover(snapshot: AgentSnapshot): Promise<AgentRecovery>;
  archivePage(snapshot: AgentSnapshot, cursor: ArchiveSqlCursor | null, maxBytes: number): Promise<ArchiveAgentPage>;
  deliverAdvice(snapshot: AgentSnapshot, helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean>;
}

export class AgentFacet extends DurableObject<AgentFacetEnv> implements AgentFacetCalls {
  private box: NimbusSandboxHandle | undefined;

  private stateBox: NimbusSandboxHandle | undefined;

  private database: AgentDatabase | undefined;

  private queue: Promise<void> = Promise.resolve();

  private readonly held = new Set<string>();

  protected workspace(): NimbusSandboxHandle {
    this.box ??= sandboxHandle(Nimbus.fromSession((): NimbusSessionSurface => this.env.WORKSPACE.session())
      .sandbox(this.env.WORKSPACE_NAME, { shellId: this.env.SHELL_ID, root: this.env.HOME }));

    return this.box;
  }

  private state(): NimbusSandboxHandle {
    this.stateBox ??= sandboxHandle(Nimbus.fromSession((): NimbusSessionSurface => this.env.WORKSPACE.stateSession())
      .sandbox(this.env.WORKSPACE_NAME, { shellId: this.env.STATE_SHELL_ID }));

    return this.stateBox;
  }


  private open(snapshot: AgentSnapshot): AgentDatabase {
    this.database ??= new AgentDatabase(this.ctx.storage, {
      agent: () => this.workspace(), state: () => this.state(), enqueueTurn: (input) => this.env.WORKSPACE.enqueueTurn(input),
      memory: () => this.env.WORKSPACE.memory(), program: (...args) => this.env.WORKSPACE.program(...args),
      sayToParent: (signal) => this.env.WORKSPACE.sayToParent(signal),
    });
    this.database.adopt(snapshot);

    return this.database;
  }

  async deliver(snapshot: AgentSnapshot, task: AgentTurnTask): Promise<void> {
    const database = this.open(snapshot);

    this.held.add(task.sequenceId);
    this.queue = queueAgentTask({ after: this.queue, database, workspace: this.env.WORKSPACE, providers: this.env, task })
      .finally(() => { this.held.delete(task.sequenceId); });
  }

  async holds(turnId: string): Promise<boolean> {
    return this.held.has(turnId);
  }

  async openTurn(snapshot: AgentSnapshot, opening: AgentTurnOpening): Promise<void> {
    await this.open(snapshot).open(opening);
  }

  async history(snapshot: AgentSnapshot, limit?: number): Promise<UIMessage[]> {
    return await this.open(snapshot).history(limit);
  }

  async historyPage(snapshot: AgentSnapshot, page: PositionPageRequest): Promise<ChatHistoryPage> {
    return await this.open(snapshot).historyPage(page);
  }

  async archivePage(snapshot: AgentSnapshot, cursor: ArchiveSqlCursor | null, maxBytes: number): Promise<ArchiveAgentPage> {
    return readAgentArchivePage(this.ctx.storage.sql, this.open(snapshot).reference().actorId, cursor, maxBytes);
  }

  async inspect(snapshot: AgentSnapshot, request: AgentOwnInspection): Promise<SubordinateInspectionResult> {
    return await this.open(snapshot).inspect(request);
  }

  async inheritedContext(snapshot: AgentSnapshot): Promise<SerializedMessage[]> {
    return await this.open(snapshot).inheritedContext();
  }

  async workingContext(snapshot: AgentSnapshot): Promise<readonly ModelMessage[]> {
    return await this.open(snapshot).workingContext();
  }

  async turnRequests(snapshot: AgentSnapshot, turnId: string): Promise<TurnRequestIndex> {
    return this.open(snapshot).turnRequests(turnId);
  }

  async turnRequest(snapshot: AgentSnapshot, at: TurnRequestAt): Promise<TurnRequestPage> {
    return await this.open(snapshot).turnRequest(at);
  }

  async messageCount(snapshot: AgentSnapshot): Promise<number> {
    return this.open(snapshot).messageCount();
  }

  async searchConversations(snapshot: AgentSnapshot, query: string, limit?: number): Promise<ConversationSearchHit[]> {
    return await this.open(snapshot).conversations().search(query, limit);
  }

  async scrollConversation(snapshot: AgentSnapshot, around: string, window?: number, maxChars?: number): Promise<ConversationScrollResult | null> {
    return await this.open(snapshot).conversations().scroll(around, window, maxChars);
  }

  async browseConversations(snapshot: AgentSnapshot, limit?: number): Promise<ConversationSummary[]> {
    return await this.open(snapshot).conversations().browse(limit);
  }

  async context(snapshot: AgentSnapshot, editor: ContextEditor): Promise<ContextTreeRemote> {
    return new AgentContextTree(servedContextTree(this.open(snapshot).contextTree(editor)));
  }

  async spend(snapshot: AgentSnapshot, steps: readonly StepSpendSource[]): Promise<SpendLedger> {
    return this.open(snapshot).spend(steps);
  }

  async figures(snapshot: AgentSnapshot): Promise<AgentFigures> {
    return this.open(snapshot).figures();
  }

  async admitted(snapshot: AgentSnapshot, id: string): Promise<boolean> {
    return this.open(snapshot).admitted(id);
  }

  async interrupt(snapshot: AgentSnapshot, turnId: string): Promise<void> {
    this.open(snapshot).interrupt(turnId);
  }

  async clear(snapshot: AgentSnapshot): Promise<void> {
    await this.open(snapshot).clear();
  }

  async recover(snapshot: AgentSnapshot): Promise<AgentRecovery> {
    return await this.open(snapshot).recover();
  }

  async deliverAdvice(snapshot: AgentSnapshot, helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean> {
    return await (await this.open(snapshot).acquire()).session.sayAdvisorAnswer(helper, turnId);
  }
}
