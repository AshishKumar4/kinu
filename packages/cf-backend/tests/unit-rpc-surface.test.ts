/**
 * What only the compiler can hold: an allowlist is fail-closed only if it cannot drift from the class. Every public
 * UserDO method is on its surface, every name the CLI transport dispatches is a public orchestrator member, and the
 * Worker routes call only names on the orchestrator's surface. Reachability itself is measured over real stubs in
 * `workerd/orchestrator-seal.test.ts`; workerd test files cannot import the production classes' types.
 */
import { describe, expect, test } from 'bun:test';
import type { Agent } from 'agents';
import { AGENT_RPC_ACCESS } from '@kinu.run/core';
import { ORCHESTRATOR_RPC_SURFACE, type UserDoRpcMethod } from '../src/rpc-surface';
import type { OrchestratorAgent } from '../src/orchestrator';
import type { UserDO } from '../src/user/user-do';
import type { FilesRouteAgent } from '../src/files-routes';
import type { TerminalWorkspace } from '../src/terminal-route';
import { orchestratorHarness } from './helpers/actor-harness';

// After the harness registers the SDK mock: a static import would bind these to the real `agents` Agent.
const { ActorAgent } = await import('../src/actor-agent');

const { OrchestratorAgent: OrchestratorAgentClass } = await import('../src/orchestrator');

/** Public methods a class declares above `Base`. */
type OwnPublicMethods<T, Base> = {
  [K in Exclude<keyof T, keyof Base>]: T[K] extends (...args: never[]) => void ? K : never
}[Exclude<keyof T, keyof Base>];

/** `true` when `Names` is empty; otherwise the names, so the compiler error lists them. */
type NoneOf<Names> = [Names] extends [never] ? true : Names;

/** Public because the SDK base calls it in process, so it cannot be `protected`; the seal shadows it. */
type SdkHookOverride = 'createMcpOAuthProvider';

// Every public UserDO method is listed, or is an SDK hook the seal shadows on purpose.
const everyUserDoMethodListed: NoneOf<Exclude<OwnPublicMethods<UserDO, Agent<Env>>, UserDoRpcMethod | SdkHookOverride>> = true;

// Every CLI-dispatched name is a public orchestrator member: a private or deleted one fails here.
const everyDispatchedNameIsPublic: NoneOf<Exclude<keyof typeof AGENT_RPC_ACCESS, keyof OrchestratorAgent>> = true;

/** Exactly the methods each Worker route is typed to call on the orchestrator stub. */
const ROUTE_CALLS = {
  startExecutorFileDownload: true, readExecutorFileChunk: true, abortExecutorFileDownload: true,
  writeExecutorFileChunk: true, abortExecutorFileWrite: true,
} as const satisfies Record<keyof FilesRouteAgent, true>;

const TERMINAL_CALLS = { prepareTerminal: true, openDeviceTerminal: true, fetch: true } as const satisfies Record<keyof TerminalWorkspace, true>;

describe('the sealed surfaces cannot drift from their classes or their callers', () => {
  test('the compiler holds every public UserDO method and every dispatched name to the surface', () => {
    expect([everyUserDoMethodListed, everyDispatchedNameIsPublic]).toEqual([true, true]);
  });

  test('the Worker routes call only names on the orchestrator surface', () => {
    const called = [...Object.keys(ROUTE_CALLS), ...Object.keys(TERMINAL_CALLS)];

    expect(called.filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name))).toEqual([]);
  });

  // The control plane lives on the substrate once; a copy on the root lets two implementations drift.
  test('the shared control plane is declared on ActorAgent and not on the root', () => {
    orchestratorHarness();
    const shared = ['getStoredModelSpec', 'setModel', 'send', 'cancelCurrentWork', 'getChatHistoryPage'];

    expect(shared.filter((name) => !Object.hasOwn(ActorAgent.prototype, name))).toEqual([]);
    expect(shared.filter((name) => Object.hasOwn(OrchestratorAgentClass.prototype, name))).toEqual([]);
  });
});
