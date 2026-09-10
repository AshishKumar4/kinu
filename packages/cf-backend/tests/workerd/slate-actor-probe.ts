/**
 * The hosted Plan/execute_tools probe and the sealed-actor RPC probe, after the
 * actor cutover.
 *
 * WHAT CHANGED, so a reader of the two tests does not go looking for the old
 * shape. Before the cutover every agent kind was a Durable Object of its own:
 * `SubordinateAgent` (sealed with `SUBORDINATE_RPC_SURFACE`) and an exploration
 * twin (sealed with `EXPLORATION_RPC_SURFACE`) each answered
 * `slateBindingDispatch` with fixture data, and this file's root reached them
 * through `subAgent`. After the cutover (`f9c0b3847`) there is one sealed
 * workspace object — `OrchestratorAgent`, sealed with `ORCHESTRATOR_RPC_SURFACE`
 * — and a subordinate, a head, a node and a branch are logical actors in its
 * directory (`core/state/actor-key.ts` still names the two families), not
 * classes. A hosted actor holds no slate read model of its own
 * (`actor-agent.ts` refuses those hops with its own reason), so the only thing
 * that answers the native binding RPC is the sealed root, and that is what
 * `exercise` drives: a stub hop to a different id of the production class,
 * which crosses the wire the seal governs. The browser-callable half is read
 * off the production class's own `@callable` registry, the same oracle
 * `decorated-agent.test.ts` uses, because the probe root's own chain does not
 * carry the method and would answer vacuously.
 *
 * `code` is unchanged in shape: hosted Plan analysis reads files and keeps
 * research state, with no writes and no raw network. The one post-cutover
 * addition is `rt.actor` — `createExecuteToolsFactory` now builds the `state`
 * provider over the actor's program state, so the probe binds a fixture handle
 * over its own SQL. Only the final read model is fixture data, so no model
 * call or external service is needed.
 */
import { Agent, getAgentByName } from 'agents';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import type { JsonValue } from '@kinu.run/core';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { createExecuteToolsFactory } from '../../src/execute-tools';
import { bindAgentSql } from '../../src/runtime';
import { bindActorHandle, createDefaultWebSearchProvider, initCodemodeStateTable, toolsInWorkMode, type WorkMode } from '@kinu.run/core';
import { CodemodeEgress as ProductionEgress, codemodeEgress } from '../../src/codemode-egress';

// The owner's own Durable Object. A production root claims an owner before its
// directory exists, and the seal target below is a production root — so the
// class this worker binds has to be here, exactly as in plan-announce-probe.
export { UserDO } from '../../src/user/user-do';

// Re-exported under its production name so the auxiliary worker binds the
// class the seal actually governs — `exercise` addresses this binding, never
// a subclass, so the hop measures the shipped surface rather than a fixture.
export { OrchestratorAgent } from '../../src/orchestrator';

/** The external network boundary is deterministic; real WorkerLoader egress still selects it. */
export class CodemodeEgress extends ProductionEgress {
  override async fetch(): Promise<Response> { return new Response('network allowed'); }
}
type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];
export type SlateActorFamily = 'subordinate' | 'exploration';

export class SlateActorProbeRoot extends Agent<ProbeEnv> {
  async exercise(family: SlateActorFamily): Promise<{ answer: JsonValue; browserCallable: boolean }> {
    // A DIFFERENT id, so this is one object calling another and the dispatch
    // crosses the wire the seal governs; a same-object call would prove
    // nothing, because the seal shadows stub resolution, not in-process calls.
    // Addressed by binding, never by a retyped subclass: the binding is
    // declared over the production class, and a probe that retyped it would be
    // measuring its own fixture. The static type below goes through a plain
    // fetch pick first, because the SDK's stub mapping over the route union's
    // recursive `JsonValue` members exceeds TypeScript's instantiation depth
    // (TS2589 at the dispatch call) — the same narrowing production applies
    // for the same error (`actor-agent.ts` `getOwnerUserDO`).
    const raw: Pick<Fetcher, 'fetch'> = await getAgentByName<ProbeEnv, ProductionOrchestrator>(this.env.OrchestratorAgent, `sealed-${family}`);
    // SAFETY: the stub carries every method on the declared orchestrator RPC
    // surface plus fetch. `getAgentByName` constructed it over the
    // `OrchestratorAgent` binding, and the `Pick` rejects a name the class
    // does not declare, so the narrowed view cannot name a method the target
    // lacks.
    const target = raw as Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator, 'claimOwner' | 'slateBindingDispatch'>;
    // The positive control: the stub works, the object bootstrapped its
    // directory row, and the read model below has a handle to answer with.
    // Without it a rejection below could be a stub that never worked at all.
    await target.claimOwner('probe-owner');
    const answer = await target.slateBindingDispatch([], { kind: 'rpc', method: 'getExecutors' }, 'build');
    // The SDK's own registry reader, applied to a bare object on the real
    // production chain rather than constructed (a constructor seals, opens
    // SQLite and installs diagnostics, none of which is the premise) and
    // rather than to this root (whose chain does not carry the method and
    // would answer vacuously). `false` here is only meaningful beside the hop
    // above answering: a deleted method is also absent.
    // SAFETY: `Object.create(ProductionOrchestrator.prototype)` returns an
    // object whose prototype IS that prototype by construction, and the SDK
    // declares `getCallableMethods` to start at `Object.getPrototypeOf(this)`
    // and read its own WeakMap, so the call returns the registry answer a live
    // instance returns. That one member is all this receiver is used for.
    const browserCallable = (Object.create(ProductionOrchestrator.prototype) as Agent<never>).getCallableMethods().has('slateBindingDispatch');
    return { answer, browserCallable };
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
        actor: bindActorHandle(sql, {
          actorId: 'mode-probe', workspaceId: 'mode-probe', parentActorId: null,
          name: 'mode-probe', storageKey: 'mode-probe',
        }, () => {}),
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
