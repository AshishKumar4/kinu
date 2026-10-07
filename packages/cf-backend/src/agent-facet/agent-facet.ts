import { type VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
/** One non-main agent in its own loader isolate (D9). */
import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { Nimbus, type NimbusSandbox, type NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import type { UIMessage } from 'ai';
import {
  encodeModelMessageValues, jsonResultOrVoid, readAgentArchivePage,
  type AgentOwnInspection, type AnsweredEvolutionHelper, type JsonValue, type ArchiveAgentPage, type ArchiveSqlCursor, type ChatHistoryPage,
  type NimbusSandboxHandle, type PositionPageRequest, type ProviderEnv, type SerializedMessage, type SubordinateInspectionResult,
  servedContextTree, type ContextEditor, type ContextTreeRemote, type SpendLedger, type StepSpendSource, type TurnRequestIndex, type TurnRequestPage, type ConversationSearchHit, type ConversationScrollResult, type ConversationSummary,
} from '@kinu.run/core';
import { AgentDatabase } from './agent-database';
import { runAgentTask, type AgentWorkspace } from './agent-turn';
import { FacetChat } from './agent-chat';
import type {
  AgentRecovery, AgentSnapshot, AgentTurnEnd, AgentTurnTask, EnqueueTurnResult, ProgrammaticTurn, PromptFile, SendLanding, SendOptions, TurnRequestAt,
} from '@kinu.run/core';

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

export interface AgentSend {
  readonly text: string;
  readonly files?: readonly PromptFile[];
}

export interface AgentFacetCalls {
  run(snapshot: AgentSnapshot, task: AgentTurnTask): Promise<AgentTurnEnd>;
  /** Answered once its chat has processed it. */
  enqueue(snapshot: AgentSnapshot, turn: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  send(snapshot: AgentSnapshot, input: AgentSend, opts: SendOptions): Promise<SendLanding>;
  /** Resolves once its chat has reserved the words, not when they land. */
  admit(snapshot: AgentSnapshot, input: AgentSend, opts: SendOptions): Promise<void>;
  retry(snapshot: AgentSnapshot, claim: (turnId: string) => void): Promise<SendLanding>;
  interruptChat(snapshot: AgentSnapshot): Promise<readonly string[]>;
  /** What a reset left owed is taken up; the agent tells its workspace what is left once it rests. */
  wake(snapshot: AgentSnapshot): Promise<void>;
  /** A refusal only the owner could fix, parked in the agent's own ledger, may answer now. */
  modelSettingsChanged(snapshot: AgentSnapshot): Promise<void>;
  owed(snapshot: AgentSnapshot): Promise<boolean>;
  /** A retirement waits on it. */
  idle(): Promise<void>;
  history(snapshot: AgentSnapshot, limit?: number): Promise<UIMessage[]>;
  historyPage(snapshot: AgentSnapshot, page: PositionPageRequest): Promise<ChatHistoryPage>;
  messageCount(snapshot: AgentSnapshot): Promise<number>;
  inspect(snapshot: AgentSnapshot, request: AgentOwnInspection): Promise<SubordinateInspectionResult>;
  inheritedContext(snapshot: AgentSnapshot): Promise<SerializedMessage[]>;
  /** In the session codec's durable form, as `AgentWorkspace.resume`. */
  workingContext(snapshot: AgentSnapshot): Promise<readonly JsonValue[]>;
  turnRequests(snapshot: AgentSnapshot, turnId: string): Promise<TurnRequestIndex>;
  turnRequest(snapshot: AgentSnapshot, at: TurnRequestAt): Promise<TurnRequestPage>;
  spend(snapshot: AgentSnapshot, steps: readonly StepSpendSource[]): Promise<SpendLedger>;
  context(snapshot: AgentSnapshot, editor: ContextEditor): Promise<ContextTreeRemote>;
  searchConversations(snapshot: AgentSnapshot, query: string, limit?: number): Promise<ConversationSearchHit[]>;
  scrollConversation(snapshot: AgentSnapshot, around: string, window?: number, maxChars?: number): Promise<ConversationScrollResult | null>;
  browseConversations(snapshot: AgentSnapshot, limit?: number): Promise<ConversationSummary[]>;
  admitted(snapshot: AgentSnapshot, id: string): Promise<boolean>;
  interrupt(snapshot: AgentSnapshot, turnId: string): Promise<void>;
  recover(snapshot: AgentSnapshot): Promise<AgentRecovery>;
  archivePage(snapshot: AgentSnapshot, cursor: ArchiveSqlCursor | null, maxBytes: number): Promise<ArchiveAgentPage>;
  deliverAdvice(snapshot: AgentSnapshot, helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean>;
}

export class AgentFacet extends DurableObject<AgentFacetEnv> implements AgentFacetCalls {
  private box: NimbusSandboxHandle | undefined;

  private stateBox: NimbusSandboxHandle | undefined;

  private database: AgentDatabase | undefined;

  private chat: Promise<FacetChat> | undefined;

  private held: FacetChat | undefined;

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
      agent: () => this.workspace(), home: this.env.HOME, state: () => this.state(),
      enqueueTurn: async (input) => await (await this.chatOf(snapshot)).session.enqueueTurn(input),
      turnInFlight: () => this.held?.session.turnInFlight() ?? false,
      memory: () => this.env.WORKSPACE.memory(), program: (...args) => this.env.WORKSPACE.program(...args),
      sayToParent: (signal) => this.env.WORKSPACE.sayToParent(signal),
    });
    this.database.adopt(snapshot);

    return this.database;
  }

  private async chatOf(snapshot: AgentSnapshot): Promise<FacetChat> {
    const database = this.open(snapshot);

    // The workspace's program first: the actor is built on it.
    this.chat ??= this.env.WORKSPACE.prepareChat({ turnId: null, mode: 'build', userText: '', parentDriven: false })
      .then((prepared) => { database.adopt({ ...snapshot, scaffold: [prepared.scaffold] }); })
      .then(() => database.acquire())
      .then((actor) => {
      const chat = new FacetChat({
        actor, database, workspace: this.env.WORKSPACE, providers: this.env, storage: this.ctx.storage,
      });

      chat.session.measureSessionStart({ restored: chat.session.restoreHistory() });
      this.held = chat;

      return chat;
    });

    return await this.chat;
  }

  async run(snapshot: AgentSnapshot, task: AgentTurnTask): Promise<AgentTurnEnd> {
    return await runAgentTask(this.open(snapshot), this.env.WORKSPACE, this.env, task);
  }

  async enqueue(snapshot: AgentSnapshot, turn: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    return await (await this.chatOf(snapshot)).session.enqueueTurn(turn);
  }

  async send(snapshot: AgentSnapshot, input: AgentSend, opts: SendOptions): Promise<SendLanding> {
    const { session } = await this.chatOf(snapshot);

    return await session.send(input.files === undefined ? input.text : { text: input.text, files: input.files }, opts);
  }

  async admit(snapshot: AgentSnapshot, input: AgentSend, opts: SendOptions): Promise<void> {
    const { session } = await this.chatOf(snapshot);

    await session.admit(input.files === undefined ? input.text : { text: input.text, files: input.files }, opts);
  }

  async retry(snapshot: AgentSnapshot, claim: (turnId: string) => void): Promise<SendLanding> {
    return await (await this.chatOf(snapshot)).session.retry(claim);
  }

  async interruptChat(snapshot: AgentSnapshot): Promise<readonly string[]> {
    return (await this.chatOf(snapshot)).session.interrupt();
  }

  async wake(snapshot: AgentSnapshot): Promise<void> {
    await (await this.chatOf(snapshot)).wake();
  }

  async modelSettingsChanged(snapshot: AgentSnapshot): Promise<void> {
    await (await this.chatOf(snapshot)).modelSettingsChanged();
  }

  async owed(snapshot: AgentSnapshot): Promise<boolean> {
    return (await this.chatOf(snapshot)).session.turnOwed;
  }

  async idle(): Promise<void> {
    await this.held?.idle();
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

  async workingContext(snapshot: AgentSnapshot): Promise<readonly JsonValue[]> {
    return encodeModelMessageValues(await this.open(snapshot).workingContext());
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

  async admitted(snapshot: AgentSnapshot, id: string): Promise<boolean> {
    return this.open(snapshot).admitted(id);
  }

  async interrupt(snapshot: AgentSnapshot, turnId: string): Promise<void> {
    this.open(snapshot).interrupt(turnId);
  }

  async recover(snapshot: AgentSnapshot): Promise<AgentRecovery> {
    return await this.open(snapshot).recover();
  }

  async deliverAdvice(snapshot: AgentSnapshot, helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean> {
    return await (await this.open(snapshot).acquire()).session.sayAdvisorAnswer(helper, turnId);
  }
}
