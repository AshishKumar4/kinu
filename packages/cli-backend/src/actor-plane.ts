/**
 * A local actor's file plane: the workspace's folder and space, its skills, and the actor's own `/context`. A head and a
 * swarm node each work over their own, built here as the root builds its: their file tool and their programs reach it.
 */
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import {
  contextMount, localContextTree, skillsMount, withApprovalGatedFiles,
  type ActorHandle, type AgentStores, type ContextTree, type WriteObserver,
} from '@kinu.run/core';
import { localFilePlane, localFileReach, type LocalPlane } from './host-mount';
import type { CLIRuntime } from './runtime';

/** The actor's own working history, as its `/context` shows it. */
export function ownContextTree(actor: ActorHandle, stores: AgentStores): () => ContextTree {
  const tree = localContextTree(() => ({ claims: stores.claims, events: stores.eventRecorder }), { author: actor.actorId, child: false });

  return () => tree;
}

/** An actor's plane, and the same plane as its tools reach it, gated. */
interface ActorFilePlane {
  readonly plane: LocalPlane;
  readonly toolFiles: VFS;
}

/** `actor`'s plane over `source`'s folder and space, its tools gated by `source`'s policy: a hire's narrowing stays. */
export function actorFilePlane(input: {
  readonly source: Pick<CLIRuntime, 'cwd' | 'space' | 'ownFiles' | 'checkpoints' | 'planes' | 'approvalPolicy'>;
  readonly actor: ActorHandle;
  readonly stores: AgentStores;
  /** Hears the plane's writes, for a head whose split names the files it changed. */
  readonly observer?: WriteObserver;
}): ActorFilePlane {
  const { source, actor, stores, observer } = input;
  const { cwd: folder, space, ownFiles, checkpoints } = source;

  const plane = localFilePlane({
    folder, space, checkpoints,
    views: [skillsMount((): VFS => ownFiles), contextMount({ actorId: actor.actorId, own: ownContextTree(actor, stores) })],
    ...(observer !== undefined && { observer }),
  });

  return { plane, toolFiles: withApprovalGatedFiles(plane, 'workspace', localFileReach({ folder, space }, source.planes, plane), source.approvalPolicy) };
}
