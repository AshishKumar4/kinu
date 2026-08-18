/**
 * The ONE seam through which a swarm node gets a place to work and an identity to
 * work as — EXPLORATION-SPEC §8.6, and the sixth of §8.1's six properties of a
 * node: *"its own workspace. §8.6, and it is the one of the six that does not
 * exist yet."*
 *
 * IT DOES NOT EXIST YET, AND THIS FILE IS WHERE THAT SHOWS. A node is an agent
 * with a shell (§8.1 rule 1-2), and until the substrate lands every node in a
 * search shares the origin's file plane. That is not a defect this module hides;
 * it is the state {@link NodeWorkspace.isolation} REPORTS, so nothing downstream
 * can assume a boundary it does not have. The grading consequence is the one
 * `tools/registry.ts` used to state as doctrine: you cannot grade a node on what
 * it changed when every node changed the same tree. So a shared-plane run is
 * graded on the candidate the node REPORTS, never on a diff of the workspace.
 *
 * WHAT THE REAL IMPLEMENTATION IS, named rather than described, so the swap is
 * one line and not a redesign. `@nimbus-sh` now threads a per-call credential:
 * `NimbusExecOptions.cred` on the SDK handle (`box.exec(cmd, { cred })`) and
 * `ProgrammaticExecOptions.cred` on the worker twin, both typed {@link VfsCred}.
 * A backend that provisions homes therefore does, host-side and in this order —
 * `vfs.as(CRED_KERNEL).mkdir(home, { recursive: true })`, `chown(home, uid, gid)`,
 * `chmod(home, 0o700)` — because per-agent `chown` is uid-0-only, so a node
 * cannot create its own home. Then it wires {@link NodeWorkspaceProvisioner} and
 * every node here becomes `private-home` with no change to the search.
 *
 * A malformed credential is INVISIBLE at the substrate — Nimbus's `isVfsCred`
 * guard falls through to the session user rather than refusing — which is
 * precisely why this seam returns the type rather than a structural copy of it,
 * and why `undefined` is spelled as a value here instead of an empty object.
 */

import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';

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
 *  states neither its id nor its depth (§8.3), so neither is an argument a
 *  caller could get wrong. */
export interface NodeIdentity {
  readonly nodeId: string;
  readonly rootId: string;
  readonly depth: number;
}

/**
 * A backend's home provisioner: the half of §8.6 that only a host can do,
 * because `chown` needs uid 0.
 *
 * Absent is the default and it is honest rather than convenient — see this
 * module's header.
 */
export type NodeWorkspaceProvisioner = (node: NodeIdentity) => Promise<NodeWorkspace>;

/**
 * The node's workspace, from the provisioner when one is wired and from the
 * honest fallback when none is.
 *
 * ONE function, so there is exactly one place that changes when the substrate
 * lands, and exactly one place a test can prove a node was told the truth about
 * its own boundary.
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
