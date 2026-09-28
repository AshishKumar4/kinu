/** One hired agent in its own loader isolate (D9): its own SQLite, the workspace's tools, files and shell over RPC. */
import { DurableObject } from 'cloudflare:workers';
import { Nimbus, type NimbusSandbox, type NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import type { UIMessage } from 'ai';
import {
  decodeJsonValue,
  type AgentOwnInspection, type ChatHistoryPage, type JsonValue, type NimbusSandboxHandle, type PageRequest, type ProviderEnv,
  type SerializedMessage, type SubordinateInspectionResult,
} from '@kinu.run/core';
import { AgentDatabase } from './agent-database';
import { queueAgentTask, type AgentWorkspace } from './agent-turn';
import type { AgentOpening, AgentRecovery, AgentSnapshot, AgentTask } from './protocol';

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

async function json(result: Promise<unknown>): Promise<JsonValue | undefined> {
  const value = await result;

  return value === undefined ? undefined : decodeJsonValue({ value });
}

function sandboxHandle(sandbox: NimbusSandbox): NimbusSandboxHandle {
  return {
    ready: () => sandbox.ready(),
    exec: (command, options) => sandbox.exec(command, options),
    startProcess: (command, options) => sandbox.startProcess(command, options),
    runCode: (code, options) => sandbox.runCode(code, options),
    files: sandbox.files,
    runtimes: {
      ensure: (specs, options) => json(sandbox.runtimes.ensure(specs, options)),
      install: (spec, options) => json(sandbox.runtimes.install(spec, options)),
      list: () => json(sandbox.runtimes.list()),
    },
    processes: {
      list: () => json(sandbox.processes.list()),
      kill: (pid) => json(sandbox.processes.kill(pid)),
      logs: (pid, options) => json(sandbox.processes.logs(pid, options)),
    },
  };
}

export interface AgentFacetCalls {
  deliver(snapshot: AgentSnapshot, task: AgentTask): Promise<void>;
  openTurn(snapshot: AgentSnapshot, opening: AgentOpening): Promise<void>;
  history(snapshot: AgentSnapshot, limit?: number): Promise<UIMessage[]>;
  historyPage(snapshot: AgentSnapshot, page: PageRequest): Promise<ChatHistoryPage>;
  inspect(snapshot: AgentSnapshot, request: AgentOwnInspection): Promise<SubordinateInspectionResult>;
  inheritedContext(snapshot: AgentSnapshot): Promise<SerializedMessage[]>;
  admitted(snapshot: AgentSnapshot, id: string): Promise<boolean>;
  interrupt(snapshot: AgentSnapshot): Promise<void>;
  clear(snapshot: AgentSnapshot): Promise<void>;
  recover(snapshot: AgentSnapshot, answered: readonly string[]): Promise<AgentRecovery>;
}

export class AgentFacet extends DurableObject<AgentFacetEnv> implements AgentFacetCalls {
  private box: NimbusSandboxHandle | undefined;

  private stateBox: NimbusSandboxHandle | undefined;

  private database: AgentDatabase | undefined;

  private queue: Promise<void> = Promise.resolve();

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
    this.database ??= new AgentDatabase(this.ctx.storage, { agent: () => this.workspace(), state: () => this.state() });
    this.database.adopt(snapshot);

    return this.database;
  }

  async deliver(snapshot: AgentSnapshot, task: AgentTask): Promise<void> {
    const database = this.open(snapshot);

    // Not awaited: the call returns once the turn is queued, so the workspace holds no call open into this isolate.
    this.queue = queueAgentTask({ after: this.queue, database, workspace: this.env.WORKSPACE, providers: this.env, task });
  }

  async openTurn(snapshot: AgentSnapshot, opening: AgentOpening): Promise<void> {
    await this.open(snapshot).open(opening);
  }

  async history(snapshot: AgentSnapshot, limit?: number): Promise<UIMessage[]> {
    return await this.open(snapshot).history(limit);
  }

  async historyPage(snapshot: AgentSnapshot, page: PageRequest): Promise<ChatHistoryPage> {
    return await this.open(snapshot).historyPage(page);
  }

  async inspect(snapshot: AgentSnapshot, request: AgentOwnInspection): Promise<SubordinateInspectionResult> {
    return await this.open(snapshot).inspect(request);
  }

  async inheritedContext(snapshot: AgentSnapshot): Promise<SerializedMessage[]> {
    return await this.open(snapshot).inheritedContext();
  }

  async admitted(snapshot: AgentSnapshot, id: string): Promise<boolean> {
    return this.open(snapshot).admitted(id);
  }

  async interrupt(snapshot: AgentSnapshot): Promise<void> {
    await this.open(snapshot).interrupt();
  }

  async clear(snapshot: AgentSnapshot): Promise<void> {
    await this.open(snapshot).clear();
  }

  async recover(snapshot: AgentSnapshot, answered: readonly string[]): Promise<AgentRecovery> {
    return await this.open(snapshot).recover(new Set(answered));
  }
}
