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
} from '../src/rpc-surface';
import { AGENT_RPC_ACCESS } from '../src/cli/rpc-gate';
import { declaredClassMembers, isInternalMember } from './helpers/declared-members';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeJsonValue, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';

type UserDOInstance = ReturnType<typeof createTestUserDO>['userDO'];

type RpcTarget = UserDOInstance | Leaf | Middle2;


/** workerd's stub-resolution rule, stated independently of `sealRpcSurface`; the mechanism tests pin the two together. */
function rpcReachableNames(target: RpcTarget): string[] {
  const own = new Set(Object.getOwnPropertyNames(target));
  const reachable = new Set<string>();

  for (let proto: object | null = Object.getPrototypeOf(target);
       proto !== null && proto !== Object.prototype;
       proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor' && !own.has(name)) reachable.add(name);
    }
  }

  return [...reachable].sort();
}

/** Read from the one declaration in src/rpc-surface.ts; a pattern that stops matching throws rather than passing on an empty list. */
function surfaceLiteral(constName: string): string[] {
  const body = source('rpc-surface.ts').match(
    new RegExp(`const ${constName}[^=]*= \\[([\\s\\S]*?)\\] as const`),
  )?.[1];

  if (!body) throw new Error(`surface literal ${constName} is not declared in rpc-surface.ts`);

  return [...body.matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

/** What a stub-holder gets. Denial reproduces workerd's own wording. */
async function callOverRpc(target: RpcTarget, method: string, args: JsonValue[]) {
  if (!rpcReachableNames(target).includes(method)) {
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

// An allowlist is only fail-closed if it cannot drift from the class, so these read the source.

const declaredMembers = declaredClassMembers(
  readFileSync(join(import.meta.dir, '..', 'src', 'user', 'user-do.ts'), 'utf8'),
);

/** Public because the SDK base calls them in process (`agents/dist/src-5W6JNKVb.js:823`), so they cannot be
 *  `protected`. Not on the surface: the seal shadows each. */
const SDK_HOOK_OVERRIDES = ['createMcpOAuthProvider'];

describe('the UserDO RPC surface cannot drift from the class', () => {
  test('every public member is on the surface', () => {
    const missing = declaredMembers
      .filter((m) => !isInternalMember(m))
      .map((m) => m.name)
      .filter((name) => !USER_DO_RPC_SURFACE.includes(name) && !SDK_HOOK_OVERRIDES.includes(name));

    expect(missing.sort()).toEqual([]);
  });

  test('a base-declared hook override is public in TypeScript and sealed over RPC', async () => {
    const harness = createTestUserDO();

    for (const name of SDK_HOOK_OVERRIDES) {
      expect(declaredMembers.some((m) => m.name === name && !isInternalMember(m))).toBe(true);
      await expect(callOverRpc(harness.userDO, name, ['https://kinu.example/callback']))
        .rejects.toThrow(`The RPC receiver does not implement the method "${name}".`);
    }

    harness.close();
  });

  test('no internal member is on the surface', () => {
    const leaked = declaredMembers
      .filter(isInternalMember)
      .map((m) => m.name)
      .filter((name) => USER_DO_RPC_SURFACE.includes(name));

    expect(leaked.sort()).toEqual([]);
  });

  test('the surface names nothing the class does not have', () => {
    const declared = new Set(declaredMembers.map((m) => m.name));

    const stale = USER_DO_RPC_SURFACE
      .filter((name) => !PLATFORM_RPC_SURFACE.includes(name))
      .filter((name) => !declared.has(name));

    expect(stale.sort()).toEqual([]);
  });

  test('the check sees the member shapes someone might actually add', () => {
    // A regex matching only `async foo(` would miss getters, generics, plain and `private` methods.
    const named = (name: string) => declaredMembers.some((m) => m.name === name);
    expect(named('getAuthHeaders')).toBe(true);   // async, no modifier
    expect(named('fetch')).toBe(true);            // override async
    expect(named('sqlx')).toBe(true);             // private, non-async, generic
    expect(named('readCredential')).toBe(true);   // private, async
    expect(named('rewrapCredentials')).toBe(true); // private, non-async, promise-returning
    expect(declaredMembers.filter(isInternalMember).length).toBeGreaterThan(5);
  });

  test('a UserDO instance reaches no further than its declared surface', () => {
    const harness = createTestUserDO();
    const beyond = rpcReachableNames(harness.userDO).filter((n) => !USER_DO_RPC_SURFACE.includes(n));
    expect(beyond).toEqual([]);
    harness.close();
  });
});

// `OrchestratorAgent` cannot be constructed under bun (its base chain reaches cloudflare:*), so its surface is checked as data against the class sources.

const SRC = join(import.meta.dir, '..', 'src');

const source = (file: string) => readFileSync(join(SRC, file), 'utf8');

const PLATFORM_RPC_SURFACE = surfaceLiteral('PLATFORM_RPC_SURFACE');

const AGENTS_FACET_RPC_SURFACE = surfaceLiteral('AGENTS_FACET_RPC_SURFACE');

/** Every Durable Object class in the Worker, and the surface it must seal to.
 *  `KinuSandbox` is the one omission — see the test that pins it. */
const SEALED_CLASSES = [
  { file: 'user/user-do.ts', klass: 'UserDO', constant: 'USER_DO_RPC_SURFACE', surface: USER_DO_RPC_SURFACE },
  { file: 'orchestrator.ts', klass: 'OrchestratorAgent', constant: 'ORCHESTRATOR_RPC_SURFACE', surface: ORCHESTRATOR_RPC_SURFACE },
] as const;

/** Inherited members that make an unsealed DO a liability: the SDK's sql runner, storage teardown, state writer and method bridges. */
const MUST_STAY_DENIED = [
  'sql', 'destroy', 'setState', 'stash',
  '_cf_invokeSubAgent', '_cf_invokeSubAgentPath', '_cf_invokeAgentPath', '_cf_invokeStubMethod',
];

describe('every Durable Object that holds something worth stealing is sealed', () => {
  test.each(SEALED_CLASSES.map((c) => [c.klass, c] as const))(
    '%s seals itself to its own surface',
    (_name, { file, klass, constant }) => {
      const src = source(file);
      // The seal has to run in the class's own constructor: `this`'s prototype
      // chain is only final once the SDK bases have finished with it.
      expect(src).toContain(`export class ${klass} extends`);
      expect(src).toContain(`sealRpcSurface(this, ${constant});`);
    },
  );

  test.each(SEALED_CLASSES.map((c) => [c.klass, c] as const))(
    '%s denies the inherited members that matter',
    (_name, { surface }) => {
      expect(MUST_STAY_DENIED.filter((name) => surface.includes(name))).toEqual([]);
    },
  );

  test.each(SEALED_CLASSES.map((c) => [c.klass, c] as const))(
    '%s carries the platform surface it is dispatched on',
    (_name, { surface }) => {
      expect(PLATFORM_RPC_SURFACE.filter((name) => !surface.includes(name))).toEqual([]);
    },
  );

  test('only the agent family carries the facet protocol', () => {
    for (const { klass, surface } of SEALED_CLASSES) {
      const missing = AGENTS_FACET_RPC_SURFACE.filter((name) => !surface.includes(name));
      // A facet and its root call these on each other across a real stub; the
      // UserDO is neither, so it keeps them closed.
      expect({ klass, missing: missing.length }).toEqual({ klass, missing: klass === 'UserDO' ? AGENTS_FACET_RPC_SURFACE.length : 0 });
    }
  });

  test('KinuSandbox is knowingly left open', () => {
    // Its surface is @cloudflare/sandbox's and it holds no owner credentials; sealing it would pin a third-party API.
    const src = source('kinu-sandbox.ts');
    expect(src).toContain('export class KinuSandbox extends Devbox<Env>');
    expect(src).not.toContain('sealRpcSurface');
  });

  test('no other Durable Object class slipped in unsealed', () => {
    // `Devbox<` too: KinuSandbox extends it rather than `Sandbox<` directly.
    const known = new Set([...SEALED_CLASSES.map((c) => c.klass), 'ActorAgent', 'KinuSandbox']);

    const classes = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...source(f).matchAll(/^export (?:abstract )?class ([A-Za-z0-9_$]+) extends (Agent<|ActorAgent|Sandbox<|Devbox<)/gm)]
        .map((m) => m[1]));

    expect(classes.filter((name) => !known.has(name))).toEqual([]);
    // The scan must match the class it was written for; matching nothing would pass vacuously.
    expect(classes).toContain('KinuSandbox');
  });
});

describe('the agent surfaces cannot drift from their classes', () => {
  const actorMembers = declaredClassMembers(source('actor-agent.ts'));

  /** Reached by a stub inside this Worker, never for a client: the MCP adapter's scaffold run. */
  const internalOrchestratorRpc = ['runScaffoldOnce'] as const;

  test('the orchestrator keeps every method the CLI transport dispatches onto it', () => {
    // cli/routes.ts calls `stub[method](...)` for each key of this table, so a
    // key missing from the surface is a broken CLI command, not a safe default.
    const missing = Object.keys(AGENT_RPC_ACCESS).filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name));
    expect(missing.sort()).toEqual([]);
  });

  /** No subordinate snapshot hop: `subordinateView` reads `actor_id`-scoped config rows, so there is no stub or allowlist entry to drift. */

  test('worker routes call only methods on the orchestrator surface', () => {
    const called = ['terminal-route.ts', 'files-routes.ts'].flatMap((file) =>
      [...source(file).matchAll(/\bagent\.([A-Za-z]\w*)\(/g)]
        .map((match) => match[1])
        .filter((name): name is string => name !== undefined));

    expect(called).toContain('prepareTerminal');
    expect(called).toContain('readExecutorFileChunk');
    expect(called).toContain('writeExecutorFileChunk');
    expect(called.filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name))).toEqual([]);
  });

  test('internal cross-DO methods stay sealed from client RPC', () => {
    expect(internalOrchestratorRpc.filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name)))
      .toEqual([]);
    expect(internalOrchestratorRpc.filter((name) => Object.hasOwn(AGENT_RPC_ACCESS, name)))
      .toEqual([]);
  });

  test('the orchestrator surface names only members it or ActorAgent declares', () => {
    const declared = new Set(
      [...declaredClassMembers(source('orchestrator.ts')), ...actorMembers].map((m) => m.name),
    );

    const stale = ORCHESTRATOR_RPC_SURFACE
      .filter((name) => !PLATFORM_RPC_SURFACE.includes(name) && !AGENTS_FACET_RPC_SURFACE.includes(name))
      .filter((name) => !declared.has(name));

    expect(stale.sort()).toEqual([]);
  });

  test('the orchestrator surface exposes no internal of its own or of ActorAgent', () => {
    const internal = [...declaredClassMembers(source('orchestrator.ts')), ...actorMembers]
      .filter(isInternalMember)
      .map((m) => m.name);

    expect(internal.length).toBeGreaterThan(0);
    expect(internal.filter((name) => ORCHESTRATOR_RPC_SURFACE.includes(name)).sort()).toEqual([]);
  });

  /**
   * The control plane lives on the substrate once; a copy on the root lets two implementations drift.
   * Behaviour is pinned in unit-actor-control-plane.test.ts and unit-actor-transcript-page.test.ts.
   */
  test('the shared control plane is declared on ActorAgent and not on the root', () => {
    const shared = [
      'getStoredModelSpec', 'setModel', 'send', 'cancelCurrentWork', 'getChatHistoryPage',
    ];

    const onActor = actorMembers.map((m) => m.name).filter((name) => shared.includes(name));
    expect(onActor.sort()).toEqual([...shared].sort());

    const redeclared = declaredClassMembers(source('orchestrator.ts'))
      .map((m) => m.name)
      .filter((name) => shared.includes(name));

    expect(redeclared).toEqual([]);
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

  test('the facet surface is exactly the cross-stub protocol, minus the bridges', () => {
    const derived = crossStubFacetNames(sources)
      .filter((name) => !UNIVERSAL_BRIDGES.includes(name) && !MCP_AGENT_ONLY.includes(name));

    // The scan must SEE the protocol: a dist layout it no longer parses would
    // otherwise derive an empty list and hold the surface to nothing.
    expect(derived.length).toBeGreaterThan(10);
    expect(AGENTS_FACET_RPC_SURFACE).toEqual(derived);
  });

  test('the bridges and the McpAgent-only name are still what the SDK calls over a stub', () => {
    // The exclusions above are claims about the SDK; a release that drops one
    // makes the exclusion dead, and one that adds a fifth bridge must be read.
    const all = crossStubFacetNames(sources);

    for (const name of [...UNIVERSAL_BRIDGES, ...MCP_AGENT_ONLY]) expect(all).toContain(name);
  });

  test('the platform surface carries the one name getAgentByName calls on the stub', () => {
    const routing = readFileSync(join(AGENTS_DIST, 'agent-routing.js'), 'utf8');
    const body = routing.match(/async function getAgentByName\([\s\S]*?\n}/)?.[0];

    if (!body) throw new Error('getAgentByName is not declared in agents/dist/agent-routing.js');

    const calledOnStub = [...body.matchAll(/\b\w*[sS]tub\.(\w+)\(/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);

    expect(calledOnStub.length).toBeGreaterThan(0);
    expect(calledOnStub.filter((name) => !PLATFORM_RPC_SURFACE.includes(name))).toEqual([]);
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
    expect(rpcReachableNames(open)).toEqual([
      'baseUsesSql', 'liveState', 'overridable', 'publicApi', 'sharedWithSubclasses', 'sql',
    ]);
    expect(await callOverRpc(open, 'sql', [['SELECT * FROM user_credentials']]))
      .toBe('RAN SELECT * FROM user_credentials []');
  });

  test('a sealed class exposes exactly its surface', () => {
    expect(rpcReachableNames(new Leaf())).toEqual(['markedCallable', 'overridable', 'publicApi']);
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
    expect(rpcReachableNames(open)).toEqual(['publicApi']);
    await expect(callOverRpc(open, 'noSuchMethod', [])).rejects.toThrow('does not implement');
  });
});

/** A concrete `Middle`, for the unsealed baseline. */
class Middle2 extends Middle {}
