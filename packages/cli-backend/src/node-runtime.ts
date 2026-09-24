import { DefaultExecutionRouter, agentArtifactDirectory, createAgentStores, contextMount, createInlineExecutor, observeWrites, skillsMount, withApprovalGatedShell, withMountTable, standardMounts, sharedDriveMount, SHARED_DRIVE_UNBOUND } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { ActorHandle, AgentRuntime, NodeWorkspace, ShellApprovalPolicy, VFS, WriteObserver } from '@kinu.run/core';
import type { WorkspaceBundle } from '@kinu.run/core/workspace';
import type { CLIRuntime } from './runtime';
import { requireLocalActorWorkspace } from './actor-identity';

export interface LocalNodeRuntimeDeps {
  readonly workspace: WorkspaceBundle;
  readonly origin: CLIRuntime;
  readonly approvalPolicy: ShellApprovalPolicy;
  readonly inline: Parameters<typeof createInlineExecutor>[0];
}

/**
 * Readdress the file plane without copying the parent's live model getters. The
 * node shares the workspace SQL as its own actor; its home, router, and `/context` are its own.
 */
export function localNodeRuntime(deps: LocalNodeRuntimeDeps): (node: NodeWorkspace, actor: ActorHandle, source: AgentRuntime, observer?: WriteObserver) => Promise<AgentRuntime> {
  return async (node, actor, origin, observer) => {
    requireLocalActorWorkspace(deps.origin.actor, actor);
    requireLocalActorWorkspace(deps.origin.actor, origin.actor);

    // A node reading the parent's claim ledger would present the parent's turns as its own history.
    const stores = createAgentStores(() => origin.storage.sql, () => actor, (write) => origin.storage.transactionSync(write), async () => {
      requireLocalActorWorkspace(origin.actor, actor);

      if (node.isolation === 'private-home') return { vfs, artifactDirectory: agentArtifactDirectory(node.home) };

      if (!deps.origin.filesForActor) throw new KinuError('missing', 'workspace has no actor file-plane resolver');

      return deps.origin.filesForActor(actor);
    });

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

      const mounted = withMountTable(files, [
        ...standardMounts((name) => ownRouter.getProvider(name)),
        sharedDriveMount(() => null, () => SHARED_DRIVE_UNBOUND),
        skillsMount((): VFS => vfs),
        ownContext,
      ]);

      deps.workspace.mountTable(mounted, node.cred);
      vfs = mounted;
      ownRouter.register(createInlineExecutor({ ...deps.inline, sql: origin.storage.sql, memory: origin.memory, craftStore: origin.craftStore, vfs, shell }));

      for (const info of origin.executionRouter?.listExecutors() ?? []) {
        if (info.name === 'workspace') continue;
        const provider = origin.executionRouter?.getProvider(info.name);

        if (provider) ownRouter.register(provider);
      }

      router = ownRouter;
    } else {
      // Share the origin's plane but re-answer `/context` as the node's.
      vfs = withMountTable(vfs, [ownContext]);
    }

    return {
      actor,
      storage: { ...origin.storage, vfs },
      agentStateVfs: origin.agentStateVfs,
      workspaceIsMachine: origin.workspaceIsMachine,
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
