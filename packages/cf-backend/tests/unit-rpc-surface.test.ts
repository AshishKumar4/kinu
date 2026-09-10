/**
 * The Durable Object RPC boundary.
 *
 * `requireTier` gates every public `UserDO` method, but TypeScript `private` is
 * erased at compile time and Cloudflare resolves `stub.foo(...)` against the
 * receiver's prototype chain — so before `sealRpcSurface`, any Durable Object
 * holding a `UserDO` stub could call `sqlx` or `readCredential` directly and
 * never meet a gate. The first test here performs exactly that theft against a
 * real `UserDO` holding a real credential, and then shows the same call denied.
 *
 * Reachability is modelled below by the suite's own statement of workerd's
 * rule, verified against real workerd 1.20260601.1 with one Durable Object
 * calling another. Members anywhere on the prototype chain resolve, including
 * superclass members and TypeScript `private` ones. Own instance properties do
 * not resolve. Workerd rejects those with `The RPC receiver does not implement
 * the method "x".`, the same error it gives for a name that was never
 * declared. The mechanism tests pin that model against `sealRpcSurface` from
 * both directions, so the two cannot drift silently.
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


/**
 * The suite states workerd's stub-resolution rule on its own side. Every member
 * on the prototype chain below `Object.prototype` resolves, minus anything an
 * own instance property shadows. `sealRpcSurface` works from the same rule on
 * the module side. The mechanism tests at the bottom pin the two against each
 * other. A change to one that the other does not share goes red there.
 */
function rpcReachableNames<Target extends object>(target: Target): string[] {
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

/**
 * The platform and facet name lists, read as data out of the one declaration
 * in src/rpc-surface.ts. The drift guards below already read class sources
 * this way, so the suite checks that declaration instead of restating it. A
 * rename or reformat that the pattern no longer matches throws loudly here. It
 * never passes against an empty list.
 */
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

/** Undo the seal on one instance — drops exactly the own properties that shadow
 *  a prototype member, restoring the pre-fix class. Sabotage in a function, so
 *  "the guard is what stops this" is asserted rather than assumed. */
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

    // The hole, demonstrated. `sqlx` is `private` in TypeScript and therefore an
    // ordinary prototype method at runtime; every `requireTier` check sits in a
    // public method above it. Encryption at rest means the stolen row is a
    // sealed envelope rather than the token — but `readCredential` opens it,
    // so the reachable surface is still what has to hold.
    unsealRpcSurface(harness.userDO);
    const stolenBySql = await callOverRpc(harness.userDO, 'sqlx', ['SELECT value FROM user_credentials WHERE key = ?', 'github']);
    expect(JSON.stringify(stolenBySql)).not.toContain('ghp_the_owners_pat');
    const stolenByRow = await callOverRpc(harness.userDO, 'readCredential', ['github']);
    expect(stolenByRow).toMatchObject({ token: 'ghp_the_owners_pat' });

    // The same two calls, once the class's declared surface is enforced.
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

    // A worker route acting for the owner.
    expect(await callOverRpc(harness.userDO, 'listWorkspaces', [await testOwner()]))
      .toMatchObject({ entries: [{ name: 'alpha' }], total: 1 });
    // A workspace presenting its capability token — same transport, still gated.
    await expect(callOverRpc(harness.userDO, 'listCredentials', [{ workspaceToken: token }]))
      .resolves.toEqual([]);
    harness.close();
  });

  test('the seal leaves the class working from the inside', async () => {
    // Every credential path below runs through the sealed `sqlx`, `ensureInit`,
    // `requireTier` and `readCredential` — proving the shadowing changed
    // reachability and nothing else.
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

// ── Completeness ────────────────────────────────────────────────────────────
// An allowlist is only fail-closed if it cannot drift from the class. These read
// the source, so a member added tomorrow is either declared on the surface on
// purpose or unreachable — never quietly reachable.

const declaredMembers = declaredClassMembers(
  readFileSync(join(import.meta.dir, '..', 'src', 'user', 'user-do.ts'), 'utf8'),
);

/** Public because the SDK base declares them public and calls them in
 *  process — `Agent` wires `createMcpOAuthProvider` into its manager's
 *  `createAuthProvider` (`agents/dist/src-5W6JNKVb.js:823`) — so the override
 *  cannot be narrowed to `protected`. Not on the surface: the seal shadows
 *  each, and the test below holds it to that rather than exempting it. */
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
    // Guards the guard: a regex that only matched `async foo(` would let a
    // getter, a generic, a plain method, or a `private` one through unnoticed.
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

// ── The agent family ────────────────────────────────────────────────────────
// ONE actor root, where there were two. `SubordinateAgent` hosted four modes
// behind three exported allowlists, and containment had to be a runtime
// re-seal per family because a stub could reach any method on the class. A
// hosted actor is not addressable over a stub at all — no object to hold a stub
// TO — so `SUBORDINATE_RPC_SURFACE`, `EXPLORATION_RPC_SURFACE` and
// `SUBORDINATE_AGENT_BOOT_SURFACE` are gone with the class they narrowed, and
// containment rides the actor's `actor_id`-scoped rows instead of a seal over a
// wire.
//
// `OrchestratorAgent` cannot be constructed under bun — its base chain reaches
// `cloudflare:*` through `@cloudflare/think` and `@cloudflare/sandbox`. Its
// surface is plain data though, and the class sources are readable, so the same
// two questions get answered: does every class seal itself, and does its
// surface hold only what the class actually declares?

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

/** The inherited members that make an unsealed Durable Object a liability: the
 *  SDK's query runner over the receiver's own storage, its storage-wiping
 *  teardown, its state writer, and the universal method bridges (and their
 *  in-process worker) that would re-open every name this module closes. */
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
    // Its whole RPC surface is @cloudflare/sandbox's, which the preview proxy
    // and the executor call broadly; it holds no owner credentials — the
    // sandbox is where untrusted code was always meant to run. Sealing it
    // would mean pinning a third-party API we do not own.
    const src = source('kinu-sandbox.ts');
    expect(src).toContain('export class KinuSandbox extends Devbox<Env>');
    expect(src).not.toContain('sealRpcSurface');
  });

  test('no other Durable Object class slipped in unsealed', () => {
    // `Devbox<` is in the alternation because KinuSandbox stopped extending
    // `Sandbox<` directly: without it the class this guard was written for
    // dropped out of the scan entirely, and so would any future Durable Object
    // built on the same base.
    const known = new Set([...SEALED_CLASSES.map((c) => c.klass), 'ActorAgent', 'KinuSandbox']);
    const classes = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...source(f).matchAll(/^export (?:abstract )?class ([A-Za-z0-9_$]+) extends (Agent<|ActorAgent|Think<|Sandbox<|Devbox<)/gm)]
        .map((m) => m[1]));
    expect(classes.filter((name) => !known.has(name))).toEqual([]);
    // The scan must actually SEE the class it was written for. An alternation
    // that no longer matches any base is a guard that passes by finding
    // nothing.
    expect(classes).toContain('KinuSandbox');
  });
});

describe('the agent surfaces cannot drift from their classes', () => {
  const actorMembers = declaredClassMembers(source('actor-agent.ts'));
  const internalOrchestratorWire = [
    'getRunEventsWire',
    'runScaffoldOnceWire',
    'listTriggersWire',
    'listRecentEventsWire',
  ] as const;

  test('the orchestrator keeps every method the CLI transport dispatches onto it', () => {
    // cli/routes.ts calls `stub[method](...)` for each key of this table, so a
    // key missing from the surface is a broken CLI command, not a safe default.
    const missing = Object.keys(AGENT_RPC_ACCESS).filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name));
    expect(missing.sort()).toEqual([]);
  });

  /**
   * THERE IS NO SUBORDINATE SNAPSHOT HOP, and its absence is a property rather
   * than a gap.
   *
   * `subordinateView` reads the display name and the role through
   * `actorHost().bindStores(...).stores.config` — `actor_id`-scoped rows in the
   * one database, no stub, no allowlist entry, nothing to drift. Reaching them
   * over a stub instead makes the seal's own list load-bearing for identity: a
   * name the seal does not carry costs every roster row its real identity. The
   * behaviour is a hosting question and is asserted where the roster is driven,
   * not against a surface it does not cross.
   */

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

  test('internal cross-DO wire methods stay sealed from client RPC', () => {
    expect(internalOrchestratorWire.filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name)))
      .toEqual([]);
    expect(internalOrchestratorWire.filter((name) => Object.hasOwn(AGENT_RPC_ACCESS, name)))
      .toEqual([]);
  });

  /**
   * ONE ROW, where a `test.each` carried four.
   *
   * Three of them named `SUBORDINATE_RPC_SURFACE`, `EXPLORATION_RPC_SURFACE`
   * and `SUBORDINATE_AGENT_BOOT_SURFACE` over `subordinate-agent.ts`; all four
   * names are gone with the facet class. What is left is a single question
   * about a single surface, so it is asked as a plain test — a one-row
   * `test.each` would be a table pretending to be a matrix.
   */
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
   * The control plane lives on the substrate, once.
   *
   * All four of the original members were declared on BOTH roots over the same
   * core implementation, and nothing was red while they drifted: the
   * orchestrator's setModel and getStoredModelSpec skipped the `ensureSchema()`
   * its twin ran, so the two roots disagreed about whether their own tables had
   * to exist before a config write. A copy reappearing on the root is exactly
   * how that returns, so it is red here rather than left to review.
   *
   * `getChatHistoryPage` is the fifth and arrived the other way round: it was
   * declared on the workspace root ONLY, so a subordinate had no way to be
   * asked for a page of its own history. Both defects were shapes of one
   * mistake — a plane with two implementations — and there is one root now, so
   * what this refuses is the root re-declaring a member of a plane the
   * substrate owns for every actor hosted over it.
   *
   * Behaviour is pinned separately, through a hosted actor as well as the root,
   * in unit-actor-control-plane.test.ts and unit-actor-transcript-page.test.ts.
   */
  test('the shared control plane is declared on ActorAgent and not on the root', () => {
    const shared = [
      'getStoredModelSpec', 'setModel', 'steerTurn', 'cancelCurrentWork', 'getChatHistoryPage',
    ];
    const onActor = actorMembers.map((m) => m.name).filter((name) => shared.includes(name));
    expect(onActor.sort()).toEqual([...shared].sort());
    const redeclared = declaredClassMembers(source('orchestrator.ts'))
      .map((m) => m.name)
      .filter((name) => shared.includes(name));
    expect(redeclared).toEqual([]);
  });
});

// ── The SDK's half, derived from the installed artifact ─────────────────────
// The facet protocol and the stub entry point are the SDK's to rename, and
// the seal is fail-closed, so a rename lands as "does not implement the
// method" inside the SDK's own bookkeeping — a facet schedule, a root alarm
// owner, every `getAgentByName`. Both lists are therefore held to the
// installed `agents/dist` rather than to memory: the same reading the module
// header describes, performed here on every run.

const AGENTS_DIST = join(import.meta.dir, '..', '..', '..', 'node_modules', 'agents', 'dist');

/** Every non-map JavaScript file under `agents/dist`, read once. */
function installedAgentsSources(): string[] {
  return readdirSync(AGENTS_DIST, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(AGENTS_DIST, file), 'utf8'));
}

/** The `_cf_` names the SDK invokes on a receiver other than `this`. A
 *  receiver is `this` when the expression before `._cf_` ends in the `this`
 *  token, or is an identifier the same file declares as `const x = this`. */
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

/**
 * THE FACET-TO-ROOT SCAN IS GONE, AND WHAT IT GUARDED IS NOW MEASURED INSTEAD
 * OF DERIVED.
 *
 * A describe block stood here that read `subordinate-agent.ts` and
 * `obs/facet-operations.ts`, collected every `parent.x(` in them, and required
 * each name to be on ORCHESTRATOR_RPC_SURFACE. It existed because the seal is
 * fail-closed: a facet calling a parent method nobody listed failed at RUNTIME,
 * with workerd's "does not implement the method", inside a background head
 * where nothing but a console line saw it. That is how the four `headJournal*`
 * routing calls and `recordHeadStep` came to be declared, called, typechecked
 * and unreachable at once — `head_steps` stayed empty and a depth-2 head stayed
 * unreadable while every test passed.
 *
 * Both of its input files are deleted, and so is every call it scanned for. A
 * hosted head runs in the root's own isolate over the root's own database:
 * `recordHeadStep` and the journal writes are `seams.recordStep` and the
 * workspace's own `HeadJournal`, `nodeArbitrate` is the closure it always was,
 * and `provisionFacetHome` is `facetHomeProvisioner` called in process. There is
 * no stub to scan for, which is why this is a removal and not a re-pointing:
 * re-pointing it at the callers that DO still hold a root stub (the owner's
 * UserDO, the worker routes, the CLI transport) means a name-keyed scan over
 * four different local spellings and two chained calls bound to no local at
 * all — and the one failure mode a derived list has is shrinking silently,
 * which that instrument would do on its first day.
 *
 * The guarantee itself is in better shape than the scan left it. `tests/workerd/
 * plan-announce-probe.ts` now hops a real Durable Object stub against a real
 * sealed root and reports what the RUNTIME did with each name: a listed one
 * resolving, a listed one refused by the callee's own rule, and the inherited
 * `broadcast` and `setState` rejected by workerd itself. The two tests above
 * still check the CLI table and the worker routes against the surface, so the
 * two callers with a stable call spelling keep their derived guard.
 */

// ── The mechanism ───────────────────────────────────────────────────────────
// `UserDO`'s base classes are stubbed under bun, so the inherited half of the
// surface — the half that carries the agents SDK's `sql` — is exercised here on
// a hierarchy shaped like the real one: a third-party base with a tagged
// template query runner and a protected member, an abstract middle class, and a
// leaf that overrides.

class ThirdPartyBase {
  sql(strings: TemplateStringsArray, ...values: unknown[]): string {
    return `RAN ${strings.join('?')} ${JSON.stringify(values)}`;
  }
  baseUsesSql(): string { const id = 7; return this.sql`SELECT ${id}`; }
  get liveState(): string { return 'state'; }
  overridable(): string { return 'base'; }
}

abstract class Middle extends ThirdPartyBase {
  protected sharedWithSubclasses(): string { return 'protected value'; }
  publicApi(): string { return `api(${this.sharedWithSubclasses()})`; }
}

const callableRegistry = new WeakMap<object, string>();

class Leaf extends Middle {
  #secret = 'hidden';
  constructor() {
    super();
    callableRegistry.set(this.markedCallable, 'metadata');
    sealRpcSurface(this, ['publicApi', 'markedCallable', 'overridable']);
  }
  private leafInternal(): string { return this.#secret; }
  markedCallable(): string { return 'callable'; }
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
    // Reached through the sealed `selfCheck` itself, so the call proves the point twice.
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
    expect(Object.keys({ ...leaf })).toEqual([]);
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
