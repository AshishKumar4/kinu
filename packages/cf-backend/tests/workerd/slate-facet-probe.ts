import { Agent, type AgentContext } from 'agents';
import { SubordinateAgent } from '../../src/subordinate-agent';
import { sealRpcSurface, SUBORDINATE_RPC_SURFACE, EXPLORATION_RPC_SURFACE } from '../../src/rpc-surface';
import type { JsonValue, SlateReadModel } from '@kinu.run/core';
import * as v from 'valibot';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { createExecuteToolsFactory } from '../../src/execute-tools';
import { bindAgentSql } from '../../src/runtime';
import { createDefaultWebSearchProvider, initCodemodeStateTable, toolsInWorkMode, type WorkMode } from '@kinu.run/core';
import { CodemodeEgress as ProductionEgress, codemodeEgress } from '../../src/codemode-egress';

/** The external network boundary is deterministic; real WorkerLoader egress still selects it. */
export class CodemodeEgress extends ProductionEgress {
  override async fetch(): Promise<Response> { return new Response('network allowed'); }
}
type ActorEnv = ConstructorParameters<typeof SubordinateAgent>[1];

/** Real actor constructor, dispatch and native RPC; only the final read model
 * is fixture data, so no model call or external service is needed. */
export class SlateSubordinateProbe extends SubordinateAgent {
  constructor(ctx: AgentContext, env: ActorEnv) {
    super(ctx, env);
    sealRpcSurface(this, SUBORDINATE_RPC_SURFACE);
  }

  protected override async slateReadModel(method: SlateReadModel): Promise<JsonValue> {
    return { answeredBy: 'facet', method, browserCallable: this.getCallableMethods().has('slateBindingDispatch') };
  }
}

export class SlateExplorationProbe extends SlateSubordinateProbe {
  constructor(ctx: AgentContext, env: ActorEnv) {
    super(ctx, env);
    sealRpcSurface(this, EXPLORATION_RPC_SURFACE);
  }
}

export class SlateFacetRootProbe extends Agent<ActorEnv> {
  async exercise(family: 'subordinate' | 'exploration') {
    const child = family === 'subordinate'
      ? await this.subAgent(SlateSubordinateProbe, 'subordinate')
      : await this.subAgent(SlateExplorationProbe, 'exploration');
    const value = await child.slateBindingDispatch([], { kind: 'rpc', method: 'getExecutors' }, 'build');
    return v.parse(v.object({ answeredBy: v.string(), method: v.string(), browserCallable: v.boolean() }), value);
  }

  async code(mode: WorkMode, code: string): Promise<{ answer: string; file: string }> {
    const files = new SqliteVFS(this.ctx.storage.sql, this.ctx).as(CRED_SESSION_USER);
    files.mkdir('/home/user', { recursive: true });
    if (!files.exists('/home/user/plan-data.txt')) files.writeFile('/home/user/plan-data.txt', 'original');
    const sql = bindAgentSql(this);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS crafted_tools(name TEXT, score REAL, last_used_at INTEGER)');
    initCodemodeStateTable((statement) => { this.ctx.storage.sql.exec(statement); });
    const factory = createExecuteToolsFactory({
      loader: this.env.LOADER, egress: codemodeEgress(), sql, workspace: 'mode-probe',
      webSearch: createDefaultWebSearchProvider({ fetch }),
      rt: {
        craftStore: { list: () => [] },
        executionRouter: { getProviders: () => [{
          name: 'workspace', positionalArgs: true,
          tools: {
            readFile: { planAllowed: true, description: 'Read the fixture file', execute: async () => files.readFileString('/home/user/plan-data.txt') },
            writeFile: { description: 'Modify the fixture file', execute: async () => { files.writeFile('/home/user/plan-data.txt', 'changed'); return 'written'; } },
          },
        }] },
      },
    });
    const tool = toolsInWorkMode(mode, { execute_tools: factory.toolFor({}) }).execute_tools;
    const execute = tool?.execute;
    if (execute === undefined) throw new Error('No callable codemode tool');
    const answer = await execute({ code }, { toolCallId: 'mode-probe', messages: [] });
    return { answer: JSON.stringify(answer ?? null), file: files.readFileString('/home/user/plan-data.txt') };
  }
}
