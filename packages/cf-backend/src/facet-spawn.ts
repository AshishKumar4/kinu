/**
 * Exploration-facet spawning — the one path from a facet id to a live worker,
 * and back again to reclaimed storage.
 *
 * Kinu's parallel workers (MCTS branches and heads) all run as the same
 * Cloudflare Facet: `subAgent(host.explorationFacet(), id)` resolves-or-creates a
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
 * belongs destroys a live worker's state; aborting where a release belongs leaks
 * a permanent database per finished worker into the orchestrator DO.
 *
 * ── Containment ──────────────────────────────────────────────────────────
 *
 * ExplorationAgent is a bare `Agent`, deliberately not an ActorAgent, so a head
 * can never acquire the think/team/peers surface and open an unbounded spawn
 * tree (unit-exploration-containment.test.ts). Routing every spawn of it
 * through this module keeps that one class the only thing a head can start —
 * a head forks its parent's RESOURCES (@kinu.run/core head-tools), never its
 * authority to create actors.
 *
 * Subordinates are not spawned here on purpose: SubordinateAgent drags in the
 * orchestrator/runtime graph, which imports this module back — their facet
 * plumbing stays behind the SubordinateRuntime seam on the orchestrator.
 */

import type { Agent, SubAgentClass, SubAgentStub } from "agents";
import type { BranchHandle, HeadId, HeadInput, NodeLoopResult, NodeRunSpec, SpawnedHead } from "@kinu.run/core";
import type { ExplorationAgent } from "./exploration";
import { renderThrownChain } from '@kinu.run/core/obs';

/** The facet substrate a spawner rides. Both the workspace DO and a head
 *  splitting further expose it, so both can spawn — and both must reclaim. */
export interface FacetHost extends Pick<Agent<Env>, "subAgent" | "abortSubAgent" | "deleteSubAgent"> {
  /** The class an exploration facet of this host is created as. Type-only above,
   *  so this module carries no runtime import of the facet it spawns — the same
   *  rule ActorAgent.subordinateFacet() follows for SubordinateAgent. */
  explorationFacet(): SubAgentClass<ExplorationAgent>;
}


/** The stub `subAgent` hands back, named once so the bootstrap seam can take a
 *  mode's own init RPC as an argument. */
type ExplorationStub = SubAgentStub<ExplorationAgent>;

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
   *  becomes the tree's workspace.
   *
   *  An MCTS branch carries it too, and forks NOTHING with it. A branch has no
   *  runtime — containment is that it never calls `facetRuntime()` — but every
   *  facet needs the parent's resolved turn profile to know which model its work
   *  routes to, and the parent's name is how it reaches it. Absent, a branch
   *  silently ran the account default instead of the turn's tier. */
  readonly sharedParent?: string | null;
}


/**
 * MID-FLIGHT eviction: stop the instance, KEEP its storage.
 *
 * `abortSubAgent` is exactly `ctx.facets.abort(facetKey, reason)` in agents
 * 0.20.1 — pending RPCs reject and the instance restarts on next use, and
 * nothing is deleted. That is the right verb only while something else still
 * owns the terminal release: cutting a head short so its own `run()` can settle
 * and release, or dropping a branch the search has stopped selecting.
 *
 * `reason` is that call's own reason channel, for a caller with no graceful-stop
 * RPC to carry it: a node's loop has none, so eviction is the whole of its abort.
 */
export function abortExplorationFacet(host: FacetHost, id: string, reason?: string): void {
  host.abortSubAgent(host.explorationFacet(), id, reason);
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
  await host.deleteSubAgent(host.explorationFacet(), id);
}

/** Where a facet stands in the ledgers that own its lifecycle. Derived by the
 *  caller from the EXISTING head journal and search-run tables; this module
 *  owns no registry of its own. */
export type ExplorationFacetLedgerStatus = 'resumable' | 'terminal' | 'unknown';
export interface ExplorationFacetRegistry {
  list(): readonly { name: string }[];
  delete(id: string): Promise<void>;
}


/**
 * Reclaim exploration facets a DO reset left behind, over the SDK's own facet
 * registry (`listSubAgents`).
 *
 * A terminal ledger row proves its facet has no reader left, so its storage is
 * reclaimed. A resumable row is preserved whatever the host is doing — the job
 * sweep, not this sweep, decides whether interrupted work re-drives. An
 * unledgered facet is reclaimed only when nothing live claims exploration
 * work: MCTS creates a branch facet BEFORE it writes the child node, so
 * treating every missing row as an orphan would destroy an active rollout.
 */
export async function reconcileExplorationFacets(
  registry: ExplorationFacetRegistry,
  ledgerStatus: (id: string) => ExplorationFacetLedgerStatus,
  hasLiveExploration: () => boolean,
): Promise<{ reclaimed: number; retained: number }> {
  let reclaimed = 0;
  let retained = 0;
  const live = hasLiveExploration();
  for (const facet of registry.list()) {
    const status = ledgerStatus(facet.name);
    if (status === 'terminal' || (status === 'unknown' && !live)) {
      await registry.delete(facet.name);
      reclaimed += 1;
    } else {
      retained += 1;
    }
  }
  return { reclaimed, retained };
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
      + `(leaked into the root's quota): ${renderThrownChain({ cause: cleanupError })}`,
      { cause },
    );
  }
  throw cause;
}

/** What a mode's init RPC acknowledges. The VALUE is discarded; the round trip is
 *  the point — a handle returned before the facet persisted what it is about to
 *  run is a handle to an unseeded worker. */
interface FacetInitAck {
  readonly ok: true;
  readonly id: string;
}

/**
 * Seed a fresh facet for whatever it is about to be, or discard it and report why.
 *
 * Every mode's spawn starts here, and the ORDER is the contract: identity, then
 * that mode's own init. A facet told what to run before it is told whose
 * credentials to run it with is one RPC away from resolving the wrong model.
 */
async function bootstrapFacet(
  host: FacetHost,
  id: string,
  identity: ExplorationFacetIdentity,
  init?: (stub: ExplorationStub) => Promise<FacetInitAck>,
): Promise<ExplorationStub> {
  const stub = await host.subAgent(host.explorationFacet(), id);
  try {
    if (identity.ownerUserId) await stub.setOwner(identity.ownerUserId, identity.capabilityToken);
    if (identity.sharedParent) await stub.setSharedParent(identity.sharedParent);
    if (init) await init(stub);
  } catch (err) {
    await discardHalfSeededFacet(host, id, err);
  }
  return stub;
}

/**
 * Run a single-shot worker to completion, then reclaim its storage — the whole of
 * a head's and a node's `run()` around the one RPC that differs between them.
 *
 * The split is what earns one home: the run is awaited to a VALUE first, so a
 * reclamation failure and a run failure can never mask one another, and the wipe
 * is attempted either way because a settled worker nothing will read again is a
 * pure leak. A failed wipe is not swallowed even at the cost of a settled report,
 * for the reason this module's header gives. `kind` only names the worker in that
 * message.
 */
async function runOnceAndReclaim<Result>(
  host: FacetHost,
  id: string,
  kind: 'Head' | 'Node',
  run: () => Promise<Result>,
): Promise<Result> {
  let reclaiming = false;
  try {
    const result = await run();
    reclaiming = true;
    await deleteExplorationFacet(host, id);
    return result;
  } catch (cause) {
    if (reclaiming) {
      throw new Error(
        `${kind} facet ${id} settled but its storage was not reclaimed `
        + `(leaked into the root's quota): ${renderThrownChain({ cause })}`,
        { cause },
      );
    }
    // The run failed, so the wipe below is a best-effort reclaim rather than
    // the terminal release. When it fails too both facts travel: the run's own
    // error stays the cause (as the bootstrap twin keeps it) and the message
    // names the stranded storage beside it.
    try {
      await deleteExplorationFacet(host, id);
    } catch (cleanupError) {
      throw new Error(
        `${kind} facet ${id} failed and its storage was not reclaimed `
        + `(leaked into the root's quota): ${renderThrownChain({ cause: cleanupError })}`,
        { cause },
      );
    }
    throw cause;
  }
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
  const stub = await bootstrapFacet(host, branchId, identity);
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
  const stub = await bootstrapFacet(host, input.id, identity, (facet) => facet.initHead(input));
  return {
    id: input.id,
    run: () => runOnceAndReclaim(host, input.id, 'Head', () => stub.runAsHead()),
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

/** A hosted swarm node's handle — `SpawnedHead`'s shape over a node's result,
 *  because it is the spawner's side of core's `NodeLoopHost`: one call, one
 *  result. */
export interface SpawnedNode {
  readonly id: HeadId;
  /** Kicks off the node's loop; resolves with everything the search reads out of it. */
  run(): Promise<NodeLoopResult>;
  /** Best-effort abort — used when the search stops wanting this node. */
  abort(reason: string): void;
}

/** Swarm node: the same facet hosting core's node loop over `spec`.
 *
 *  Releases itself for a head's reason — `run()` settling IS the terminal point,
 *  because a `NodeLoopResult` carries the whole of what the search takes out of a
 *  node (its report, its own report call, the branch it was granted, and the
 *  messages it produced) and the journal rows for all of it live on the search
 *  rather than on this facet.
 *
 *  The node's home is NOT provisioned here: `runNodeAgent` provisions it before it
 *  calls a host, which is why `spec.home` is already a path by the time this runs. */
export async function spawnNodeFacet(
  host: FacetHost,
  spec: NodeRunSpec,
  identity: ExplorationFacetIdentity,
): Promise<SpawnedNode> {
  const id = spec.headInput.id;
  const stub = await bootstrapFacet(host, id, identity, (facet) => facet.initNode(spec));
  return {
    id,
    run: () => runOnceAndReclaim(host, id, 'Node', () => stub.runAsNode()),
    /** Cut a node short. An ABORT and not a release, for the reason a head's is:
     *  `run()` is still in flight and owns the terminal release, and evicting the
     *  instance is what makes its pending `runAsNode` RPC reject so that release
     *  actually happens. Nothing is asked of the facet first — a node's only
     *  in-loop stopping seam is `NodeLoopDeps.signal`, which lives on the search's
     *  side of this RPC — so eviction is the whole of the abort. */
    abort: (reason) => {
      abortExplorationFacet(host, id, reason);
    },
  };
}
