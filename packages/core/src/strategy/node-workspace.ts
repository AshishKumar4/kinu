/**
 * The ONE seam through which a swarm node gets a place to work and an identity
 * to work as — the sixth of a node's six properties, and the one that used to
 * be a promise.
 *
 * Specified by docs/EXPLORATION.md — "Isolation" and "Node identity".
 *
 * IT EXISTS NOW. A node's home is a real directory in the ONE global view,
 * owned by the node's own uid and moded `0o755`, and its commands run as that
 * uid — so the boundary is uid/gid/mode on real inodes rather than convention.
 * {@link agentHomeNodeProvisioner} is the implementation and `vfs/agent-home.ts`
 * is the layout it provisions against.
 *
 * Why permissions inside one filesystem and not a filesystem each: the
 * regression at `cf-backend/tests/unit-head-fork.test.ts:4-8` was a subagent
 * handed a freshly-created EMPTY filesystem, so an agent asked to research a
 * codebase the user had cloned could see none of it. Isolation without a read
 * window is a regression. One view with per-agent ownership cannot reproduce
 * it, because there is no second filesystem to be empty — the read window is
 * not a feature added back, it is the absence of a second tree.
 *
 * `shared-origin-plane` SURVIVES, and it is no longer a confession that the
 * substrate is missing. It is what a host without a credentialled filesystem
 * honestly is: an inline or test runner that has no uid-0 view to provision
 * with. It is still REPORTED rather than hidden, because the grading
 * consequence is real — you cannot grade a node on what it changed when every
 * node changed the same tree, so a shared-plane run is graded on the candidate
 * the node REPORTS, never on a diff of the workspace.
 *
 * A malformed credential is INVISIBLE at the substrate — Nimbus's `isVfsCred`
 * guard falls through to the session user rather than refusing — which is
 * precisely why this seam returns the type rather than a structural copy of it,
 * and why `undefined` is spelled as a value here instead of an empty object.
 */

import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  agentCred,
  agentIdentity,
  confineAgentTmp,
  provisionAgentHome,
  type HomeRootVfs,
  type TmpConfiner,
} from '../vfs/agent-home';

/**
 * Whether a node actually got a boundary.
 *
 * Two values and no third, because the honest answer today is one of exactly
 * two things and "partially isolated" is not a state anything could act on.
 */
export type NodeIsolation = 'shared-origin-plane' | 'private-home';

/** A node's own place to work, as the search hands it to the node's runtime. */
export interface NodeWorkspace {
  /** Where this node's own writes belong. The origin's own working directory
   *  under `shared-origin-plane` — i.e. no boundary, said out loud. */
  readonly home: string;
  /**
   * The identity this node's commands run as, or `undefined` for the session
   * user.
   *
   * `undefined` is the pre-substrate value and it is exactly today's behaviour:
   * the substrate's own `options.cred ?? inheritedCred` resolves it to the
   * session user, so an unprovisioned node runs precisely as the origin does
   * rather than as something new and untested.
   */
  readonly cred: VfsCred | undefined;
  readonly isolation: NodeIsolation;
}

/** Which node is asking. Identity comes from the engine's own row — a node
 *  states neither its id nor its depth, per *Node identity*, so neither is an
 *  argument a caller could get wrong. */
export interface NodeIdentity {
  readonly nodeId: string;
  readonly rootId: string;
  readonly depth: number;
}

/**
 * A backend's home provisioner: the half only a host can do, because `chown`
 * needs uid 0.
 *
 * Still a seam rather than a direct call, because the three things it needs — a
 * uid-0 view, the principal registry, and durable SQL — are all host-owned, and
 * core stays clear of how a given backend obtained them.
 */
export type NodeWorkspaceProvisioner = (node: NodeIdentity) => Promise<NodeWorkspace>;

/**
 * A node's name as an agent, and therefore its directory under `/home`.
 *
 * Prefixed rather than raw: a node id is a `nanoid`, so it may begin with `-`,
 * and `node-` supplies a safe first character while leaving the id itself
 * untouched — which keeps the mapping INJECTIVE. Two nodes must never resolve
 * to one home, so sanitising (which can map two ids together) would be a
 * correctness bug and not a cosmetic choice.
 */
export function nodeAgentName(nodeId: string): string {
  return `node-${nodeId}`;
}

/** What a host must hand over for a node to get a real home. */
export interface NodeHomeHost {
  /** The uid-0 view — `SqliteVFS.as(CRED_KERNEL)`. */
  readonly root: HomeRootVfs;
  /** The principal registry that scopes `/tmp`, i.e. the `SqliteVFS` itself. */
  readonly confiner: TmpConfiner;
  /** Durable storage for the uid allocation, so a home outlives its activation. */
  readonly sql: SqlDatabase;
}

/**
 * The real provisioner: a private home and a private `/tmp` per node.
 *
 * Synchronous underneath and `async` only to satisfy the seam — every substrate
 * call here returns `void`, which is the same fact that makes `/pc` and
 * `/sandbox` executors rather than mounts.
 */
export function agentHomeNodeProvisioner(host: NodeHomeHost): NodeWorkspaceProvisioner {
  return async (node) => {
    const name = nodeAgentName(node.nodeId);
    const identity = agentIdentity(host.sql, name);
    const home = provisionAgentHome(host.root, name, identity);
    confineAgentTmp(host.root, host.confiner, name, identity);
    return { home, cred: agentCred(identity), isolation: 'private-home' };
  };
}

/**
 * The node's workspace: from the host's provisioner when it has one, and from
 * the shared-plane fallback when the host has no credentialled filesystem.
 *
 * ONE function, so there is exactly one place a test can prove a node was told
 * the truth about its own boundary. The fallback is reached only where there is
 * no uid-0 view to provision against, and it is reported rather than disguised
 * as a home — an invented directory would be a boundary a node believes in and
 * does not have, which is worse than no boundary at all.
 */
export async function nodeWorkspace(
  node: NodeIdentity,
  provision?: NodeWorkspaceProvisioner,
): Promise<NodeWorkspace> {
  if (provision) return await provision(node);
  return { home: '.', cred: undefined, isolation: 'shared-origin-plane' };
}

/** What a node is TOLD about its own boundary, in the words its prompt uses.
 *  Stated because a node that believes it has a private home will happily write
 *  a scratch file at a path its sibling is about to overwrite. */
export function isolationDisclosure(isolation: NodeIsolation, home: string): string {
  return isolation === 'private-home'
    ? `Your own working directory is ${home}. It is yours: no other node in this search can write it.`
    : 'You share ONE file plane with every other node in this search, including the nodes running '
      + 'beside you right now. Nothing you write to it is attributable to you and a sibling may '
      + 'overwrite it at any moment, so treat the workspace as read-mostly: your answer is what is '
      + 'graded, not the state you leave behind.';
}
