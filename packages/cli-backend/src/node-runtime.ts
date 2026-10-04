import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { DefaultExecutionRouter, agentArtifactDirectory, createAgentStores, contextMount, localContextTree, createInlineExecutor, createShellSession, observeWrites, skillsMount, withApprovalGatedFiles, withApprovalGatedShell, withMountTable, sharedDriveMount, SHARED_DRIVE_UNBOUND } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { ActorHandle, AgentRuntime, NodeWorkspace, WriteObserver } from '@kinu.run/core';
import type { WorkspaceBundle } from '@kinu.run/core/workspace';
import type { CLIRuntime, NodeSource } from './runtime';
import { requireLocalActorWorkspace } from '@kinu.run/core';

export interface LocalNodeRuntimeDeps {
  readonly workspace: WorkspaceBundle;
  readonly origin: CLIRuntime;
  readonly inline: Parameters<typeof createInlineExecutor>[0];
}

/**
 * Readdress the file plane without copying the parent's live model getters. The
 * node shares the workspace SQL as its own actor; its home, router, and `/context` are its own.
 * Its gates answer to the source's policy: a hire's own narrowing, never the workspace owner's.
 */
export function localNodeRuntime(deps: LocalNodeRuntimeDeps): (node: NodeWorkspace, actor: ActorHandle, source: NodeSource, observer?: WriteObserver) => Promise<AgentRuntime> {
  return async (node, actor, origin, observer) => {
    requireLocalActorWorkspace(deps.origin.actor, actor);
    requireLocalActorWorkspace(deps.origin.actor, origin.actor);

    // A node reading the parent's claim ledger would present the parent's turns as its own history.
    const stores = createAgentStores(() => origin.storage.sql, () => actor, (write) => origin.storage.transactionSync(write), async () => {
      if (node.isolation === 'private-home') return { vfs, artifactDirectory: agentArtifactDirectory(node.home) };

      if (!deps.origin.filesForActor) throw new KinuError('missing', 'workspace has no actor file-plane resolver');

      return deps.origin.filesForActor(actor);
    });

    const ownContext = contextMount({
      actorId: actor.actorId,
      own: () => localContextTree(() => ({ claims: stores.claims, events: stores.eventRecorder }), { author: actor.actorId, child: false }),
    });

    let vfs = origin.storage.vfs;
    let toolFiles = origin.toolFiles;
    let shell = origin.shell;
    let router = origin.executionRouter;
    let release: (() => void) | undefined;

    if (node.isolation === 'private-home') {
      const plane = await deps.workspace.asAgent({ cred: node.cred, home: node.home, tmp: node.tmp });

      // A private home is a plane of the in-SQLite workspace, never the user's directory.
      const shellSession = createShellSession({
        home: node.home, userRoots: () => mounted.userRoots(), stored: async (name) => await plane.shell.cwd?.(name) ?? null,
      });

      shell = withApprovalGatedShell(plane.shell, { filesOwner: 'agent', shellSession }, origin.approvalPolicy);
      const ownRouter = new DefaultExecutionRouter(origin.approvalPolicy);
      const files = observer ? observeWrites(plane.vfs, observer) : plane.vfs;

      const mounted = withMountTable(files, [
        sharedDriveMount(() => null, () => SHARED_DRIVE_UNBOUND),
        skillsMount((): VFS => vfs),
        ownContext,
      ]);

      release = deps.workspace.mountTable(mounted, node.cred);
      vfs = mounted;
      toolFiles = withApprovalGatedFiles(mounted, 'workspace', { userRoots: () => mounted.userRoots(), locate: null, parksWrites: false }, origin.approvalPolicy);
      ownRouter.register(createInlineExecutor({ ...deps.inline, sql: origin.storage.sql, memory: origin.memory, craftStore: origin.craftStore, vfs: toolFiles, files: mounted, home: node.home, shell, filesOwner: 'agent' }));

      for (const info of origin.executionRouter?.listExecutors() ?? []) {
        if (info.name === 'workspace') continue;
        const provider = origin.executionRouter?.getProvider(info.name);

        if (provider) ownRouter.register(provider);
      }

      router = ownRouter;
    } else {
      // Share the origin's plane but re-answer `/context` as the node's.
      vfs = withMountTable(vfs, [ownContext]);
      toolFiles = withMountTable(toolFiles, [ownContext]);
    }

    return {
      actor,
      storage: { ...origin.storage, vfs, home: node.isolation === 'private-home' ? node.home : origin.storage.home },
      agentStateVfs: origin.agentStateVfs,
      toolFiles,
      workspaceIsMachine: origin.workspaceIsMachine,
      memory: origin.memory,
      executor: origin.executor,
      llm: origin.llm,
      schedule: origin.schedule,
      identity: { id: actor.actorId, name: actor.name, scaffold: origin.identity.scaffold },
      craftStore: origin.craftStore,
      get judgeModel() { return origin.judgeModel; },
      get fastLlm() { return origin.fastLlm; },
      executionRouter: router,
      shell,
      nodeIsolated: origin.nodeIsolated,
      checkpoints: origin.checkpoints,
      setShellApprovalChannel: origin.setShellApprovalChannel,
      setTurnFileLedgerProvider: origin.setTurnFileLedgerProvider,
      ...(release !== undefined && { release }),
    };
  };
}
