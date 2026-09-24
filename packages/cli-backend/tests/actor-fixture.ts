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
import { unobservedSpend } from '@kinu.run/test-utils';

/** A head's runtime over its parent's database; a head has no store of its own. */
export async function createHeadRuntime(parent: CLIRuntime, id: string, observer?: WriteObserver) {
  const binding = registerLocalActor(parent.actor, { name: explorationActorKey(id), creationId: id, kind: 'head', lifetime: 'task' });
  // The per-kind runtime's release fence binds to the handle its binder issued, so bind once and pass it through.
  const handle = bindLocalActor(parent.storage.sql, binding);

  return buildLocalActorRuntime(parent, { reference: binding.reference, handle }, observer);
}

/**
 * The production actor host over one workspace database; only client fan-out and the turn queue are fixture-owned.
 * `writes` is caller-held (like `LocalAgentSession.actorWrites`) so it cannot outlive a test file.
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
    filesFor: async (bound) => {
      if (!parent.filesForActor) throw new Error('test workspace has no actor file resolver');

      return parent.filesForActor(bound.handle);
    },
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
        enqueueTurn: async () => ({ status: 'skipped' }),
        turnInFlight: () => false,
        setTimer: () => { throw new Error('this fixture host must not schedule background work'); },
      },
      engine: new EvolutionEngine(bound.runtime, bound.stores.history, { reportModelCall: unobservedSpend, enabled: false }),
      eventLog: new EventLog(exec, bound.handle),
    }),
    contextEvents: (bound) => bound.stores.eventRecorder,
  });
}

/**
 * The seat factory `createCLIHeadRuntime` takes, over a real host.
 * `writes` must be the map the host was built with; omitted, a head reports no file changes.
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
            activeRoleId: 'task',
            workMode: probe.workMode,
            availableTools: [...probe.availableTools],
            activeSkills: [],
          }),
          inputs,
        };
      },
      dynamic: (profile, tools) => collectDynamicContext({
        rt: actor.runtime,
        stores: actor.stores,
        profile,
        tools,
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

/** Positional-binding executor over template-tag SQL; rebuilds the template so values stay bound, never concatenated. */
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

/** The four seams a claimed head or node loop needs beyond its tools, all production parts over a fixture runtime. */
export function headLoopSeams(rt: AgentRuntime, runId = 'fixture-run', handle: ActorHandle = rt.actor, runtime: AgentRuntime = rt) {
  const identity = rt.storage.sql<{ id: string; owner_user_id: string | null }>`
    SELECT id, owner_user_id FROM workspace_identity LIMIT 1`[0];

  if (!identity) throw new Error('this fixture runtime has no workspace identity to host an actor in');

  const directory = new WorkspaceActorDirectory(rt.storage.sql, {
    workspaceId: identity.id, ownerUserId: identity.owner_user_id ?? '',
  });

  const stores = createAgentStores(() => rt.storage.sql, () => handle, rt.storage.transactionSync, async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actors/' + handle.actorId }));

  const session: ActorSession = new ActorSession({ history: stores.history, runtime,
  claims: stores.claims,
  installedBuild: null,
  orchestration: {
    host: {
      broadcast: () => {},
      enqueueTurn: async () => ({ status: 'skipped' }),
      turnInFlight: () => session.inFlight,
      setTimer: () => { throw new Error('this fixture session must not schedule background work'); },
    },
    engine: new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend, enabled: false }),
    eventLog: new EventLog(execOver(rt), handle),
  }, });

  const inputs: ProfileAuthorityInputs = {
    envelope: {
      authority: { kind: 'local' },
      version: 0,
      digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
      catalog: BUILTIN_PROFILE_CATALOG,
    },
    // Empty `unavailableProviders` means the listing is complete, so empty `availableModels` would refuse every tier.
    provider: { revision: '0', availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC] },
  };

  return {
    actor: {
      reference: actorReferenceOf(handle),
      // `describe` refuses handles issued by another directory, so re-issue through this one.
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
        activeRoleId: 'task',
        workMode: probe.workMode,
        availableTools: [...probe.availableTools],
        activeSkills: [],
      }),
      inputs,
    }),
    dynamic: (profile, tools) => collectDynamicContext({
      rt: runtime,
      stores,
      profile,
      tools,
      memoryTail: undefined,
      missingCapabilities: [],
      subordinateDelegates: () => [],
      approvals: () => ({ items: [], total: 0 }),
    }),
  } satisfies Omit<HostedHeadSeat, 'release'>;
}

/** Per-node seat factory: each call registers its own node actor, so wave children never share a claim ledger. */
export function nodeSeatFactory(rt: CLIRuntime, runId = 'fixture-run'): (node: NodeIdentity) => Promise<HostedNodeSeat> {
  return async (node) => {
    const handle = registerLocalNode(rt.actor, node);
    // The host requires the runtime and binding to share one handle. Swarm mode keeps the node off the branching-head runtime.
    const runtime = await buildLocalActorRuntime(rt, { reference: actorReferenceOf(handle), handle }, undefined, true);
    const seams = headLoopSeams(rt, runId, handle, runtime);

    return { actor: seams.actor, runId: seams.runId, profile: seams.profile, dynamic: seams.dynamic };
  };
}
