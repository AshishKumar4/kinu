/** An agent's isolate for bun suites: the shipped AgentFacet in this process over its own database. */
import { Database } from 'bun:sqlite';
import type { AgentContext } from 'agents';
import { AgentFacet, type AgentFacetEnv } from '../../src/agent-facet/agent-facet';
import { AgentDatabase } from '../../src/agent-facet/agent-database';
import type { HostedSession } from '@nimbus-sh/worker/workspace-host';
import { agentStateShellId, type AgentFacetPlacement, type AgentWorkspaceHost } from '../../src/agent-facets';

const databases = new Map<string, Database>();

export interface InProcessAgentFacets {
  open(placement: AgentFacetPlacement, workspace: AgentWorkspaceHost): Promise<AgentFacet>;
  drop(storageKey: string): void;
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
  new AgentDatabase(contextOver(db, storageKey).storage, { agent: unreachable, state: unreachable, enqueueTurn: unreachable, memory: unreachable, program: unreachable, sayToParent: unreachable });

  return db;
}

export function inProcessAgentFacets(makeCtx: (db: Database, id: string) => AgentContext): InProcessAgentFacets {
  const live = new Map<string, AgentFacet>();
  const traceCalls: string[] = [];

  contextOver = makeCtx;

  return {
    open: async (placement, host) => {
      const held = live.get(placement.storageKey);

      if (held !== undefined) return held;
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
          profile: (turnId, tools, mode) => host.profile(turnId, tools, mode),
          advise: (review) => host.advise(review),
          enqueueTurn: (input) => host.enqueueTurn(input),
          executeTool: (call) => host.executeTool(call),
          observe: (lines, call) => host.observe(lines, call),
          answerMetadata: (turnId, narration) => host.answerMetadata(turnId, narration),
          finishTurn: (turnId, end) => host.finishTurn(turnId, end),
          failTurn: (turnId, failure) => host.failTurn(turnId, failure),
          getAuth: (key, opts) => host.getAuth(key, opts),
          listCredentials: () => host.listCredentials(),
          relayDevice: (provider) => host.relayDevice(provider),
          relayModelCall: (deviceId, callId, request) => host.relayModelCall(deviceId, callId, request),
          cancelModelRelay: (callId) => host.cancelModelRelay(callId),
          forwardCodex: (callId, request) => host.forwardCodex(callId, request),
          cancelCodex: (callId) => host.cancelCodex(callId),
          sayToParent: (signal) => host.sayToParent(signal),
        },
        WORKSPACE_NAME: placement.workspaceName,
        SHELL_ID: placement.shellId,
        HOME: placement.home,
        STATE_SHELL_ID: agentStateShellId(placement.storageKey),
        ...placement.providers,
      };

      const facet = new AgentFacet(makeCtx(db, placement.storageKey), env);

      live.set(placement.storageKey, facet);

      return facet;
    },
    reset: (storageKey) => { live.delete(storageKey); },
    traceCalls: () => traceCalls,
    drop: (storageKey) => {
      live.delete(storageKey);
      databases.get(storageKey)?.close();
      databases.delete(storageKey);
    },
  };
}
