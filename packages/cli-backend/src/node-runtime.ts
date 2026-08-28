/**
 * This workspace, addressed as one swarm node.
 *
 * A node's home is uid/gid/mode on real inodes in the ONE local filesystem, so
 * it means nothing until the primitives the node's loop actually uses act as
 * that uid — BOTH of them. Its commands go through a shell credentialed as the
 * node; its file tools go through a plane credentialed the same way. Credential
 * one and not the other and the node either cannot write its own home or leaves
 * files a sibling can overwrite.
 *
 * Here rather than inside `createCLIRuntime` because it is a second runtime over
 * one workspace, and that is a whole idea rather than a clause of the factory's.
 */

import {
  DefaultExecutionRouter, createInlineExecutor, withApprovalGatedShell,
  withMountTable, standardMounts,
} from '@kinu.run/core';
import type {
  AgentRuntime, ExecutorProvider, NodeWorkspace, ShellApprovalPolicy,
} from '@kinu.run/core';
import type { WorkspaceBundle } from '@kinu.run/core/workspace';
import type { CLIRuntime } from './runtime';

export interface LocalNodeRuntimeDeps {
  /** The one filesystem, which hands over a credentialed plane per node. */
  readonly workspace: WorkspaceBundle;
  /** The ORIGIN's runtime. A node's is this one, re-addressed. */
  readonly origin: CLIRuntime;
  readonly approvalPolicy: ShellApprovalPolicy;
  /** The origin's inline-executor construction, reused so a node's executor
   *  differs in its plane and in nothing else. */
  readonly inline: Parameters<typeof createInlineExecutor>[0];
  /** The host-filesystem executor, shared rather than rebuilt: the host
   *  filesystem is the host filesystem whoever asks, and a second construction
   *  would be a second set of checkpoints over one directory. */
  readonly laptop: ExecutorProvider | null;
}

export function localNodeRuntime(
  deps: LocalNodeRuntimeDeps,
): (node: NodeWorkspace) => Promise<AgentRuntime> {
  return async (node) => {
    // A node with no credential has nothing to re-address. It reports the shared
    // plane, and running it on the origin's runtime is exactly what that means.
    if (node.isolation !== 'private-home') return deps.origin;
    const plane = await deps.workspace.asAgent({
      cred: node.cred, home: node.home, tmp: node.tmp,
    });
    const shell = withApprovalGatedShell(plane.shell, deps.approvalPolicy);
    // A router of its own, because the inline executor HOLDS the plane it writes
    // through: reusing the origin's would run this node's `file` and `run` as the
    // origin while its shell ran as itself.
    const router = new DefaultExecutionRouter(deps.approvalPolicy);
    const vfs = withMountTable(plane.vfs, standardMounts((name) => router.getProvider(name)));
    router.register(createInlineExecutor({ ...deps.inline, vfs, shell }));
    if (deps.laptop) router.register(deps.laptop);
    // DELEGATION, never a spread: `buildRuntime` returns accessors for the routed
    // model lanes, and copying them would freeze this node's judge and fast lanes
    // at whatever they were when it started.
    // SAFETY: `Object.create(deps.origin)` returns an object whose PROTOTYPE is
    // `deps.origin`, a CLIRuntime, so every member of that interface resolves
    // through the prototype chain — which is the delegation this node wants. The
    // assertion states what the prototype already guarantees; the assign below
    // then overrides exactly the three members this node owns.
    return Object.assign(Object.create(deps.origin) as CLIRuntime, {
      storage: { ...deps.origin.storage, vfs },
      shell,
      executionRouter: router,
    });
  };
}
