/**
 * The seam through which a swarm node gets a place to work and an identity to
 * work as. Spec: docs/EXPLORATION.md "Isolation" and "Node identity".
 * The backend keys provisioning on the node actor's storage key, never a raw node id.
 * A shared-plane run is graded on the candidate the node reports, never on a workspace diff.
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

/** Whether a node actually got a boundary. */
export type NodeIsolation = 'shared-origin-plane' | 'private-home';

/**
 * A node's own place to work. A union, not optionals: a provisioned node has
 * home, tmp and cred together; reading `home` while ignoring `cred` must be impossible.
 */
export type NodeWorkspace =
  | {
    readonly isolation: 'private-home';
    readonly home: string;
    /** Scratch, `0o700`; `TMPDIR` points here. */
    readonly tmp: string;
    /** Both the node's commands and its file tools act as this identity. */
    readonly cred: VfsCred;
  }
  | {
    readonly isolation: 'shared-origin-plane';
    /** The origin's own working directory: no boundary. */
    readonly home: string;
    readonly tmp: undefined;
    /** The session user: an unprovisioned node runs exactly as the origin does. */
    readonly cred: undefined;
  };

/** Identity comes from the engine's own row; a node states neither its id nor its depth. */
export interface NodeIdentity {
  readonly nodeId: string;
  readonly rootId: string;
  readonly depth: number;
}

/** A backend's home provisioner; host-only because `chown` needs uid 0. */
export type NodeWorkspaceProvisioner = (node: NodeIdentity) => Promise<NodeWorkspace>;

export interface NodeHomeHost {
  /** The uid-0 view — `SqliteVFS.as(CRED_KERNEL)`. */
  readonly root: HomeRootVfs;
  /** The principal registry that scopes `/tmp`. */
  readonly confiner: TmpConfiner;
  /** Durable uid allocation, so a home outlives its activation. */
  readonly sql: SqlDatabase;
}

/**
 * The real provisioner for every facet kind: a private home and private `/tmp`
 * per agent name. The caller names the agent with its kind's function
 * (`subordinateAgentName`, `headAgentName`) so namespaces stay disjoint.
 */
export function facetHomeProvisioner(
  host: NodeHomeHost | Promise<NodeHomeHost>,
  authorize?: () => void,
): (agentName: string) => Promise<NodeWorkspace> {
  return async (agentName) => {
    const { root, confiner, sql } = await host;
    authorize?.();
    const identity = agentIdentity(sql, agentName);
    const home = provisionAgentHome(root, agentName, identity);
    // Also rewrite bare `/tmp`, so a command that hardcodes `/tmp/x` stays private.
    const tmp = confineAgentTmp(confiner, agentName, identity);

    return { home, tmp, cred: agentCred(identity), isolation: 'private-home' };
  };
}

/** The real releaser: home and tmp removed, `/tmp` rewrite dropped, uid row kept. */
export function facetHomeReleaser(
  host: NodeHomeHost | Promise<NodeHomeHost>,
): (agentName: string) => Promise<void> {
  return async (agentName) => {
    const { root, confiner, sql } = await host;
    releaseAgentHome(root, confiner, sql, agentName);
  };
}

/**
 * The node's workspace: from the host's provisioner, else the shared-plane
 * fallback, which is reported rather than disguised as a home.
 */
export async function nodeWorkspace(
  node: NodeIdentity,
  provision?: NodeWorkspaceProvisioner,
): Promise<NodeWorkspace> {
  if (provision) return await provision(node);

  return { home: '.', tmp: undefined, cred: undefined, isolation: 'shared-origin-plane' };
}

/** What a node is told about its own boundary, in its prompt's words. */
export function isolationDisclosure(isolation: NodeIsolation, home: string): string {
  return isolation === 'private-home'
    ? `Your own working directory is ${home}. It is yours: no other node in this search can write it.`
    : 'You share ONE file plane with every other node in this search, including the nodes running '
      + 'beside you right now. Nothing you write to it is attributable to you and a sibling may '
      + 'overwrite it at any moment, so treat the workspace as read-mostly: your answer is what is '
      + 'graded, not the state you leave behind.';
}
