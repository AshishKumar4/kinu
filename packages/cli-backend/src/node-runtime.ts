import { DefaultExecutionRouter, createAgentStores, contextMount, createInlineExecutor, observeWrites, withApprovalGatedShell, withMountTable, standardMounts } from '@kinu.run/core';
import type { ActorHandle, AgentRuntime, ExecutorProvider, NodeWorkspace, ShellApprovalPolicy, WriteObserver } from '@kinu.run/core';
import type { WorkspaceBundle } from '@kinu.run/core/workspace';
import type { CLIRuntime } from './runtime';
import { requireLocalActorWorkspace } from './actor-identity';

export interface LocalNodeRuntimeDeps {
  readonly workspace: WorkspaceBundle;
  readonly origin: CLIRuntime;
  readonly approvalPolicy: ShellApprovalPolicy;
  readonly inline: Parameters<typeof createInlineExecutor>[0];
  readonly laptop: ExecutorProvider | null;
}

/**
 * Readdress the file plane without copying the parent's live model getters.
 *
 * ONE DATABASE, and the node is a logical actor in it: `origin.storage.sql` is
 * the node's SQL too, so its claims, journal steps and program state are its
 * own actor-keyed rows in the workspace's one store. What is genuinely the
 * node's own is its HOME (uid-confined where the plane has a principal
 * registry), its execution router, and — through the mount below — its own
 * `/context`.
 */
export function localNodeRuntime(deps: LocalNodeRuntimeDeps): (node: NodeWorkspace, actor: ActorHandle, source: AgentRuntime, observer?: WriteObserver) => Promise<AgentRuntime> {
  return async (node, actor, origin, observer) => {
    requireLocalActorWorkspace(deps.origin.actor, actor);
    requireLocalActorWorkspace(deps.origin.actor, origin.actor);
    // THIS node's stores, over the shared SQL. A node reading the parent's
    // claim ledger would present the parent's turns as its own working
    // history, which is the one thing `/context` must never do.
    const stores = createAgentStores(() => origin.storage.sql, () => actor, origin.storage.transactionSync);

    const ownContext = contextMount({
      stores: () => ({ actorId: actor.actorId, claims: stores.claims, events: stores.eventRecorder }),
    });

    let vfs = origin.storage.vfs;
    let shell = origin.shell;
    let router = origin.executionRouter;

    if (node.isolation === 'private-home') {
      const plane = await deps.workspace.asAgent({ cred: node.cred, home: node.home, tmp: node.tmp });
      requireLocalActorWorkspace(origin.actor, actor);
      shell = withApprovalGatedShell(plane.shell, deps.approvalPolicy);
      const ownRouter = new DefaultExecutionRouter(deps.approvalPolicy);
      const files = observer ? observeWrites(plane.vfs, observer) : plane.vfs;
      vfs = withMountTable(files, [...standardMounts((name) => ownRouter.getProvider(name)), ownContext]);
      ownRouter.register(createInlineExecutor({ ...deps.inline, sql: origin.storage.sql, memory: origin.memory, craftStore: origin.craftStore, vfs, shell }));

      for (const info of origin.executionRouter?.listExecutors() ?? []) {
        if (info.name === 'workspace') continue;
        const provider = origin.executionRouter?.getProvider(info.name);

        if (provider) ownRouter.register(provider);
      }

      if (deps.laptop && !ownRouter.getProvider(deps.laptop.name)) ownRouter.register(deps.laptop);
      router = ownRouter;
    } else {
      // Sharing the origin's plane still means NOT sharing its context. The
      // origin's table already resolves `/pc` and `/sandbox`; this one layer
      // re-answers `/context` as the node's and delegates everything else,
      // rather than re-declaring a table the node has no different answer for.
      vfs = withMountTable(vfs, [ownContext]);
    }

    return {
      actor,
      storage: { ...origin.storage, vfs },
      agentStateVfs: origin.agentStateVfs,
      memory: origin.memory,
      executor: origin.executor,
      llm: origin.llm,
      schedule: origin.schedule,
      identity: { id: actor.actorId, name: actor.name, scaffold: origin.identity.scaffold },
      craftStore: origin.craftStore,
      get judgeModel() { return origin.judgeModel; },
      get fastLlm() { return origin.fastLlm; },
      get advisorLlm() { return origin.advisorLlm; },
      spawnBranch: origin.spawnBranch,
      abortBranch: origin.abortBranch,
      executionRouter: router,
      shell,
      checkpoints: origin.checkpoints,
      setShellApprovalChannel: origin.setShellApprovalChannel,
      setTurnFileLedgerProvider: origin.setTurnFileLedgerProvider,
    };
  };
}
