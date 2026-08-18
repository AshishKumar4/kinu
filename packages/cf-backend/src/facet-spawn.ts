/**
 * Exploration-facet spawning — the one path from a facet id to a live worker,
 * and back again to reclaimed storage.
 *
 * Proteus's parallel workers (MCTS branches and heads) all run as the same
 * Cloudflare Facet: `subAgent(ExplorationAgent, id)` resolves-or-creates a
 * co-located child DO, then a short bootstrap sequence seeds the identity it
 * needs. Every bootstrap RPC persists into the FACET's own SQLite, so a facet
 * that hibernates between spawn and run recovers on cold activation — which is
 * why a spawn must not hand back a handle before the bootstrap is acknowledged,
 * and must discard a facet whose bootstrap failed rather than leave a
 * half-seeded one addressable. A parent and its facets are evicted JOINTLY
 * after a couple of minutes idle, so "it was set on the instance a moment ago"
 * is never safe to assume between two RPCs.
 *
 * ── Two lifecycle verbs, and the difference is load-bearing ──────────────
 *
 * A facet's SQLite is neither free nor separately quota'd: it is charged to the
 * ROOT DO, against a budget shared by the root and every facet and clone
 * beneath it, and the overflow is not a catchable error but a reset that
 * empties the destination. There is a second, independent wall at 65,536
 * facets per DO lifetime (workerd's FacetTreeIndex). Both are reached on the
 * ordinary default path, so a finished worker must give its storage back.
 *
 *   abort   (abortExplorationFacet)  — MID-FLIGHT eviction. The instance stops
 *           and pending RPCs reject; storage is KEPT. For a worker that may
 *           still be read, or that is being cut short while something else
 *           still owns the terminal release.
 *   release (deleteExplorationFacet) — TERMINAL settle. Storage is WIPED.
 *           Called once, at the point after which nothing will ever read the
 *           facet again.
 *
 * These are not interchangeable in either direction. Releasing where an abort
 * belongs destroys a live worker's state; aborting where a release belongs is
 * the leak this module previously had, in which every head and every MCTS
 * branch abandoned a permanent database inside the orchestrator DO.
 *
 * ── Containment ──────────────────────────────────────────────────────────
 *
 * ExplorationAgent is a bare `Agent`, deliberately not an ActorAgent, so a head
 * can never acquire the think/team/peers surface and open an unbounded spawn
 * tree (unit-exploration-containment.test.ts). Routing every spawn of it
 * through this module keeps that one class the only thing a head can start —
 * a head forks its parent's RESOURCES (@proteus/core head-tools), never its
 * authority to create actors.
 *
 * Subordinates are not spawned here on purpose: SubordinateAgent drags in the
 * orchestrator/runtime graph, which imports this module back — their facet
 * plumbing stays behind the SubordinateRuntime seam on the orchestrator.
 */

import type { Agent } from "agents";
import type { BranchHandle, HeadInput, SpawnedHead } from "@proteus/core";
import { ExplorationAgent } from "./exploration";

/** The facet substrate a spawner rides. Both the workspace DO and a head
 *  splitting further expose it, so both can spawn — and both must reclaim. */
export type FacetHost = Pick<Agent<Env>, "subAgent" | "abortSubAgent" | "deleteSubAgent">;

/** What an exploration facet must know before it runs. Both values are
 *  persisted by the facet itself, so a cold activation recovers them. */
export interface ExplorationFacetIdentity {
  /** Owner userId, or null while the workspace is unclaimed. */
  readonly ownerUserId: string | null;
  /** The SPAWNER's workspace capability token, handed down so a head reaches
   *  the owner's credentials as its workspace and is attenuated with it. Null
   *  while the workspace is unclaimed. */
  readonly capabilityToken: string | null;
  /** The ROOT orchestrator's workspace name — the workspace a head forks: its
   *  exec planes, its files, and the findings space the whole tree shares.
   *  Propagated UNCHANGED through recursive splits so an intermediate head never
   *  becomes the tree's workspace. Absent for MCTS branches, which fork nothing:
   *  a branch has no runtime at all. */
  readonly sharedParent?: string | null;
}

async function seedExplorationIdentity(
  stub: Pick<ExplorationAgent, "setOwner" | "setSharedParent">,
  identity: ExplorationFacetIdentity,
): Promise<void> {
  if (identity.ownerUserId) await stub.setOwner(identity.ownerUserId, identity.capabilityToken);
  if (identity.sharedParent) await stub.setSharedParent(identity.sharedParent);
}

function errorText<Thrown>(thrown: Thrown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * MID-FLIGHT eviction: stop the instance, KEEP its storage.
 *
 * `abortSubAgent` is exactly `ctx.facets.abort(facetKey, reason)` in agents
 * 0.20.1 — pending RPCs reject and the instance restarts on next use, and
 * nothing is deleted. That is the right verb only while something else still
 * owns the terminal release: cutting a head short so its own `run()` can settle
 * and release, or dropping a branch the search has stopped selecting.
 */
export function abortExplorationFacet(host: FacetHost, id: string): void {
  host.abortSubAgent(ExplorationAgent, id);
}

/**
 * TERMINAL settle: abort the facet if it is still running, then WIPE its
 * storage.
 *
 * `deleteSubAgent` is a strict superset of `abortSubAgent` — it evicts a
 * running facet first, then runs `_cf_cleanupFacetPrefix` and
 * `ctx.facets.delete` — so it never wipes a database out from under a live
 * writer. Ids are unique per run, which is why this is safe AND why it is
 * mandatory: because the id is never reused the database is never overwritten,
 * so a facet that is merely evicted is abandoned inside the root DO forever.
 *
 * Idempotent: the SDK swallows `ctx.facets.delete` for an already-gone facet,
 * so a raced abort and settle both landing here is safe.
 */
export async function deleteExplorationFacet(host: FacetHost, id: string): Promise<void> {
  await host.deleteSubAgent(ExplorationAgent, id);
}

/**
 * Discard a facet whose bootstrap failed, then report why the spawn failed.
 *
 * A reclamation failure is deliberately NOT swallowed: it means a half-seeded
 * facet kept its storage, which is the one thing this module exists to prevent,
 * so it is reported together with the bootstrap error instead of hidden behind
 * it.
 */
async function discardHalfSeededFacet<Cause>(host: FacetHost, id: string, cause: Cause): Promise<never> {
  try {
    await deleteExplorationFacet(host, id);
  } catch (cleanupError) {
    throw new Error(
      `Exploration facet ${id} failed to bootstrap and its storage could not be reclaimed `
      + `(leaked into the root's quota): ${errorText(cleanupError)}`,
      { cause },
    );
  }
  throw cause;
}

/** MCTS branch: a one-shot rollout facet.
 *
 *  Released by the caller, not here. The search engine owns a branch for
 *  exactly one iteration — it explores, gets scored, and may be asked to
 *  reflect on why it scored badly, and that reflection reads the branch's own
 *  `traces` table. That is the whole and only window in which a finished
 *  branch's storage is still wanted, and `mcts/engine.ts` closes it explicitly
 *  in the `finally` that releases every id it spawned, which runs strictly
 *  after every reflection in the iteration. */
export async function spawnBranchFacet(
  host: FacetHost,
  branchId: string,
  identity: ExplorationFacetIdentity,
): Promise<BranchHandle> {
  const stub = await host.subAgent(ExplorationAgent, branchId);
  try {
    await seedExplorationIdentity(stub, identity);
  } catch (err) {
    await discardHalfSeededFacet(host, branchId, err);
  }
  return {
    explore: (history, tools, languages, mode, siblings) =>
      stub.explore(history, tools, languages, mode, siblings ?? []),
    generateReflection: (task, outcome) => stub.generateReflection(task, outcome),
  };
}

/** Branching head: the same facet in head mode, driving a multi-step inference
 *  loop over `input` (whose budget the caller has already decremented).
 *
 *  Unlike a branch, a head releases itself, because `run()` settling IS the
 *  terminal point: the HeadReport it resolves with carries the summary,
 *  evidence, decisions, artifacts, file changes, tool calls and the ordered
 *  step trace, and the journal rows for anything the head split into live on
 *  the root orchestrator rather than on this facet. Nothing reads the facet
 *  afterwards, so nothing is lost by wiping it — and `HeadController` has no
 *  success-path cleanup call at all, so a head that is not released here is
 *  never released. */
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
    await discardHalfSeededFacet(host, input.id, err);
  }
  return {
    id: input.id,
    run: async () => {
      // Settle the run BEFORE reclaiming, so a reclamation failure and a run
      // failure can never mask one another.
      const settled = await stub.runAsHead().then(
        (report) => ({ ok: true as const, report }),
        <Thrown,>(thrown: Thrown) => ({ ok: false as const, thrown }),
      );
      try {
        await deleteExplorationFacet(host, input.id);
      } catch (cleanupError) {
        // Deliberately NOT swallowed. A delete that fails is the leak
        // persisting, against a quota whose overflow is an uncatchable reset
        // that destroys the whole workspace — the one failure in this module
        // that must never pass quietly, even at the cost of a settled report.
        throw new Error(
          `Head facet ${input.id} settled but its storage was not reclaimed `
          + `(leaked into the root's quota): ${errorText(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      if (!settled.ok) throw settled.thrown;
      return settled.report;
    },
    /** Cut a head short — a caller-requested deadline blew. Deliberately an
     *  ABORT and not a release: `run()` is still in flight and owns the
     *  terminal release, and evicting the instance is what makes its pending
     *  `runAsHead` RPC reject so that release actually happens. Releasing here
     *  instead would wipe the storage of a head that is still writing. */
    abort: async (reason) => {
      // Ask for a graceful stop first so the head records its own abort reason,
      // then evict regardless. The `finally` keeps teardown unconditional
      // without discarding an abortHead failure, which reaches the caller —
      // callers already defend (controller.ts raceWithTimeout, steer-branch).
      try {
        await stub.abortHead(reason);
      } finally {
        abortExplorationFacet(host, input.id);
      }
    },
  };
}
