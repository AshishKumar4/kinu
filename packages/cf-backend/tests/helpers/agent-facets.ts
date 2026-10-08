/** An agent's isolate for bun suites: the shipped AgentFacet in this process over its own database. */
import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { WORKSPACE_ROOT } from '@kinu.run/core';
import * as shippedRegistry from '../../src/providers/agent-registry';
import type { AgentContext } from 'agents';
import { AgentFacet, type AgentFacetCalls, type AgentFacetEnv } from '../../src/agent-facet/agent-facet';
import { agentCallsThrough } from '../../src/dynamic-worker-slots';
import { attemptInItsWords } from '@kinu.run/core/obs';
import { AgentDatabase } from '../../src/agent-facet/agent-database';
import type { HostedSession } from '@nimbus-sh/worker/workspace-host';
import { agentStateShellId, type AgentFacetPlacement, type AgentWorkspaceHost } from '../../src/agent-facets';

const databases = new Map<string, Database>();

/** Models a suite scripts, by the conversation (`agentAffinityKey`) their calls are routed under. */
const scriptedModels = new Map<string, () => LanguageModel>();

const shippedProviderRegistry = shippedRegistry.createAgentProviderRegistry;

// An agent's isolate resolves its models through the shipped registry; a model a suite scripts for its conversation is
// answered first. Harness only: production holds no hook for it.
const registered = mock.module('../../src/providers/agent-registry', () => ({
  ...shippedRegistry,
  createAgentProviderRegistry: (deps: shippedRegistry.AgentProviderDeps): shippedRegistry.AgentProviderRegistry => {
    const registry = shippedProviderRegistry(deps);

    return { ...registry, resolveModel: (spec, conversation) => scriptedModels.get(conversation)?.() ?? registry.resolveModel(spec, conversation) };
  },
}));

if (registered !== undefined) throw new Error('mock.module(agent-registry) must register synchronously');

/** Every model call routed under `conversation`, in any isolate, is answered by `model`; null answers it as shipped. */
export function scriptConversationModel(conversation: string, model: (() => LanguageModel) | null): void {
  if (model === null) scriptedModels.delete(conversation);
  else scriptedModels.set(conversation, model);
}

export interface InProcessAgentFacets {
  open(placement: AgentFacetPlacement, workspace: AgentWorkspaceHost): Promise<AgentFacetCalls>;
  drop(storageKey: string): void;
  /** Every open agent's chat runs nothing, its settled turns' effects have closed, and it told its workspace so. */
  idle(): Promise<void>;
  reset(storageKey: string): void;
  /** Every live-output call an agent's isolate made to the workspace, in order: each is an RPC in production. */
  traceCalls(): readonly string[];
}

function unreachable(): never {
  throw new Error('a schema-only agent database reached the workspace');
}

async function sessionOrFailure(open: Promise<HostedSession>): Promise<() => HostedSession> {
  try {
    const session = await open;

    return () => session;
  } catch (cause) {
    return () => { throw cause; };
  }
}

let contextOver: ((db: Database, id: string) => AgentContext) | null = null;

export function agentDatabase(storageKey: string): Database {
  const held = databases.get(storageKey);

  if (held !== undefined) return held;

  if (contextOver === null) throw new Error('no harness has been built, so no agent database can be');
  const db = new Database(':memory:');

  databases.set(storageKey, db);
  new AgentDatabase(contextOver(db, storageKey).storage, { agent: unreachable, home: WORKSPACE_ROOT, state: unreachable, enqueueTurn: unreachable, turnInFlight: () => false, memory: unreachable, program: unreachable, sayToParent: unreachable });

  return db;
}

export function inProcessAgentFacets(makeCtx: (db: Database, id: string) => AgentContext): InProcessAgentFacets {
  const live = new Map<string, OpenFacet>();
  // Two calls that race to open one agent reach one isolate, as a stub's do.
  const opening = new Map<string, Promise<OpenFacet>>();
  const traceCalls: string[] = [];

  contextOver = makeCtx;
  // A new workspace answers its model calls as shipped until its suite scripts them.
  scriptedModels.clear();

  return {
    open: async (placement, host) => {
      const key = placement.storageKey;

      const held = opening.get(key) ?? openFacet(placement, host).then((opened) => {
        live.set(key, opened);

        return opened;
      });

      opening.set(key, held);

      return (await held).calls;
    },
    reset: (storageKey) => {
      live.get(storageKey)?.lost.abort(new Error("the agent's isolate reset"));
      live.delete(storageKey);
      opening.delete(storageKey);
    },
    traceCalls: () => traceCalls,
    idle: async () => { await Promise.all([...live.values()].map(({ facet }) => facet.idle())); },
    drop: (storageKey) => {
      live.delete(storageKey);
      opening.delete(storageKey);
      databases.get(storageKey)?.close();
      databases.delete(storageKey);
    },
  };

  async function openFacet(placement: AgentFacetPlacement, host: AgentWorkspaceHost) {
      const db = agentDatabase(placement.storageKey);
      const session = await sessionOrFailure(host.session());
      const stateSession = await sessionOrFailure(host.stateSession());

      const env: AgentFacetEnv = {
        WORKSPACE: {
          session,
          stateSession,
          memory: () => host.memory(),
          program: (...args) => host.program(...args),
          traceTurn: (...args) => {
            traceCalls.push('traceTurn');

            return host.traceTurn(...args);
          },
          traceStream: (...args) => {
            traceCalls.push('traceStream');

            return host.traceStream(...args);
          },
          resume: (turnId) => host.resume(turnId),
          guard: (...args) => host.guard(...args),
          debit: (...args) => host.debit(...args),
          prepareTurn: (turnId) => host.prepareTurn(turnId),
          prepareChat: (request) => host.prepareChat(request),
          bindProfile: (turnId, profile) => host.bindProfile(turnId, profile),
          chatEvent: (event) => host.chatEvent(event),
          turnEnded: (event, figures) => host.turnEnded(event, figures),
          owedReport: (...args) => host.owedReport(...args),
          parentReport: (report) => host.parentReport(report),
          autoTitle: (subject, title) => host.autoTitle(subject, title),
          turnSettled: (settled) => host.turnSettled(settled),
          hireAdvisor: (advisor) => host.hireAdvisor(advisor),
          owes: (next, holds) => host.owes(next, holds),
          birthContext: (drainTurnId) => host.birthContext(drainTurnId),
          steerSkills: (text, alreadyActive) => host.steerSkills(text, alreadyActive),
          advise: (review) => host.advise(review),
          enqueueTurn: (input) => host.enqueueTurn(input),
          executeTool: (call) => host.executeTool(call),
          observe: (lines) => host.observe(lines),
          answerMetadata: (turnId, narration) => host.answerMetadata(turnId, narration),
          getAuth: (key, opts) => host.getAuth(key, opts),
          listCredentials: () => host.listCredentials(),
          relayDevice: (provider) => host.relayDevice(provider),
          relayModelCall: (deviceId, callId, request) => host.relayModelCall(deviceId, callId, request),
          cancelModelRelay: (callId) => host.cancelModelRelay(callId),
          sayToParent: (signal) => host.sayToParent(signal),
          reportModelCall: (report) => host.reportModelCall(report),
          reportModelOperation: (event) => host.reportModelOperation(event),
        },
        WORKSPACE_NAME: placement.workspaceName,
        SHELL_ID: placement.shellId,
        HOME: placement.home,
        STATE_SHELL_ID: agentStateShellId(placement.storageKey),
        ...placement.providers,
      };

      const facet = new AgentFacet(makeCtx(db, placement.storageKey), env);
      const lost = new AbortController();

      // A reset isolate fails every call it still held, as a dropped RPC does; a refusal crosses in its own words, as an
      // error thrown across an RPC does.
      const calls = agentCallsThrough((call) => attemptInItsWords('io', () => untilLost(call(facet), lost.signal)));

      return { facet, calls, lost };
  }
}

interface OpenFacet {
  readonly facet: AgentFacet;
  readonly calls: AgentFacetCalls;
  readonly lost: AbortController;
}

async function untilLost<A>(work: Promise<A>, lost: AbortSignal): Promise<A> {
  const reset = Promise.withResolvers<never>();
  const cut = (): void => { reset.reject(lost.reason); };

  lost.addEventListener('abort', cut, { once: true });

  try {
    return await Promise.race([work, reset.promise]);
  } finally {
    lost.removeEventListener('abort', cut);
  }
}
