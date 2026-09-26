/**
 * The Durable Object RPC boundary: TS `private` is erased and workerd resolves `stub.foo()` on the prototype chain.
 * Measured on workerd 1.20260601.1, DO to DO: prototype members resolve; own instance properties reject with `The RPC receiver does not implement the method "x".`
 */
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import {
  ORCHESTRATOR_RPC_SURFACE,
  USER_DO_RPC_SURFACE,
  sealRpcSurface,
  type UserDoRpcMethod,
} from '../src/rpc-surface';
import { AGENT_RPC_ACCESS } from '@kinu.run/core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeJsonValue, type JsonValue } from '@kinu.run/core';
import type { Agent } from 'agents';
import * as v from 'valibot';
import type { OrchestratorAgent } from '../src/orchestrator';
import type { UserDO } from '../src/user/user-do';
import type { FilesRouteAgent } from '../src/files-routes';
import type { TerminalWorkspace } from '../src/terminal-route';
import { orchestratorHarness, rpcReachableFrom, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { declaredName, memberCalleeName, parse, walk } from '../../../scripts/syntax';

// After the helpers register the SDK mock: a static import would bind these to the real `agents` Agent.
const { ActorAgent } = await import('../src/actor-agent');

const { OrchestratorAgent: OrchestratorAgentClass } = await import('../src/orchestrator');

/** Methods called on a binding named `…stub` or `…Stub` inside `getAgentByName`, read from the parsed module;
 *  undefined when the module declares no such function. */
function stubCallsIn(file: string, source: string): string[] | undefined {
  let calls: string[] | undefined;

  walk(parse(file, source).root, (node) => {
    if (node.type !== 'FunctionDeclaration' || declaredName(node) !== 'getAgentByName') return;
    const found: string[] = [];

    walk(node, (inner) => {
      const method = memberCalleeName(inner);
      const { raw } = inner;

      if (method === undefined || raw.type !== 'CallExpression' || raw.callee.type !== 'MemberExpression') return;
      const { object } = raw.callee;

      if (object.type === 'Identifier' && object.name.toLowerCase().endsWith('stub')) found.push(method);
    });
    calls = found;
  });

  return calls;
}

type UserDOInstance = ReturnType<typeof createTestUserDO>['userDO'];

type RpcTarget = UserDOInstance | HarnessOrchestratorAgent | Leaf | Middle2;

/** What a stub-holder gets. Denial reproduces workerd's own wording. */
async function callOverRpc(target: RpcTarget, method: string, args: JsonValue[]) {
  if (!rpcReachableFrom(target).includes(method)) {
    throw new Error(`The RPC receiver does not implement the method "${method}".`);
  }

  let owner: object | null = target;

  while (owner) {
    const callable = v.safeParse(
      v.function(),
      Object.getOwnPropertyDescriptor(owner, method)?.value,
    );

    if (callable.success) {
      return decodeJsonValue({ value: await callable.output.call(target, ...args) });
    }

    owner = Object.getPrototypeOf(owner);
  }

  throw new Error(`The RPC receiver does not implement the method "${method}".`);
}

/** Undo the seal on one instance, so "the guard is what stops this" is asserted rather than assumed. */
function unsealRpcSurface(instance: UserDOInstance): void {
  const prototype = Object.getPrototypeOf(instance);

  if (!prototype) throw new Error('UserDO prototype is missing');

  const shadowed = Object.getOwnPropertyNames(instance)
    .filter((name) => name in prototype);

  for (const name of shadowed) Reflect.deleteProperty(instance, name);
}

describe('the UserDO capability gate is reachable-surface enforced, not advisory', () => {
  test('an internal call steals credentials without the seal, and cannot reach them with it', async () => {
    const harness = createTestUserDO();
    await provisionTestWorkspace(harness, 'alpha');
    await harness.userDO.setCredential(await testOwner(), 'github', { kind: 'bearer', token: 'ghp_the_owners_pat' });

    // `sqlx` is TS-private, so an ordinary prototype method at runtime, outside every `requireTier` check.
    unsealRpcSurface(harness.userDO);
    const stolenBySql = await callOverRpc(harness.userDO, 'sqlx', ['SELECT value FROM user_credentials WHERE key = ?', 'github']);
    expect(JSON.stringify(stolenBySql)).not.toContain('ghp_the_owners_pat');
    const stolenByRow = await callOverRpc(harness.userDO, 'readCredential', ['github']);
    expect(stolenByRow).toMatchObject({ token: 'ghp_the_owners_pat' });

    sealRpcSurface(harness.userDO, USER_DO_RPC_SURFACE);
    await expect(callOverRpc(harness.userDO, 'sqlx', ['SELECT value FROM user_credentials']))
      .rejects.toThrow('The RPC receiver does not implement the method "sqlx".');
    await expect(callOverRpc(harness.userDO, 'readCredential', ['github']))
      .rejects.toThrow('The RPC receiver does not implement the method "readCredential".');
    harness.close();
  });

  test('a UserDO seals itself — no test may reconstruct the boundary for it', async () => {
    const harness = createTestUserDO();
    await harness.userDO.setCredential(await testOwner(), 'github', { kind: 'bearer', token: 'ghp_untouched' });

    for (const internal of ['sqlx', 'readCredential', 'writeCredential', 'requireTier', 'ensureInit']) {
      await expect(callOverRpc(harness.userDO, internal, [])).rejects.toThrow('does not implement');
    }

    harness.close();
  });

  test('the gated surface still answers, and still gates', async () => {
    const harness = createTestUserDO();
    const token = await provisionTestWorkspace(harness, 'alpha');

    expect(await callOverRpc(harness.userDO, 'listWorkspaces', [await testOwner()]))
      .toMatchObject({ entries: [{ name: 'alpha' }], total: 1 });
    await expect(callOverRpc(harness.userDO, 'listCredentials', [{ workspaceToken: token }]))
      .resolves.toEqual([]);
    harness.close();
  });

  test('the seal leaves the class working from the inside', async () => {
    const harness = createTestUserDO();
    await harness.userDO.setCredential(await testOwner(), 'github', { kind: 'bearer', token: 'ghp_internal' });
    expect(await harness.userDO.listCredentials(await testOwner())).toMatchObject([{ key: 'github' }]);
    expect(await harness.userDO.getAuthHeaders(await testOwner(), 'github'))
      .toEqual({ Authorization: 'Bearer ghp_internal' });
    await harness.userDO.deleteCredential(await testOwner(), 'github');
    expect(await harness.userDO.listCredentials(await testOwner())).toEqual([]);
    harness.close();
  });
});

// An allowlist is only fail-closed if it cannot drift from the class. The compiler holds the lists to
// the classes' public members; a sealed instance shows what a stub-holder reaches.

/** Public methods a class declares above `Base`. */
type OwnPublicMethods<T, Base> = {
  [K in Exclude<keyof T, keyof Base>]: T[K] extends (...args: never[]) => void ? K : never
}[Exclude<keyof T, keyof Base>];

/** `true` when `Names` is empty; otherwise the names, so the compiler error lists them. */
type NoneOf<Names> = [Names] extends [never] ? true : Names;

/** Public because the SDK base calls them in process (`agents/dist/src-5W6JNKVb.js:823`), so they cannot be
 *  `protected`. Not on the surface: the seal shadows each. */
const SDK_HOOK_OVERRIDES = ['createMcpOAuthProvider'] as const satisfies readonly (keyof UserDO)[];

// Every public UserDO method is listed, or is an SDK hook the seal shadows on purpose.
const everyUserDoMethodListed: NoneOf<Exclude<
  OwnPublicMethods<UserDO, Agent<Env>>, UserDoRpcMethod | (typeof SDK_HOOK_OVERRIDES)[number]
>> = true;

// Every CLI-dispatched name is a public orchestrator member: a private or deleted one fails here.
const everyDispatchedNameIsPublic: NoneOf<Exclude<keyof typeof AGENT_RPC_ACCESS, keyof OrchestratorAgent>> = true;

/** Exactly the methods each Worker route is typed to call on the orchestrator stub. */
const FILES_ROUTE_CALLS = {
  startExecutorFileDownload: true, readExecutorFileChunk: true, abortExecutorFileDownload: true,
  writeExecutorFileChunk: true, abortExecutorFileWrite: true,
} as const satisfies Record<keyof FilesRouteAgent, true>;

const TERMINAL_ROUTE_CALLS = {
  prepareTerminal: true, openDeviceTerminal: true, fetch: true,
} as const satisfies Record<keyof TerminalWorkspace, true>;

describe('the UserDO RPC surface cannot drift from the class', () => {
  test('the compiler holds every public method to the surface', () => {
    expect([everyUserDoMethodListed, everyDispatchedNameIsPublic]).toEqual([true, true]);
  });

  test('a base-declared hook override is public in TypeScript and sealed over RPC', async () => {
    const harness = createTestUserDO();

    for (const name of SDK_HOOK_OVERRIDES) {
      await expect(callOverRpc(harness.userDO, name, ['https://kinu.example/callback']))
        .rejects.toThrow(`The RPC receiver does not implement the method "${name}".`);
    }

    harness.close();
  });

  test('a UserDO instance reaches no further than its declared surface', () => {
    const harness = createTestUserDO();
    const beyond = rpcReachableFrom(harness.userDO).filter((n) => !USER_DO_RPC_SURFACE.includes(n));
    expect(beyond).toEqual([]);
    harness.close();
  });
});

/** The names Cloudflare's runtime invokes on a Durable Object: its fetch, alarm and hibernation handlers. */
const RUNTIME_HANDLERS = ['fetch', 'alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError'];

/** Inherited members that make an unsealed DO a liability: the SDK's sql runner, storage teardown, state writer and method bridges. */
const MUST_STAY_DENIED = [
  'sql', 'destroy', 'setState', 'stash',
  '_cf_invokeSubAgent', '_cf_invokeSubAgentPath', '_cf_invokeAgentPath', '_cf_invokeStubMethod',
];

const SEALED_SURFACES = [
  ['UserDO', USER_DO_RPC_SURFACE],
  ['OrchestratorAgent', ORCHESTRATOR_RPC_SURFACE],
] as const;

describe('every Durable Object that holds something worth stealing is sealed', () => {
  test('an OrchestratorAgent seals itself: a stub-holder reaches only its surface', () => {
    const reachable = rpcReachableFrom(orchestratorHarness().agent);

    expect(reachable.filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name))).toEqual([]);
    // What the seal keeps is what a caller needs: the CLI transport's table resolves on the instance.
    expect(Object.keys(AGENT_RPC_ACCESS).filter((name) => !reachable.includes(name))).toEqual([]);
  });

  test.each(SEALED_SURFACES)('%s denies the inherited members that matter', (_name, surface) => {
    expect(MUST_STAY_DENIED.filter((name) => surface.includes(name))).toEqual([]);
  });

  test.each(SEALED_SURFACES)('%s carries the runtime handlers it is dispatched on', (_name, surface) => {
    expect(RUNTIME_HANDLERS.filter((name) => !surface.includes(name))).toEqual([]);
  });
});

describe('the agent surfaces cannot drift from their callers', () => {
  /** Reached by a stub inside this Worker, never for a client: the MCP adapter's scaffold run. */
  const internalOrchestratorRpc = ['runScaffoldOnce'] as const;

  test('the orchestrator keeps every method the CLI transport dispatches onto it', () => {
    // cli/routes.ts calls `stub[method](...)` for each key of this table, so a
    // key missing from the surface is a broken CLI command, not a safe default.
    const missing = Object.keys(AGENT_RPC_ACCESS).filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name));
    expect(missing.sort()).toEqual([]);
  });

  test('worker routes call only methods a sealed orchestrator answers', () => {
    const reachable = rpcReachableFrom(orchestratorHarness().agent);
    const called = [...Object.keys(FILES_ROUTE_CALLS), ...Object.keys(TERMINAL_ROUTE_CALLS)];

    expect(called.filter((name) => !reachable.includes(name))).toEqual([]);
  });

  test('internal cross-DO methods stay sealed from client RPC', () => {
    expect(internalOrchestratorRpc.filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name)))
      .toEqual([]);
    expect(internalOrchestratorRpc.filter((name) => Object.hasOwn(AGENT_RPC_ACCESS, name)))
      .toEqual([]);
  });

  /**
   * The control plane lives on the substrate once; a copy on the root lets two implementations drift.
   * Behaviour is pinned in unit-actor-control-plane.test.ts and unit-actor-transcript-page.test.ts.
   */
  test('the shared control plane is declared on ActorAgent and not on the root', () => {
    const shared = ['getStoredModelSpec', 'setModel', 'send', 'cancelCurrentWork', 'getChatHistoryPage'];

    expect(shared.filter((name) => !Object.hasOwn(ActorAgent.prototype, name))).toEqual([]);
    expect(shared.filter((name) => Object.hasOwn(OrchestratorAgentClass.prototype, name))).toEqual([]);
  });
});

// The facet protocol and stub entry point are the SDK's to rename and the seal is fail-closed, so both lists derive from installed `agents/dist`.

const AGENTS_DIST = join(import.meta.dir, '..', '..', '..', 'node_modules', 'agents', 'dist');

/** Every non-map JavaScript file under `agents/dist`, read once. */
function installedAgentsSources(): string[] {
  return readdirSync(AGENTS_DIST, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(AGENTS_DIST, file), 'utf8'));
}

/** `_cf_` names the SDK invokes on a receiver other than `this` (or a same-file `const x = this` alias). */
function crossStubFacetNames(sources: readonly string[]): string[] {
  const names = new Set<string>();

  for (const src of sources) {
    const selfAliases = new Set([...src.matchAll(/\bconst (\w+) = this;/g)].map((m) => m[1]));

    for (const line of src.split('\n')) {
      for (const match of line.matchAll(/\.(_cf_\w+)\s*\(/g)) {
        const name = match[1];

        if (name === undefined || match.index === undefined) continue;
        const receiver = line.slice(0, match.index).trim();
        const token = receiver.slice(receiver.search(/[\w$)\]]+$/));

        if (/(^|[^\w$])this$/.test(receiver) || selfAliases.has(token)) continue;
        names.add(name);
      }
    }
  }

  return [...names].sort();
}

/** Takes a method NAME and calls it on the receiver: listing one re-opens
 *  everything the seal closes, so each stays off the surface on purpose. */
const UNIVERSAL_BRIDGES = ['_cf_invokeSubAgent', '_cf_invokeSubAgentPath', '_cf_invokeAgentPath'];

/** Invoked over a stub only by `McpAgent`'s serve path; no Kinu class is one. */
const MCP_AGENT_ONLY = ['_cf_scheduleDestroy'];

describe('the SDK half of the surface is derived from the installed agents package', () => {
  const sources = installedAgentsSources();

  test('the orchestrator carries exactly the cross-stub facet protocol, minus the bridges; the UserDO none', () => {
    const derived = crossStubFacetNames(sources)
      .filter((name) => !UNIVERSAL_BRIDGES.includes(name) && !MCP_AGENT_ONLY.includes(name));

    // The scan must SEE the protocol: a dist layout it no longer parses would
    // otherwise derive an empty list and hold the surface to nothing.
    expect(derived.length).toBeGreaterThan(10);
    expect(ORCHESTRATOR_RPC_SURFACE.filter((name) => name.startsWith('_cf_')).sort()).toEqual(derived);
    // A facet and its root call these on each other across a real stub; the UserDO is neither.
    expect(USER_DO_RPC_SURFACE.filter((name) => name.startsWith('_cf_'))).toEqual([]);
  });

  test('the bridges and the McpAgent-only name are still what the SDK calls over a stub', () => {
    // The exclusions above are claims about the SDK; a release that drops one
    // makes the exclusion dead, and one that adds a fifth bridge must be read.
    const all = crossStubFacetNames(sources);

    for (const name of [...UNIVERSAL_BRIDGES, ...MCP_AGENT_ONLY]) expect(all).toContain(name);
  });

  test('a stub call is read from the parsed function, however it is laid out', () => {
    const source = [
      'async function getAgentByName(namespace, name) {',
      '  const stub = namespace.get(namespace.idFromName(name));',
      '  if (name) {',
      '}',
      '  await stub',
      '    .setName(name);',
      '  await stub?.warm();',
      '  return stub;',
      '}',
    ].join('\n');

    expect(stubCallsIn('routing.js', source)).toEqual(['setName', 'warm']);
  });

  test('every sealed surface carries the one name getAgentByName calls on the stub', () => {
    const calledOnStub = stubCallsIn('agent-routing.js', readFileSync(join(AGENTS_DIST, 'agent-routing.js'), 'utf8'));

    if (calledOnStub === undefined) throw new Error('getAgentByName is not declared in agents/dist/agent-routing.js');

    expect(calledOnStub.length).toBeGreaterThan(0);

    for (const [, surface] of SEALED_SURFACES) {
      expect(calledOnStub.filter((name) => !surface.includes(name))).toEqual([]);
    }
  });
});

// Facet-to-root reachability is measured by tests/workerd/plan-announce-probe.ts against a real sealed root.

// `UserDO`'s bases are stubbed under bun, so the inherited half of the surface is exercised on a hierarchy shaped like the real one.

class ThirdPartyBase {
  sql(strings: TemplateStringsArray, ...values: unknown[]): string {
    return `RAN ${strings.join('?')} ${JSON.stringify(values)}`;
  }
  baseUsesSql(): string {
    const id = 7;

    return this.sql`SELECT ${id}`;
  }
  get liveState(): string { return 'state'; }
  overridable(): string { return 'base'; }
}

abstract class Middle extends ThirdPartyBase {
  protected sharedWithSubclasses(): string { return 'protected value'; }
  publicApi(): string { return `api(${this.sharedWithSubclasses()})`; }
}

const callableRegistry = new WeakMap<object, string>();

class Leaf extends Middle {
  readonly #secret = 'hidden';
  constructor() {
    super();
    callableRegistry.set(this.markedCallable, 'metadata');
    sealRpcSurface(this, ['publicApi', 'markedCallable', 'overridable']);
  }
  private leafInternal(): string { return this.#secret; }
  markedCallable(this: void): string { return 'callable'; }
  override overridable(): string { return `leaf -> ${super.overridable()}`; }
  selfCheck() {
    return {
      internal: this.leafInternal(),
      protectedViaThis: this.sharedWithSubclasses(),
      baseUsesSql: this.baseUsesSql(),
      getter: this.liveState,
      override: this.overridable(),
      callableIdentityKept: callableRegistry.has(this.markedCallable),
    };
  }
}

describe('sealRpcSurface', () => {
  test('an unsealed class exposes its whole chain, including the SDK query runner', async () => {
    const open = new Middle2();
    expect(rpcReachableFrom(open)).toEqual([
      'baseUsesSql', 'liveState', 'overridable', 'publicApi', 'sharedWithSubclasses', 'sql',
    ]);
    expect(await callOverRpc(open, 'sql', [['SELECT * FROM user_credentials']]))
      .toBe('RAN SELECT * FROM user_credentials []');
  });

  test('a sealed class exposes exactly its surface', () => {
    expect(rpcReachableFrom(new Leaf())).toEqual(['markedCallable', 'overridable', 'publicApi']);
  });

  test('inherited members, protected members and TypeScript privates are all denied', async () => {
    const leaf = new Leaf();

    for (const name of ['sql', 'baseUsesSql', 'liveState', 'sharedWithSubclasses', 'leafInternal', 'selfCheck']) {
      await expect(callOverRpc(leaf, name, [])).rejects.toThrow(`does not implement the method "${name}"`);
    }
  });

  test('nothing about the instance changes from the inside', () => {
    const leaf = new Leaf();
    expect(leaf.selfCheck()).toEqual({
      internal: 'hidden',
      protectedViaThis: 'protected value',
      baseUsesSql: 'RAN SELECT ? [7]',
      getter: 'state',
      override: 'leaf -> base',
      callableIdentityKept: true,
    });
  });

  test('sealed members stay invisible to enumeration', () => {
    const leaf = new Leaf();
    expect(Object.keys(leaf)).toEqual([]);
    expect(Object.keys(Object.assign({}, leaf))).toEqual([]);
  });

  test('a surface entry the class does not have is ignored, not trusted', async () => {
    const open = new Middle2();
    sealRpcSurface(open, ['publicApi', 'noSuchMethod']);
    expect(rpcReachableFrom(open)).toEqual(['publicApi']);
    await expect(callOverRpc(open, 'noSuchMethod', [])).rejects.toThrow('does not implement');
  });
});

/** A concrete `Middle`, for the unsealed baseline. */
class Middle2 extends Middle {}
