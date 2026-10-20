/**
 * Hosted Plan/eval probe: crafted-tool declarations are re-read, not cached,
 * and `plan` mode is refused at the seam `build` is admitted at.
 */
import { Effect } from 'effect';
import { Agent } from 'agents';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import type { CodemodeSurface, CraftedTool } from '@kinu.run/core';
import { craftedToolDeclarations, DynamicContextLedger, selectInjectableCraftedTools, settleWorkspaceRoot, settleSharedRoots, WORKSPACE_ROOT, serveStores } from '@kinu.run/core';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import { seedBaseFilesystem } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { createCodemodeToolFactory, type CodemodeScope } from '../../src/codemode-tool';
import { BROWSER_PRELUDE } from '../../src/browser-prelude';
import { actorNamespaces, createAgentStores, adaptMemory, initWorkspaceSchema, SURFACE_POLICY, WorkspaceActorDirectory, type ActorHandle, type ExecutorProviderSurface, type SqlExecutor, type SurfaceActor } from '@kinu.run/core';
import { bindAgentSql } from '../../src/runtime';
import { bindActorHandle, createDefaultWebSearchProvider, initAgentDataTables, toolsInWorkMode, inWorkMode, narrowToolSurface, slateToolReach, type WorkMode } from '@kinu.run/core';
import { CodemodeEgress as ProductionEgress } from '../../src/codemode-egress';
import { codemodeLauncher, type ProgramLaunch } from '../../src/codemode-sandbox';
import { SlateHost } from '../../src/slates/host';
import { initSlateBuildTable, SlateBuilds } from '@kinu.run/core/slates';
import { createMemoryVfs } from '@kinu.run/test-utils/vfs';
import { KinuError } from '@kinu.run/core/obs';
import type { BrowserSessions } from '@kinu.run/core';
import { ROOT_SLATE_CALLER } from '@kinu.run/core/slates';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { jsonSchema, tool as defineTool } from 'ai';
import type { JsonObject, UserCaller } from '@kinu.run/core';
import { callUserMcpTool } from '../../src/user-mcp-call';
import type { McpToolCall } from '../../src/user/mcp-servers';
import { storeFiles, workspacePath } from '@kinu.run/core/workspace';
import { sqliteFiles } from '@nimbus-sh/core/vfs/sqlite-files.js';
import { cloudPlanes, TurnContextBudget, type FileDeps } from '@kinu.run/core';
import { TurnFileLedger } from '../../../core/src/vfs/file-ledger';
import { MemoryStore } from '@kinu.run/agent-utils/memory';

const NO_BROWSER_RUN = { missing: 'this probe reaches no Browser Run' };

const SEARCHES_NOTHING = async (): Promise<never> => { throw new KinuError('unavailable', 'this probe searches nothing'); };

const NO_BROWSERS: BrowserSessions = { open: async () => { throw new Error('this probe opens no browser'); }, list: async () => [], close: async () => {} };

/** A probe's actor over genuine stores; its caller supplies any machine and file plane it exercises. */
function probeActor(storage: DurableObjectStorage, sql: SqlExecutor, handle: ActorHandle, scope: { executors?: ExecutorProviderSurface[]; files?: FileDeps } = {}): SurfaceActor {
  const unreached = (): never => { throw new Error('this probe supplies no file plane'); };

  const { files } = scope;
  const vfs = createMemoryVfs().vfs;
  const transaction = storage.transactionSync.bind(storage);
  const stores = createAgentStores(() => sql, () => handle, transaction, async () => ({ vfs, artifactDirectory: '/probe-artifacts' }));
  const memory = adaptMemory(new MemoryStore(vfs, sql, transaction), vfs);

  return {
    executors: () => scope.executors ?? [],
    web: { search: createDefaultWebSearchProvider({ fetch, search: SEARCHES_NOTHING, browser: NO_BROWSER_RUN }), files: { vfs: createMemoryVfs().vfs, home: WORKSPACE_ROOT }, browser: { sessions: NO_BROWSERS, prelude: BROWSER_PRELUDE } },
    stores: serveStores({
      memory: () => ({ memory, actor: handle, conversations: stores.conversationSearch }),
      files: files === undefined ? unreached : () => files,
      tasks: () => ({ list: stores.taskList, config: stores.config, roleSwitch: null }),
    }),
    db: stores.appData,
    agents: null, self: null, ownerWaits: null, mail: null,
  };
}



/** A probe's programs, as its own owner's: online, they reach the network as the probe's agent, holding no secret. */
function probeLaunch(name: string): (online: boolean) => ProgramLaunch {
  return (online) => codemodeLauncher({ kinuNode: true, egress: online ? { workspace: name, actor: name, asOwner: true, ownerUserId: null } : null }, async () => ({}));
}

export class CodemodeEgress extends ProductionEgress {
  override async fetch(): Promise<Response> { return new Response('network allowed'); }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

export class SlateActorProbeRoot extends Agent<ProbeEnv> {
  async craftedSlate(): Promise<string> {
    const vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
    // As the Kinu boot leaves every workspace: /slates is the kernel's, shared with the workspace's agents.
    settleSharedRoots(vfs.as(CRED_KERNEL), (path) => { vfs.registerSharedDirectory(path); });
    const files = vfs.as(CRED_SESSION_USER);
    files.mkdir('/slates/crafted', { recursive: true });
    files.writeFile('/slates/crafted/package.json', JSON.stringify({ main: 'server.ts' }));
    const sql = bindAgentSql(this);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS crafted_tools(name TEXT, score REAL, last_used_at INTEGER)');
    initAgentDataTables((statement) => { this.ctx.storage.sql.exec(statement); });
    initSlateBuildTable((statement) => { this.ctx.storage.sql.exec(statement); });

    const crafted: CraftedTool = {
      name: 'calculate', code: 'async ({n}) => ({answer: n*2, agent:typeof agent, agents:typeof agents})', description: 'Double',
      createdAt: 0, updatedAt: 0,
    };

    const factory = createCodemodeToolFactory({
      launch: probeLaunch('binding-probe'), workspace: 'binding-probe',
    });

    const actor = bindActorHandle(sql, { actorId: 'binding-probe', workspaceId: 'binding-probe', parentActorId: null, name: 'binding-probe', storageKey: 'binding-probe' }, () => Effect.void);

    const probe = probeActor(this.ctx.storage, sql, actor);

    const scope: CodemodeScope = {
      reach: slateToolReach(narrowToolSurface(undefined)),
      namespaces: (executor) => actorNamespaces(probe, SURFACE_POLICY.program, { executor }),
    };

    // The store holds `crafted`, read fresh per program as a runtime's surface reads it.
    const surface: CodemodeSurface = { cwd: WORKSPACE_ROOT, native: {}, external: () => ({}), craftedTools: () => selectInjectableCraftedTools({ list: () => [crafted] }, sql), stores: probe.stores };

    const host = new SlateHost({
      ctx: this.ctx, workspace: 'binding-probe', builds: new SlateBuilds(this.ctx.storage.sql),
      session: async () => ({ vfs, processes: new SessionProcessSupervisor(), filesystem: new ProcessFiles(vfs) }),
      facetManager: async () => { throw new Error('binding probe does not boot a process'); },
      bundler: () => { throw new Error('binding probe does not bundle a slate'); },
      apps: {
        ensure: async () => { throw new Error('binding probe does not boot a process'); },
        remove: async () => { throw new Error('binding probe does not keep durable applications'); },
        url: async () => { throw new Error('binding probe does not expose a preview'); },
        owners: async () => new Map(),
      },
      dispatch: async (caller, route) => {
        if (route.kind !== 'tool') throw new Error('Expected a crafted tool call');

        return await inWorkMode(caller.workMode, () => factory.callTool(surface, route.name, route.input, scope)) ?? null;
      },
      browserActor: async () => null,
      catalog: async () => ({ mcp: [], slates: [] }),
      shareEntry: () => null,
    });

    const call = (mode: WorkMode) => host.surfaceCall({ caller: { ...ROOT_SLATE_CALLER, workMode: mode }, id: 'crafted', name: 'workspace', lineage: { incarnation: 'probe', generation: 0, ancestors: {} } }, { path: ['tools', 'calculate'], args: [{ n: 21 }], invocation: null });
    const tool = factory.toolFor(surface, scope);
    const declarations = () => craftedToolDeclarations({ eval: tool }, { workMode: 'build', allowedTools: ['eval'] });
    const before = declarations();
    const first = await call('build');
    crafted.code = 'async ({n}) => n*3';
    crafted.description = 'Triple';
    const second = await call('build');
    const planned = await call('plan');
    const ledger = new DynamicContextLedger();
    ledger.weave([{ role: 'user', content: 'inspect' }], { executors: [{ name: 'computer', available: true, configured: true, status: 'idle' }] });

    const updated = ledger.weave([{ role: 'user', content: 'inspect' }, { role: 'assistant', content: 'connected' }], {
      executors: [{ name: 'computer', available: true, configured: true, active: true, status: 'active' }],
    });

    return JSON.stringify({ first, second, planned, declarations: { before, after: declarations() }, delta: updated.at(-1)?.content });
  }

  /**
   * An eval stopped while its calls are held: a native tool that answers only when stopped, and an MCP tool whose
   * server holds the call. The user stops as the server takes it; the hub records each call id and each cancel.
   */
  async stopDuringHeldCalls(): Promise<{ answer: string; called: string[]; cancelled: string[] }> {
    const sql = bindAgentSql(this);
    initAgentDataTables((statement) => { this.ctx.storage.sql.exec(statement); });
    const stop = new AbortController();
    const called: string[] = [];
    const cancelled: string[] = [];
    const caller: UserCaller = { workspaceToken: 'stop-probe' };

    const stub = {
      userMcp_callTool: (_caller: UserCaller, call: McpToolCall): Promise<string> => {
        called.push(call.id);
        queueMicrotask(() => { stop.abort(); });

        return new Promise<string>(() => {});
      },
      userMcp_cancelCall: async (_caller: UserCaller, callId: string): Promise<void> => { cancelled.push(callId); },
    };

    const native = {
      hold: defineTool({
        description: 'Answers only when stopped',
        inputSchema: jsonSchema<JsonObject>({ type: 'object' }),
        execute: (_args, options) => new Promise<string>((resolve) => {
          options.abortSignal?.addEventListener('abort', () => { resolve('stopped'); }, { once: true });
        }),
      }),
    };

    const external = {
      mcp_srv_hold: defineTool({
        description: 'Held by its server',
        inputSchema: jsonSchema<JsonObject>({ type: 'object' }),
        execute: async (args, options) => callUserMcpTool({ stub, caller }, { serverId: 'srv', name: 'hold' }, args, options.abortSignal),
      }),
    };

    const factory = createCodemodeToolFactory({
      launch: probeLaunch('stop-probe'), workspace: 'stop-probe',
    });

    const actor = bindActorHandle(sql, {
      actorId: 'stop-probe', workspaceId: 'stop-probe', parentActorId: null,
      name: 'stop-probe', storageKey: 'stop-probe',
    }, () => Effect.void);

    // The surface and its namespaces carry the probe actor's one store set.
    const probe = probeActor(this.ctx.storage, sql, actor);

    const execute = factory.toolFor({ cwd: WORKSPACE_ROOT, native, external: () => external, craftedTools: () => [], stores: probe.stores }, {
      reach: narrowToolSurface(undefined),
      namespaces: (executor) => actorNamespaces(probe, SURFACE_POLICY.program, { executor }),
    }).execute;

    if (execute === undefined) throw new Error('No callable codemode tool');

    const answer = await execute({ code: [
      'const native = tools.hold({});',
      'const mcp = tools.mcp_srv_hold({});',
      'return { native: await native, mcp: await mcp };',
    ].join('\n') }, { toolCallId: 'stop-probe', messages: [], context: undefined, abortSignal: stop.signal });

    return { answer: JSON.stringify(answer ?? null), called, cancelled };
  }

  async code(mode: WorkMode, code: string): Promise<{ answer: string; file: string }> {
    const vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
    // As a workspace boot leaves it: Nimbus's base tree, and the workspace root the session user owns.
    seedBaseFilesystem(vfs, WORKSPACE_ROOT);
    settleWorkspaceRoot(vfs.as(CRED_KERNEL));
    const files = vfs.as(CRED_SESSION_USER);

    if (!files.exists('/home/main/plan-data.txt')) files.writeFile('/home/main/plan-data.txt', 'original');
    const sql = bindAgentSql(this);

    initWorkspaceSchema({ execRaw: (statement) => { this.ctx.storage.sql.exec(statement); }, sql, exec: this.ctx.storage.sql, transactionSync: this.ctx.storage.transactionSync.bind(this.ctx.storage) });
    void sql`INSERT OR IGNORE INTO workspace_identity (id, name) VALUES (${'mode-probe'}, ${'mode-probe'})`;

    const factory = createCodemodeToolFactory({
      launch: probeLaunch('mode-probe'), workspace: 'mode-probe',
    });

    const actor = new WorkspaceActorDirectory(sql, { workspaceId: 'mode-probe', ownerUserId: '' }).createMain({ name: 'mode-probe' });

    const native = sqliteFiles(vfs, CRED_SESSION_USER);

    const fileScope: FileDeps = {
      vfs: {
        ...storeFiles(async () => vfs, { home: WORKSPACE_ROOT }),
        writeFileIfRevision: (path, data, revision) => native.writeFileIfRevision(workspacePath(path, WORKSPACE_ROOT), data, revision),
      },
      home: WORKSPACE_ROOT,
      planes: cloudPlanes(WORKSPACE_ROOT), ledger: new TurnFileLedger(), budget: new TurnContextBudget(),
    };

    const probe = probeActor(this.ctx.storage, sql, actor, { executors: [{
      name: 'workspace', positionalArgs: true, capabilities: new Set(), tools: {},
      fileRoot: async () => ({ root: '' }),
    }], files: fileScope });

    const scope: CodemodeScope = {
      reach: narrowToolSurface(undefined),
      namespaces: (executor) => actorNamespaces(probe, SURFACE_POLICY.program, { executor }),
    };

    const tool = toolsInWorkMode(mode, { eval: factory.toolFor({ cwd: WORKSPACE_ROOT, native: {}, external: () => ({}), craftedTools: () => [], stores: probe.stores }, scope) }).eval;
    const execute = tool?.execute;

    if (execute === undefined) throw new Error('No callable codemode tool');
    const answer = await execute({ code }, { toolCallId: 'mode-probe', messages: [], context: undefined });

    return { answer: JSON.stringify(answer ?? null), file: files.readFileString('/home/main/plan-data.txt') };
  }
}

export * from '../../src/server';
