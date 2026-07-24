/**
 * Exploration-facet spawning — the one path from a facet id to a live worker.
 *
 * Proteus's parallel workers (MCTS branches and heads) all run as the same
 * Cloudflare Facet: `subAgent(ExplorationAgent, id)` resolves-or-creates a
 * co-located child DO, then a short bootstrap sequence seeds the identity it
 * needs. Every bootstrap RPC persists into the FACET's own SQLite, so a facet
 * that hibernates between spawn and run recovers on cold activation — which is
 * why a spawn must not hand back a handle before the bootstrap is acknowledged,
 * and must discard a facet whose bootstrap failed rather than leave a
 * half-seeded one addressable.
 *
 * ExplorationAgent is a bare `Agent`, deliberately not an ActorAgent, so a head
 * can never acquire the think/team/peers surface and open an unbounded spawn
 * tree (unit-exploration-containment.test.ts). Routing every spawn of it
 * through this module keeps that one class the only thing a head can start.
 *
 * Subordinates are not spawned here on purpose: SubordinateAgent drags in the
 * orchestrator/runtime graph, which imports this module back — their facet
 * plumbing stays behind the SubordinateRuntime seam on the orchestrator.
 */

import type { Agent } from "agents";
import type { BranchHandle, HeadInput, SpawnedHead } from "@proteus/core";
import { ExplorationAgent } from "./exploration.js";

/** The facet substrate a spawner rides. Both the workspace DO and a head
 *  splitting further expose it, so both can spawn. */
export type FacetHost = Pick<Agent<Env>, "subAgent" | "abortSubAgent">;

/** What an exploration facet must know before it runs. Both values are
 *  persisted by the facet itself, so a cold activation recovers them. */
export interface ExplorationFacetIdentity {
  /** Owner userId, or null while the workspace is unclaimed. */
  readonly ownerUserId: string | null;
  /** The SPAWNER's workspace capability token, handed down so a head reaches
   *  the owner's credentials as its workspace and is attenuated with it. Null
   *  while the workspace is unclaimed. */
  readonly capabilityToken: string | null;
  /** The ROOT orchestrator's workspace name — the shared findings scratch every
   *  head in a tree writes to, propagated UNCHANGED through recursive splits so
   *  an intermediate head never becomes the tree's scratch. Absent for MCTS
   *  branches, which have no shared scratch. */
  readonly sharedParent?: string | null;
}

async function seedExplorationIdentity(
  stub: Pick<ExplorationAgent, "setOwner" | "setSharedParent">,
  identity: ExplorationFacetIdentity,
): Promise<void> {
  if (identity.ownerUserId) await stub.setOwner(identity.ownerUserId, identity.capabilityToken);
  if (identity.sharedParent) await stub.setSharedParent(identity.sharedParent);
}

/** Evict a facet: pending RPCs reject and the instance restarts on next use.
 *  Storage survives — head and branch ids are unique per run, so nothing
 *  addresses the evicted facet again. */
export function abortExplorationFacet(host: FacetHost, id: string): void {
  try { host.abortSubAgent(ExplorationAgent, id); } catch { /* already gone */ }
}

/** MCTS branch: a one-shot rollout facet. */
export async function spawnBranchFacet(
  host: FacetHost,
  branchId: string,
  identity: ExplorationFacetIdentity,
): Promise<BranchHandle> {
  const stub = await host.subAgent(ExplorationAgent, branchId);
  try {
    await seedExplorationIdentity(stub, identity);
  } catch (err) {
    abortExplorationFacet(host, branchId);
    throw err;
  }
  return {
    explore: (history, tools, siblings) => stub.explore(history, tools, siblings ?? []),
    generateReflection: (task) => stub.generateReflection(task),
  };
}

/** Branching head: the same facet in head mode, driving a multi-step inference
 *  loop over `input` (whose budget the caller has already decremented). */
export async function spawnHeadFacet(
  host: FacetHost,
  input: HeadInput,
  identity: ExplorationFacetIdentity,
): Promise<SpawnedHead> {
  const stub = await host.subAgent(ExplorationAgent, input.id);
  try {
    await seedExplorationIdentity(stub, identity);
    await stub.initHead(input);
  } catch (err) {
    abortExplorationFacet(host, input.id);
    throw err;
  }
  return {
    id: input.id,
    run: () => stub.runAsHead(),
    abort: async (reason) => {
      try { await stub.abortHead(reason); } catch { /* facet already gone */ }
      abortExplorationFacet(host, input.id);
    },
  };
}
