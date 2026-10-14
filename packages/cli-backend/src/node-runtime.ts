import {
  actorReferenceOf, actorScaffoldPath, bindLocalActorReference, createScaffoldSurface, DefaultExecutionRouter,
  requireLocalActorWorkspace,
} from '@kinu.run/core';
import type { ActorHandle, AgentRuntime, AgentStores } from '@kinu.run/core';
import { actorFilePlane } from './actor-plane';
import { hostWorkspaceExecutor } from './host-toolchain';
import type { CLIRuntime } from './runtime';

/**
 * A swarm node's runtime beside `source`'s, without copying its live model getters. The node shares the workspace SQL
 * as its own actor and works in the same folder and space over a plane of its own, whose `/context` is its own: its
 * file tool and its programs read the same one. Its gates are the source's: a hire's own narrowing, never the
 * workspace owner's.
 */
export function localNodeRuntime(source: CLIRuntime, actor: ActorHandle, stores: AgentStores): AgentRuntime {
  requireLocalActorWorkspace(source.actor, actor);
  const binding = bindLocalActorReference(source.actor, actorReferenceOf(actor));

  // Its own stores, as its host bound it: a node reading the parent's claim ledger would present the parent's turns as
  // its own history.
  const { plane, toolFiles } = actorFilePlane({ source, actor, stores });
  let ledger: Parameters<NonNullable<AgentRuntime['setTurnFileLedgerProvider']>>[0] = null;

  // The machine and its gates are the source's.
  const executionRouter = new DefaultExecutionRouter(source.approvalPolicy);

  executionRouter.register(hostWorkspaceExecutor({
    vfs: toolFiles, files: plane, home: source.storage.home, planes: source.planes, memory: source.memory, craftStore: source.craftStore,
    shell: source.shell, sql: source.storage.sql, actor, ledger: () => ledger?.(),
  }));

  return {
    actor,
    storage: { ...source.storage, vfs: plane },
    agentStateVfs: source.agentStateVfs,
    toolFiles,
    planes: source.planes,
    memory: source.memory,
    executor: source.executor,
    llm: source.llm,
    schedule: source.schedule,
    identity: { id: actor.actorId, name: actor.name,
      scaffold: createScaffoldSurface({ actor, sql: source.storage.sql, vfs: source.agentStateVfs ?? source.storage.vfs,
        path: actorScaffoldPath(binding) }) },
    craftStore: source.craftStore,
    get judgeModel() { return source.judgeModel; },
    get fastLlm() { return source.fastLlm; },
    executionRouter,
    shell: source.shell,
    checkpoints: source.checkpoints,
    setShellApprovalChannel: source.setShellApprovalChannel,
    setTurnFileLedgerProvider: (provider) => { ledger = provider; },
  };
}
