import { DefaultExecutionRouter, createInlineExecutor, observeWrites, withApprovalGatedShell, withMountTable, standardMounts } from '@kinu.run/core';
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

/** Readdress the file plane without copying the parent's live model getters. */
export function localNodeRuntime(deps: LocalNodeRuntimeDeps): (node: NodeWorkspace, actor: ActorHandle, source: AgentRuntime, observer?: WriteObserver) => Promise<AgentRuntime> {
  return async (node, actor, origin, observer) => {
    requireLocalActorWorkspace(deps.origin.actor, actor);
    requireLocalActorWorkspace(deps.origin.actor, origin.actor);
    let vfs = origin.storage.vfs;
    let shell = origin.shell;
    let router = origin.executionRouter;
    if (node.isolation === 'private-home') {
      const plane = await deps.workspace.asAgent({ cred: node.cred, home: node.home, tmp: node.tmp });
      requireLocalActorWorkspace(origin.actor, actor);
      shell = withApprovalGatedShell(plane.shell, deps.approvalPolicy);
      const ownRouter = new DefaultExecutionRouter(deps.approvalPolicy);
      const files = observer ? observeWrites(plane.vfs, observer) : plane.vfs;
      vfs = withMountTable(files, standardMounts((name) => ownRouter.getProvider(name)));
      ownRouter.register(createInlineExecutor({ ...deps.inline, sql: origin.storage.sql, memory: origin.memory, craftStore: origin.craftStore, vfs, shell }));
      for (const info of origin.executionRouter?.listExecutors() ?? []) {
        if (info.name === 'workspace') continue;
        const provider = origin.executionRouter?.getProvider(info.name);
        if (provider) ownRouter.register(provider);
      }
      if (deps.laptop && !ownRouter.getProvider(deps.laptop.name)) ownRouter.register(deps.laptop);
      router = ownRouter;
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
