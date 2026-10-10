import { actorReferenceOf, actorScaffoldPath, bindLocalActorReference, createAgentStores, createScaffoldSurface, contextMount, localContextTree, withMountTable, requireLocalActorWorkspace } from '@kinu.run/core';
import type { ActorHandle, AgentRuntime } from '@kinu.run/core';
import type { CLIRuntime, NodeSource } from './runtime';
import { join } from 'node:path';

/**
 * A swarm node's runtime over `source`'s plane, without copying its live model getters. The node shares the
 * workspace SQL as its own actor and works in the same folder and own space; its `/context` is its own.
 * Its gates are the source's: a hire's own narrowing, never the workspace owner's.
 */
export function localNodeRuntime(owner: CLIRuntime, actor: ActorHandle, source: NodeSource): AgentRuntime {
  requireLocalActorWorkspace(owner.actor, actor);
  requireLocalActorWorkspace(owner.actor, source.actor);
  const binding = bindLocalActorReference(owner.actor, actorReferenceOf(actor));

  // A node reading the parent's claim ledger would present the parent's turns as its own history.
  const stores = createAgentStores(() => source.storage.sql, () => actor, (write) => source.storage.transactionSync(write), () => owner.filesForActor(actor));

  const ownContext = contextMount({
    actorId: actor.actorId,
    own: () => localContextTree(() => ({ claims: stores.claims, events: stores.eventRecorder }), { author: actor.actorId, child: false }),
  });

  // Over the source's plane, at the point `vfs://context` names in the workspace's space.
  const context = { ...ownContext, at: join(owner.space, ownContext.name) };

  return {
    actor,
    storage: { ...source.storage, vfs: withMountTable(source.storage.vfs, [context]) },
    agentStateVfs: source.agentStateVfs,
    toolFiles: withMountTable(source.toolFiles, [context]),
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
    executionRouter: source.executionRouter,
    shell: source.shell,
    checkpoints: source.checkpoints,
    setShellApprovalChannel: source.setShellApprovalChannel,
    setTurnFileLedgerProvider: source.setTurnFileLedgerProvider,
  };
}
