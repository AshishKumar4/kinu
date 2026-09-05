/**
 * The ONE seam through which a swarm node gets a place to work and an identity
 * to work as — the sixth of a node's six properties, and the one that used to
 * be a promise.
 *
 * Specified by docs/EXPLORATION.md — "Isolation" and "Node identity".
 *
 * IT EXISTS ON BOTH BACKENDS NOW. A node's home is a real directory in the ONE
 * global view, owned by the node's own uid and moded `0o755`, its scratch is
 * `/tmp/node-<id>` at `0o700`, and BOTH the way a node runs commands and the
 * way its file tools read and write are credentialed as that uid — so the
 * boundary is uid/gid/mode on real inodes rather than convention, and it holds
 * whichever way a node reaches the tree. {@link agentHomeNodeProvisioner} is
 * the implementation and `vfs/agent-home.ts` is the layout it provisions
 * against.
 *
 * Why permissions inside one filesystem and not a filesystem each: the
 * regression at `cf-backend/tests/unit-head-fork.test.ts:4-8` was a subagent
 * handed a freshly-created EMPTY filesystem, so an agent asked to research a
 * codebase the user had cloned could see none of it. Isolation without a read
 * window is a regression. One view with per-agent ownership cannot reproduce
 * it, because there is no second filesystem to be empty — the read window is
 * not a feature added back, it is the absence of a second tree.
 *
 * WHY BOTH PLANES, and what it cost. A file plane pinned to the session user
 * refuses a node's writes INSIDE ITS OWN HOME — measured `EACCES` on
 * `/home/node-aX9` — because the home belongs to the node and the plane did
 * not. One tree reached by two identities was the bug. In this isolate the
 * credentialed plane is `SqliteVFS.as(cred)` and the credentialed shell is a
 * second `Shell` over the SAME filesystem (`vfs/nimbus-workspace.ts`
 * `asAgent`). On a remote Nimbus session the file RPCs are pid-less and carry
 * no credential at all, so there the plane is the session's own coreutils run
 * as the node (`execution/nimbus-agent-files.ts`) — same session, same bytes,
 * one identity.
 *
 * `shared-origin-plane` SURVIVES, and it is neither a confession nor the hosted
 * backend's state any more. It is what a runtime with no provisioner honestly
 * is: a harness runtime, or a head runtime built without a workspace host. The
 * value is REPORTED rather than hidden, because the grading consequence is real
 * — you cannot grade a node on what it changed when every node changed the same
 * tree, so a shared-plane run is graded on the candidate the node REPORTS,
 * never on a diff of the workspace.
 *
 * A malformed credential is INVISIBLE at the substrate — Nimbus's `isVfsCred`
 * guard falls through to the session user rather than refusing — which is
 * precisely why this seam returns the substrate's own type rather than a
 * structural copy of it, and why the shared plane spells its absence as a
 * VARIANT rather than as three optional fields a caller could half-read.
 */

import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  agentCred,
  agentIdentity,
  confineAgentTmp,
  provisionAgentHome,
  releaseAgentHome,
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

/**
 * A node's own place to work, as the search hands it to the node's runtime.
 *
 * A UNION rather than one shape with optional members, because the two states
 * are not the same object with holes in it: a provisioned node has a home, a
 * scratch directory AND an identity, and an unprovisioned one has none of the
 * three. Spelling that as three optionals let a caller read `home` while
 * ignoring `cred` — which is how a node ends up addressed as private and
 * running as the origin.
 */
export type NodeWorkspace =
  | {
    readonly isolation: 'private-home';
    /** Where this node's own writes belong, owned by {@link cred}'s uid. */
    readonly home: string;
    /** This node's scratch, `0o700` and its own — where `TMPDIR` points. */
    readonly tmp: string;
    /** The identity this node's commands AND its file tools act as. Both, or
     *  the boundary holds on one plane and not the other. */
    readonly cred: VfsCred;
  }
  | {
    readonly isolation: 'shared-origin-plane';
    /** The origin's own working directory — i.e. no boundary, said out loud. */
    readonly home: string;
    readonly tmp: undefined;
    /**
     * The session user, as the substrate already resolves it: its own
     * `options.cred ?? inheritedCred` falls through to the session identity, so
     * an unprovisioned node runs precisely as the origin does rather than as
     * something new and untested.
     */
    readonly cred: undefined;
  };

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
 * The real provisioner for any facet kind: a private home and a private `/tmp`
 * per agent name, in this isolate.
 *
 * One function for subordinates, heads and swarm nodes, because the boundary
 * is one thing — uid/gid/mode on real inodes plus a confined `/tmp` — and a
 * second implementation per kind is how two backends started disagreeing
 * about the same directory. The caller names the agent with its kind's
 * function (`nodeAgentName`, `subordinateAgentName`, `headAgentName`), so
 * the namespace stays disjoint by construction.
 *
 * Synchronous underneath and `async` only to satisfy the seam — every substrate
 * call here returns `void`. The host may arrive as a promise, because a
 * filesystem that lives in this isolate BOOTS: a caller that had to resolve
 * the three members up front would either serialise its own startup on that
 * boot or wire nothing. Awaited per agent and therefore resolved once, exactly
 * as `createWorkspace`'s own `booting` is — and `await` on a plain host is a
 * no-op, so a host that already has all three passes one.
 */
export function facetHomeProvisioner(
  host: NodeHomeHost | Promise<NodeHomeHost>,
): (agentName: string) => Promise<NodeWorkspace> {
  return async (agentName) => {
    const { root, confiner, sql } = await host;
    const identity = agentIdentity(sql, agentName);
    const home = provisionAgentHome(root, agentName, identity);
    // The bare `/tmp` rewrite as well as the directory, because a command that
    // hardcodes `/tmp/x` is a command this isolate can still keep private.
    const tmp = confineAgentTmp(confiner, agentName, identity);
    return { home, tmp, cred: agentCred(identity), isolation: 'private-home' };
  };
}

/**
 * The real releaser, over the same three members: the home and the tmp gone,
 * the `/tmp` rewrite dropped, the uid row kept. One function for every facet
 * kind for the provisioner's reason, and the caller names the agent the same
 * way it did at provision.
 */
export function facetHomeReleaser(
  host: NodeHomeHost | Promise<NodeHomeHost>,
): (agentName: string) => Promise<void> {
  return async (agentName) => {
    const { root, confiner, sql } = await host;
    releaseAgentHome(root, confiner, sql, agentName);
  };
}

/**
 * The real provisioner: a private home and a private `/tmp` per node, in this
 * isolate.
 *
 * A node's name over {@link facetHomeProvisioner}, which owns the whole of
 * what provisioning means; this stays the seam a search hands its host to.
 */
export function agentHomeNodeProvisioner(
  host: NodeHomeHost | Promise<NodeHomeHost>,
): NodeWorkspaceProvisioner {
  const provision = facetHomeProvisioner(host);
  return async (node) => provision(nodeAgentName(node.nodeId));
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
  return { home: '.', tmp: undefined, cred: undefined, isolation: 'shared-origin-plane' };
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
