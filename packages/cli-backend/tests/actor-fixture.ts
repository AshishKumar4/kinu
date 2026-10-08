import type { Database } from 'bun:sqlite';
import {
  ActorSession, EventLog, EvolutionEngine, historyTurnPairs, WorkspaceActorDirectory,
  BUILTIN_PROFILE_CATALOG, actorReferenceOf, createAgentStores, profileCatalogDigest,
  collectDynamicContext, createActorHost, defaultLoopOrigin, explorationActorKey,
  captureOperationProfile, initRunEventTables, promptCacheKey, runHeadInference, vfsTurnSkills,
  type ActorHost, type AgentRuntime, type BroadcastEvent, type HostedActor, type HostedNodeSeat,
  type ActorHandle, type HeadInput, type NodeIdentity, type ProfileAuthorityInputs, type RunTurnSources,
  type SqlExec, type SqlValue, type WriteObserver,
  DEFAULT_WORKERS_AI_MODEL_SPEC, WORKSPACE_ROOT, actorHomeName } from '@kinu.run/core';
import { ConversationSearchStore, bindLocalActor, localActorDirectory, registerLocalActor, retireLocalActor } from '@kinu.run/core';
import { buildLocalActorRuntime, cleanupFacetScratch, makeSqlExec, type CLIRuntime } from '../src/runtime';
import { modelWindow, type HeadInferenceDeps, type HeadSeat } from '@kinu.run/core';
import type { LanguageModel } from 'ai';

/** A run's compaction trigger, kept in memory: no fold runs here, but a run measures and arms as every turn does. */
export function fixtureCompaction(key = 'fixture-run'): HeadInferenceDeps['compaction'] {
  const tokens = new Map<string, { readonly tokens: number; readonly historyLength: number }>();
  const armed = new Set<string>();

  return {
    key,
    state: {
      loadPromptTokens: (sessionKey, historyLength) => {
        const saved = tokens.get(sessionKey);

        return saved !== undefined && saved.historyLength === historyLength ? saved.tokens : null;
      },
      takeArmedCompaction: (sessionKey) => armed.delete(sessionKey),
      savePromptTokens: (sessionKey, saved, historyLength) => { tokens.set(sessionKey, { tokens: saved, historyLength }); },
      armCompaction: (sessionKey) => { armed.add(sessionKey); },
    },
  };
}

/** A fixture run actor's turn sources: the production assembly over its own stores under the `task` role, the static
 *  window table, and the model a suite hands it. */
export function fixtureRunSources(
  actor: HostedActor, inputs: () => Promise<ProfileAuthorityInputs>, model: (spec: string) => LanguageModel, runId = 'fixture-run',
): RunTurnSources {
  actor.stores.config.setRoleSelection('task');

  return {
    rt: actor.runtime,
    backend: 'cli-local',
    executors: () => [],
    config: actor.stores.config,
    models: {
      catalog: { window: () => modelWindow(null), windowFor: async () => modelWindow(null), warm: async () => {}, acceptedMedia: () => new Set() },
      normalize: (spec) => spec,
      resolve: (spec) => model(spec),
    },
    skills: vfsTurnSkills(actor.runtime.storage.vfs, actor.stores.config, () => 'approved'),
    profileInputs: inputs,
    agentsActions: () => [],
    temporaryAsk: () => false,
    soul: async () => undefined,
    agentsMd: async () => ({ admitted: [], referenced: [] }),
    identity: async () => ({ agent: actor.record.name }),
    artifacts: () => ({ sections: {}, tools: { descriptions: {}, fields: {} } }),
    taskPlan: () => null,
    cacheKey: () => promptCacheKey('fixture', actor.record.actorId),
    scaffoldSpend: { source: 'scaffold', report: () => {} },
    attachmentBudget: actor.session.orchestrator.acc.context,
    extensions: () => [],
    dynamic: () => (profile, tools) => collectDynamicContext({
      rt: actor.runtime,
      stores: actor.stores,
      profile,
      tools,
      runtime: { backend: 'cli-local', model: { id: profile.tier.model }, date: '2026-01-01' },
      memoryTail: undefined,
      missingCapabilities: [],
      subordinateDelegates: () => [],
      approvals: () => ({ items: [], total: 0 }),
    }),
    operation: (profile, profileInputs) => captureOperationProfile({ actor: actor.handle, profile, inputs: profileInputs, runId, turnId: null }),
  };
}

/** A model a fixture seat refuses with, naming the seat: a suite that runs a turn hands its model. */
function noModel(name: string): () => LanguageModel {
  return () => { throw new Error(`the fixture was given no model, so ${name} cannot run a turn`); };
}

/** A head's runtime over its parent's database; a head has no store of its own. */
export async function createHeadRuntime(parent: CLIRuntime, id: string, observer?: WriteObserver) {
  const binding = registerLocalActor(parent.actor, { name: explorationActorKey(id), creationId: id, origin: 'swarm', lifetime: 'task' });
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
    tracing: undefined,
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
    loopFor: (bound) => ({ origin: defaultLoopOrigin(bound.record.origin), parent }),
    orchestrationFor: (bound) => ({
      host: {
        broadcast: (event) => { broadcasts.push(event); },
        enqueueTurn: async () => ({ status: 'skipped' }),
        turnInFlight: () => false,
        setTimer: () => { throw new Error('this fixture host must not schedule background work'); },
      },
      engine: new EvolutionEngine(bound.runtime, historyTurnPairs(bound.stores.history), { enabled: false }),
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
  seat: { readonly writes?: Map<string, WriteObserver>; readonly model?: (spec: string) => LanguageModel } = {},
): (input: HeadInput, observer: WriteObserver) => Promise<HeadSeat> {
  const { writes, model = noModel('a head seat') } = seat;

  return async (input, observer) => {
    const binding = registerLocalActor(parent.actor, {
      name: explorationActorKey(input.id), creationId: input.id, origin: 'swarm', lifetime: 'task',
    });

    const agentName = actorHomeName({ origin: 'swarm', storageKey: binding.storageKey });
    writes?.set(binding.reference.actorId, observer);
    const actor = await host.acquire(binding.reference);

    const authority = parent.profiles;

    if (!authority) throw new Error('the parent runtime carries no profile authority');
    const compaction = fixtureCompaction(actor.record.actorId);

    return {
      actor,
      runId,
      sources: fixtureRunSources(actor, () => authority.inputs(), model, runId),
      infer: (headInput, inference) => runHeadInference(headInput, { ...inference, compaction }),
      conversations: new ConversationSearchStore(actor.runtime.storage.sql, actor.handle, (sessionId) => actor.stores.history.transcript(sessionId)),
      // No workspace routes a fixture seat's jobs: nothing here cancels or recovers them.
      jobs: { ports: { jobOutput: () => {} }, attach: () => () => {} },
      release: async () => {
        host.release(binding.reference);
        writes?.delete(binding.reference.actorId);
        await retireLocalActor(parent.actor, binding.name, binding.reference, async () => {
          cleanupFacetScratch(parent.space, agentName);
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
export function headLoopSeams(
  rt: AgentRuntime,
  at: { readonly runId?: string; readonly handle?: ActorHandle; readonly runtime?: AgentRuntime; readonly model?: () => LanguageModel } = {},
) {
  const { runId = 'fixture-run', handle = rt.actor, runtime = rt, model = noModel('a loop seat') } = at;

  const identity = rt.storage.sql<{ id: string; owner_user_id: string | null }>`
    SELECT id, owner_user_id FROM workspace_identity LIMIT 1`[0];

  if (!identity) throw new Error('this fixture runtime has no workspace identity to host an actor in');

  const directory = new WorkspaceActorDirectory(rt.storage.sql, {
    workspaceId: identity.id, ownerUserId: identity.owner_user_id ?? '',
  });

  // A run records its execution as every actor's turn does.
  initRunEventTables(rt.storage.execRaw);
  const stores = createAgentStores(() => rt.storage.sql, () => handle, rt.storage.transactionSync, async () => ({ vfs: rt.storage.vfs, artifactDirectory: `${WORKSPACE_ROOT}/actors/${handle.actorId}` }));

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
    engine: new EvolutionEngine(rt, historyTurnPairs(stores.history), { enabled: false }),
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

  const actor: HostedActor = {
    reference: actorReferenceOf(handle),
    // `describe` refuses handles issued by another directory, so re-issue through this one.
    record: directory.describe(directory.open(handle.actorId)),
    handle,
    stores,
    runtime,
    session,
  };

  const compaction = fixtureCompaction(handle.actorId);

  return {
    actor,
    runId,
    sources: fixtureRunSources(actor, async () => inputs, model, runId),
    compaction,
    infer: (headInput: HeadInput, inference: Omit<HeadInferenceDeps, 'compaction'>) => runHeadInference(headInput, { ...inference, compaction }),
    conversations: new ConversationSearchStore(runtime.storage.sql, runtime.actor, (sessionId) => stores.history.transcript(sessionId)),
    // No workspace routes a fixture seat's jobs: nothing here cancels or recovers them.
    jobs: { ports: { jobOutput: () => {} }, attach: () => () => {} },
  } satisfies Omit<HeadSeat, 'release'> & Pick<HeadInferenceDeps, 'compaction'>;
}

/** Per-node seat factory: each call registers its own node actor, so wave children never share a claim ledger. */
export function nodeSeatFactory(
  rt: CLIRuntime, runId = 'fixture-run', model: () => LanguageModel = noModel('a node seat'),
): (node: NodeIdentity) => Promise<HostedNodeSeat> {
  return async (node) => {
    const binding = registerLocalActor(rt.actor, { name: explorationActorKey(node.nodeId), creationId: node.nodeId, origin: 'swarm', lifetime: 'task' });
    const handle = bindLocalActor(rt.storage.sql, binding);
    // The host requires the runtime and binding to share one handle. Swarm mode keeps the node off the branching-head runtime.
    const runtime = await buildLocalActorRuntime(rt, { reference: actorReferenceOf(handle), handle }, undefined, true);
    const seams = headLoopSeams(rt, { runId, handle, runtime, model });

    return {
      actor: seams.actor, runId: seams.runId, sources: seams.sources, infer: seams.infer, conversations: seams.conversations, jobs: seams.jobs,
    };
  };
}
