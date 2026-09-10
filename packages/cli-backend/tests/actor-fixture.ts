import type { Database } from 'bun:sqlite';
import {
  ActorSession, EventLog, EvolutionEngine, WorkspaceActorDirectory,
  BUILTIN_PROFILE_CATALOG, actorReferenceOf, createAgentStores, profileCatalogDigest,
  collectDynamicContext, createActorHost, defaultLoopOrigin, explorationActorKey,
  facetHomeReleaser, headAgentName, resolveAgentTurnProfile,
  type ActorHost, type AgentRuntime, type BroadcastEvent, type HostedNodeSeat,
  type ActorHandle, type HeadInput, type NodeIdentity, type ProfileAuthorityInputs,
  type SqlExec, type SqlValue, type WriteObserver,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
} from '@kinu.run/core';
import { bindLocalActor, localActorDirectory, registerLocalActor, registerLocalNode, retireLocalActor } from '../src/actor-identity';
import { buildLocalActorRuntime, cleanupFacetCwdScratch, makeSqlExec, type CLIRuntime } from '../src/runtime';
import type { HostedHeadSeat } from '../src/head-runtime';

/**
 * A head's runtime over its PARENT's database — the only database there is.
 *
 * The fixture registers the head through the production directory and binds it
 * with nothing else: a head has no store of its own to seed and no path to be
 * handed, which is what one physical workspace per tree means.
 */
export async function createHeadRuntime(parent: CLIRuntime, id: string, observer?: WriteObserver) {
  const binding = registerLocalActor(parent.actor, { name: explorationActorKey(id), creationId: id, kind: 'head', lifetime: 'task' });
  // The handle this head's runtime carries is the one bound HERE. A per-kind
  // runtime is built over the handle its binder issued — the release fence is
  // bound to that object — so the fixture binds once and hands that handle
  // through `buildLocalActorRuntime`, exactly as a host does.
  const handle = bindLocalActor(parent.storage.sql, binding);
  return buildLocalActorRuntime(parent, { reference: binding.reference, handle }, observer);
}

/**
 * THE GENUINE HOST, over one workspace database.
 *
 * Not a stand-in: this is `createActorHost` with the production directory, the
 * production per-kind runtime builder and the production loop seeding. What a
 * test supplies that a daemon supplies differently is only the client fan-out —
 * a chat session broadcasts to a TUI, a fixture collects — and the turn queue,
 * which a head genuinely has none of.
 *
 * `writes` is the same slot production keeps (`LocalAgentSession.actorWrites`,
 * read back through `pendingWriteObserver`): the HOST builds the runtime, but
 * only the caller that asked for the seat knows what has to watch it, and
 * `ActorHostDeps.runtimeFor` is deliberately narrow. So the caller fills the
 * slot before `acquire` and this reads it — never a widened seam. Held by the
 * CALLER rather than minted here, because the seat factory that fills it is a
 * separate function and a module-level map would outlive every test in the
 * file.
 */
export function localTestActorHost(
  parent: CLIRuntime,
  db: Database,
  broadcasts: BroadcastEvent[] = [],
  writes?: ReadonlyMap<string, WriteObserver>,
): ActorHost {
  const exec = makeSqlExec(db);
  const { directory } = localActorDirectory(parent.actor);
  return createActorHost({
    storage: {
      sql: parent.storage.sql,
      transactionSync: parent.storage.transactionSync,
      exec: exec.exec,
    },
    directory,
    installedBuild: null,
    runtimeFor: (bound) => buildLocalActorRuntime(parent, bound, writes?.get(bound.reference.actorId)),
    loopFor: (bound) => ({ origin: defaultLoopOrigin(bound.record.kind), parent }),
    orchestrationFor: (bound) => ({
      host: {
        broadcast: (event) => { broadcasts.push(event); },
        // A head or a node admits exactly the turns its controller runs; a
        // programmatic injection has no queue here to land in, and `skipped`
        // is that answer rather than a silence.
        enqueueTurn: async () => ({ status: 'skipped' }),
        turnInFlight: () => false,
        // Refused, not scheduled. No consumer of this fixture arms a drain, and
        // the `void fn()` this replaces discarded the rejection of one that did
        // — under `.unref()` a failing drain could not even be observed late.
        setTimer: () => { throw new Error('this fixture host must not schedule background work'); },
      },
      engine: new EvolutionEngine(bound.runtime, { enabled: false }),
      eventLog: new EventLog(exec, bound.handle),
    }),
    contextEvents: (bound) => bound.stores.eventRecorder,
  });
}

/**
 * The seat factory `createCLIHeadRuntime` takes, over a real host.
 *
 * The profile is resolved through the PARENT RUNTIME's own authority — the same
 * `resolveAgentTurnProfile` a chat turn resolves through — so a head's claim
 * pins a real tier rather than a fixture constant.
 *
 * `writes` MUST be the same map the host above was built with: this fills the
 * run's observer in before `acquire` and clears it on release, so the slot's
 * lifetime is the seat's and the next head seated under the same reference
 * cannot inherit it. Omitted, a head reports no file changes at all — which is
 * what the production seam does for a caller that names no observer.
 */
export function headSeatFactory(
  parent: CLIRuntime,
  host: ActorHost,
  runId = 'fixture-run',
  writes?: Map<string, WriteObserver>,
): (input: HeadInput, observer: WriteObserver) => Promise<HostedHeadSeat> {
  return async (input, observer) => {
    const binding = registerLocalActor(parent.actor, {
      name: explorationActorKey(input.id), creationId: input.id, kind: 'head', lifetime: 'task',
    });
    const agentName = headAgentName(binding.storageKey);
    writes?.set(binding.reference.actorId, observer);
    const actor = await host.acquire(binding.reference);
    return {
      actor,
      runId,
      profile: async (probe) => {
        const authority = parent.profiles;
        if (!authority) throw new Error('the parent runtime carries no profile authority');
        const inputs = await authority.inputs();
        return {
          profile: resolveAgentTurnProfile({
            ...inputs,
            activeRoleId: 'general',
            workMode: probe.workMode,
            availableTools: [...probe.availableTools],
            activeSkills: [],
          }),
          inputs,
        };
      },
      dynamic: () => collectDynamicContext({
        rt: actor.runtime,
        stores: actor.stores,
        memoryTail: undefined,
        missingCapabilities: [],
        subordinateDelegates: () => [],
        approvals: () => ({ items: [], total: 0 }),
      }),
      release: async () => {
        host.release(binding.reference);
        writes?.delete(binding.reference.actorId);
        await retireLocalActor(parent.actor, binding.name, binding.reference, async () => {
          if (parent.cwd) cleanupFacetCwdScratch(parent.cwd, agentName);
          else if (parent.nodeHome) await facetHomeReleaser(parent.nodeHome())(agentName);
        });
      },
    };
  };
}

/**
 * The positional-binding executor an EventLog needs, over a runtime that
 * exposes only its template-tag SQL.
 *
 * The split on `?` rebuilds the exact template the tag would have received, so
 * one statement reaches SQLite once with its bindings in place — never a
 * concatenation, which is how a fixture adapter turns a bound value into
 * injectable text.
 */
function execOver(rt: AgentRuntime): SqlExec {
  return {
    exec: (query, ...bindings) => {
      const parts = query.split('?');
      const strings: TemplateStringsArray = Object.assign(parts, { raw: parts });
      const rows = rt.storage.sql<Record<string, SqlValue>>(strings, ...bindings);
      return { toArray: () => rows };
    },
  };
}

/**
 * The four seams a CLAIMED head or node loop needs beyond its tools, over a
 * plain fixture runtime.
 *
 * Every part is real: the directory row comes from the directory the runtime's
 * own handle was issued by, the stores are the production bundle over that
 * handle, and the `ActorSession` is the production class. Only the client
 * fan-out and the turn queue are the fixture's, because a head genuinely has
 * neither — its controller is the only thing that admits its turns.
 *
 * The profile is the BUILTIN catalog at a pristine authority (version 0), which
 * is what an actor with no account catalog behind it really resolves against —
 * not a constant standing in for one.
 */
export function headLoopSeams(rt: AgentRuntime, runId = 'fixture-run', handle: ActorHandle = rt.actor, runtime: AgentRuntime = rt) {
  const identity = rt.storage.sql<{ id: string; owner_user_id: string | null }>`
    SELECT id, owner_user_id FROM workspace_identity LIMIT 1`[0];
  if (!identity) throw new Error('this fixture runtime has no workspace identity to host an actor in');
  const directory = new WorkspaceActorDirectory(rt.storage.sql, {
    workspaceId: identity.id, ownerUserId: identity.owner_user_id ?? '',
  });
  const stores = createAgentStores(() => rt.storage.sql, () => handle, rt.storage.transactionSync);
  const session: ActorSession = new ActorSession({
    runtime,
    claims: stores.claims,
    installedBuild: null,
    orchestration: {
      host: {
        broadcast: () => {},
        enqueueTurn: async () => ({ status: 'skipped' }),
        turnInFlight: () => session.inFlight,
        setTimer: () => { throw new Error('this fixture session must not schedule background work'); },
      },
      engine: new EvolutionEngine(rt, { enabled: false }),
      eventLog: new EventLog(execOver(rt), handle),
    },
  });
  const inputs: ProfileAuthorityInputs = {
    envelope: {
      authority: { kind: 'local' },
      version: 0,
      digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
      catalog: BUILTIN_PROFILE_CATALOG,
    },
    // The catalog's OWN models, not an empty list. `resolve.ts:277` reads an
    // empty `unavailableProviders` as "this listing is COMPLETE", so an empty
    // `availableModels` beside it asserts the provider offers nothing — and
    // every tier resolve then refuses. A pristine authority still has the
    // models its tiers are configured with; that is what makes it pristine
    // rather than empty. Same convention as `test-utils/src/merge-policy.ts`.
    provider: { revision: '0', availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC] },
  };
  return {
    actor: {
      reference: actorReferenceOf(handle),
      // RE-ISSUED through THIS directory, not described from a foreign handle.
      // `describe` gates on a per-instance WeakSet (workspace-actors.ts:113) so a
      // handle issued by another directory over the same database is refused
      // `denied` — which is the check working, not a fixture inconvenience: a
      // handle carries the authority of the directory that issued it. `open`
      // re-issues the row here with every ownership and liveness check intact.
      record: directory.describe(directory.open(handle.actorId)),
      handle,
      stores,
      runtime,
      session,
    },
    runId,
    profile: async (probe) => ({
      profile: resolveAgentTurnProfile({
        ...inputs,
        activeRoleId: 'general',
        workMode: probe.workMode,
        availableTools: [...probe.availableTools],
        activeSkills: [],
      }),
      inputs,
    }),
    dynamic: () => collectDynamicContext({
      rt: runtime,
      stores,
      memoryTail: undefined,
      missingCapabilities: [],
      subordinateDelegates: () => [],
      approvals: () => ({ items: [], total: 0 }),
    }),
  } satisfies Omit<HostedHeadSeat, 'release'>;
}

/**
 * The per-node seat `AgentsSwarmDeps.hostNode` takes, over a real registration.
 *
 * A FACTORY, because a wave's node deps are built once and shallow-copied per
 * child: one shared actor would give every node of that wave one claim ledger
 * and one row set, which is the collision this makes impossible. Each call
 * registers its own node actor in the production directory and builds that
 * actor's own runtime over the ONE database.
 */
export function nodeSeatFactory(rt: CLIRuntime, runId = 'fixture-run'): (node: NodeIdentity) => Promise<HostedNodeSeat> {
  return async (node) => {
    const handle = registerLocalNode(rt.actor, node);
    // The handle this seat's runtime must carry is the one registered above —
    // the host requires the runtime and the binding to be the same handle, so a
    // fixture that re-derived one here would build a seat the host refuses.
    // A node seat is a head row in swarm mode, declared the way production
    // declares it — without the flag this would build the branching-head
    // runtime and provision a home the loop never runs on.
    const runtime = await buildLocalActorRuntime(rt, { reference: actorReferenceOf(handle), handle }, undefined, true);
    const seams = headLoopSeams(rt, runId, handle, runtime);
    return { actor: seams.actor, runId: seams.runId, profile: seams.profile, dynamic: seams.dynamic };
  };
}
