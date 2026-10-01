/**
 * Hosted Plan/eval probe: crafted-tool declarations are re-read, not cached,
 * and `plan` mode is refused at the seam `build` is admitted at.
 */
import { Effect } from 'effect';
import { Agent } from 'agents';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import type { CraftedTool } from '@kinu.run/core';
import { craftedToolDeclarations, DynamicContextLedger, settleWorkspaceRoot, settleWorkspaceSlates } from '@kinu.run/core';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import { seedBaseFilesystem } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { createCodemodeToolFactory } from '../../src/codemode-tool';
import { bindAgentSql } from '../../src/runtime';
import { bindActorHandle, createDefaultWebSearchProvider, initCodemodeStateTable, toolsInWorkMode, inWorkMode, narrowToolSurface, slateToolReach, type WorkMode } from '@kinu.run/core';
import { CodemodeEgress as ProductionEgress } from '../../src/codemode-egress';
import { codemodeLauncher } from '../../src/codemode-sandbox';
import { SlateHost } from '../../src/slates/host';
import { createMemoryVfs } from '@kinu.run/test-utils/vfs';
import type { BrowserSessions } from '@kinu.run/core';
import { ROOT_SLATE_CALLER } from '../../src/slates/bindings';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';

const NO_BROWSER_RUN = { missing: 'this probe reaches no Browser Run' };

const NO_BROWSERS: BrowserSessions = { open: async () => { throw new Error('this probe opens no browser'); }, list: async () => [], close: async () => {} };

export class CodemodeEgress extends ProductionEgress {
  override async fetch(): Promise<Response> { return new Response('network allowed'); }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

export class SlateActorProbeRoot extends Agent<ProbeEnv> {
  async craftedSlate(): Promise<string> {
    const vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
    // As the Kinu boot leaves every workspace: /slates is the kernel's, shared with the workspace's agents.
    settleWorkspaceSlates(vfs.as(CRED_KERNEL), (path) => { vfs.registerSharedDirectory(path); });
    const files = vfs.as(CRED_SESSION_USER);
    files.mkdir('/slates/crafted', { recursive: true });
    files.writeFile('/slates/crafted/package.json', JSON.stringify({
      main: 'server.ts', slate: { bindings: { CALCULATE: { kind: 'tool', name: 'calculate' } } },
    }));
    const sql = bindAgentSql(this);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS crafted_tools(name TEXT, score REAL, last_used_at INTEGER)');
    initCodemodeStateTable((statement) => { this.ctx.storage.sql.exec(statement); });

    const crafted: CraftedTool = {
      name: 'calculate', code: 'async ({n}) => ({answer: n*2, agent:typeof agent, agents:typeof agents})', description: 'Double',
      createdAt: 0, updatedAt: 0,
    };

    const factory = createCodemodeToolFactory({
      launch: (online) => codemodeLauncher({ kinuNode: true, egress: online ? { workspace: 'binding-probe', actor: 'binding-probe' } : null }), sql, workspace: 'binding-probe',
      webSearch: createDefaultWebSearchProvider({ fetch, browser: NO_BROWSER_RUN }), reach: slateToolReach(narrowToolSurface(undefined)),
      browserSessions: NO_BROWSERS,
      rt: {
        actor: bindActorHandle(sql, { actorId: 'binding-probe', workspaceId: 'binding-probe', parentActorId: null, name: 'binding-probe', storageKey: 'binding-probe' }, () => Effect.void),
        craftStore: { list: () => [crafted] },
        storage: { vfs: createMemoryVfs().vfs },
      },
    });

    const host = new SlateHost({
      ctx: this.ctx, workspace: 'binding-probe',
      session: async () => ({ vfs, processes: new SessionProcessSupervisor(), filesystem: new ProcessFiles(vfs) }),
      facetManager: async () => { throw new Error('binding probe does not boot a process'); },
      apps: {
        ensure: async () => { throw new Error('binding probe does not boot a process'); },
        remove: async () => { throw new Error('binding probe does not keep durable applications'); },
        url: async () => { throw new Error('binding probe does not expose a preview'); },
      },
      dispatch: async (caller, route) => {
        if (route.kind !== 'tool') throw new Error('Expected a tool binding');

        return await inWorkMode(caller.workMode, () => factory.callTool({}, route.name, route.input)) ?? null;
      },
      catalog: async () => ({ executors: [], mcp: [], tools: [], tiers: [], slates: {} }),
      shareUrl: async () => null,
    });

    const call = (mode: WorkMode) => host.bindingCall({ ...ROOT_SLATE_CALLER, workMode: mode }, 'crafted', 'CALCULATE', { member: 'call', args: [{ n: 21 }], invocation: null });
    const tool = factory.toolFor({});
    const declarations = () => craftedToolDeclarations({ eval: tool }, { workMode: 'build', allowedTools: ['eval'] });
    const before = declarations();
    const first = await call('build');
    crafted.code = 'async ({n}) => n*3';
    crafted.description = 'Triple';
    const second = await call('build');
    const planned = await call('plan');
    const ledger = new DynamicContextLedger();
    ledger.weave([{ role: 'user', content: 'inspect' }], { executors: [{ name: 'sandbox', available: true, configured: true, status: 'idle' }] });

    const updated = ledger.weave([{ role: 'user', content: 'inspect' }, { role: 'assistant', content: 'connected' }], {
      executors: [{ name: 'sandbox', available: true, configured: true, active: true, status: 'active' }],
    });

    return JSON.stringify({ first, second, planned, declarations: { before, after: declarations() }, delta: updated.at(-1)?.content });
  }

  async code(mode: WorkMode, code: string): Promise<{ answer: string; file: string }> {
    const vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
    // As a workspace boot leaves it: Nimbus's base tree, and the workspace root the session user owns.
    seedBaseFilesystem(vfs);
    settleWorkspaceRoot(vfs.as(CRED_KERNEL));
    const files = vfs.as(CRED_SESSION_USER);

    if (!files.exists('/home/main/plan-data.txt')) files.writeFile('/home/main/plan-data.txt', 'original');
    const sql = bindAgentSql(this);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS crafted_tools(name TEXT, score REAL, last_used_at INTEGER)');
    initCodemodeStateTable((statement) => { this.ctx.storage.sql.exec(statement); });

    const factory = createCodemodeToolFactory({
      launch: (online) => codemodeLauncher({ kinuNode: true, egress: online ? { workspace: 'mode-probe', actor: 'mode-probe' } : null }), sql, workspace: 'mode-probe',
      webSearch: createDefaultWebSearchProvider({ fetch, browser: NO_BROWSER_RUN }),
      browserSessions: NO_BROWSERS,
      rt: {
        storage: { vfs: createMemoryVfs().vfs },
        actor: bindActorHandle(sql, {
          actorId: 'mode-probe', workspaceId: 'mode-probe', parentActorId: null,
          name: 'mode-probe', storageKey: 'mode-probe',
        }, () => Effect.void),
        craftStore: { list: () => [] },
        executionRouter: { getProviders: () => [{
          name: 'workspace', positionalArgs: true,
          tools: {
            readFile: { planAllowed: true, description: 'Read the fixture file', execute: async () => files.readFileString('/home/main/plan-data.txt') },
            writeFile: { description: 'Modify the fixture file', execute: async () => {
              files.writeFile('/home/main/plan-data.txt', 'changed');

              return 'written';
            } },
          },
        }] },
      },
    });

    const tool = toolsInWorkMode(mode, { eval: factory.toolFor({}) }).eval;
    const execute = tool?.execute;

    if (execute === undefined) throw new Error('No callable codemode tool');
    const answer = await execute({ code }, { toolCallId: 'mode-probe', messages: [] });

    return { answer: JSON.stringify(answer ?? null), file: files.readFileString('/home/main/plan-data.txt') };
  }
}

export * from '../../src/server';
