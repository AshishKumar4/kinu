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
 * Reachability is modelled by `rpcReachableNames`, the rule this repo verified
 * against workerd 1.20260601.1 with one Durable Object calling another: members
 * anywhere on the prototype chain resolve (including superclass members and
 * TypeScript `private` ones); own instance properties do not, and workerd
 * rejects them with `The RPC receiver does not implement the method "x".` —
 * the same error it gives for a name that was never declared.
 */
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import {
  AGENTS_FACET_RPC_SURFACE,
  EXPLORATION_RPC_SURFACE,
  ORCHESTRATOR_RPC_SURFACE,
  PLATFORM_RPC_SURFACE,
  SUBORDINATE_RPC_SURFACE,
  USER_DO_RPC_SURFACE,
  rpcReachableNames,
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

describe('the UserDO RPC surface cannot drift from the class', () => {
  test('every public member is on the surface', () => {
    const missing = declaredMembers
      .filter((m) => !isInternalMember(m))
      .map((m) => m.name)
      .filter((name) => !USER_DO_RPC_SURFACE.includes(name));
    expect(missing.sort()).toEqual([]);
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
// `OrchestratorAgent`, `SubordinateAgent` and `ExplorationAgent` cannot be
// constructed under bun — their base chain reaches `cloudflare:*` through
// `@cloudflare/think` and `@cloudflare/sandbox`. Their surfaces are plain data
// though, and the class sources are readable, so the same two questions get
// answered: does every class seal itself, and does its surface hold only what
// the class actually declares?

const SRC = join(import.meta.dir, '..', 'src');
const source = (file: string) => readFileSync(join(SRC, file), 'utf8');

/** Every Durable Object class in the Worker, and the surface it must seal to.
 *  `KinuSandbox` is the one omission — see the test that pins it. */
const SEALED_CLASSES = [
  { file: 'user/user-do.ts', klass: 'UserDO', constant: 'USER_DO_RPC_SURFACE', surface: USER_DO_RPC_SURFACE },
  { file: 'orchestrator.ts', klass: 'OrchestratorAgent', constant: 'ORCHESTRATOR_RPC_SURFACE', surface: ORCHESTRATOR_RPC_SURFACE },
  { file: 'subordinate-agent.ts', klass: 'SubordinateAgent', constant: 'SUBORDINATE_RPC_SURFACE', surface: SUBORDINATE_RPC_SURFACE },
  { file: 'exploration.ts', klass: 'ExplorationAgent', constant: 'EXPLORATION_RPC_SURFACE', surface: EXPLORATION_RPC_SURFACE },
] as const;

/** The inherited members that make an unsealed Durable Object a liability: the
 *  SDK's query runner over the receiver's own storage, its storage-wiping
 *  teardown, its state writer, and the two universal method bridges that would
 *  re-open every name this module closes. */
const MUST_STAY_DENIED = [
  'sql', 'destroy', 'setState', 'stash',
  '_cf_invokeSubAgent', '_cf_invokeSubAgentPath', '_cf_invokeStubMethod',
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

  test('the parent roster read reaches the subordinate snapshot across the sealed facet', () => {
    // `subordinateView` calls this on a Facet stub, not on a local object. The
    // seal denies every name absent from SUBORDINATE_RPC_SURFACE; the call then
    // falls into its `Unavailable` recovery and every roster row loses its real
    // display name and role. The type proves the method exists on the class. The
    // two assertions below prove the parent calls it AND the sealed wire carries
    // it — neither alone prevents the outage.
    expect(source('actor-agent.ts')).toContain('.getSubordinateSnapshot()');
    expect(SUBORDINATE_RPC_SURFACE).toContain('getSubordinateSnapshot');
  });

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

  test.each([
    ['OrchestratorAgent', 'orchestrator.ts', ORCHESTRATOR_RPC_SURFACE] as const,
    ['SubordinateAgent', 'subordinate-agent.ts', SUBORDINATE_RPC_SURFACE] as const,
    ['ExplorationAgent', 'exploration.ts', EXPLORATION_RPC_SURFACE] as const,
  ])('%s names only members it or ActorAgent declares', (_name, file, surface) => {
    const declared = new Set([...declaredClassMembers(source(file)), ...actorMembers].map((m) => m.name));
    const stale = surface
      .filter((name) => !PLATFORM_RPC_SURFACE.includes(name) && !AGENTS_FACET_RPC_SURFACE.includes(name))
      .filter((name) => !declared.has(name));
    expect(stale.sort()).toEqual([]);
  });

  test.each([
    ['OrchestratorAgent', 'orchestrator.ts', ORCHESTRATOR_RPC_SURFACE] as const,
    ['SubordinateAgent', 'subordinate-agent.ts', SUBORDINATE_RPC_SURFACE] as const,
    ['ExplorationAgent', 'exploration.ts', EXPLORATION_RPC_SURFACE] as const,
  ])('%s exposes no internal of its own or of ActorAgent', (_name, file, surface) => {
    const internal = [...declaredClassMembers(source(file)), ...actorMembers]
      .filter(isInternalMember)
      .map((m) => m.name);
    expect(internal.filter((name) => surface.includes(name)).sort()).toEqual([]);
  });

  /**
   * The control plane lives on the substrate, once.
   *
   * All four of the original members were declared on BOTH roots over the same
   * core implementation, and nothing was red while they drifted: the
   * orchestrator's setModel and getStoredModelSpec skipped the `ensureSchema()`
   * its twin ran, so the two roots disagreed about whether their own tables had
   * to exist before a config write. A copy reappearing on a root is exactly how
   * that returns, so it is red here rather than left to review.
   *
   * `getChatHistoryPage` is the fifth and arrived the other way round: it was
   * declared on the workspace root ONLY, so a subordinate — a facet with its
   * own `initWorkspaceSchema` tables and therefore its own conversation — had no
   * way to be asked for a page of its own history. One root having a member of
   * this plane and the other not is the same defect as both having their own
   * copy, and this list is what refuses either shape.
   *
   * Behaviour is pinned separately, through both classes, in
   * unit-actor-control-plane.test.ts and unit-actor-transcript-page.test.ts.
   */
  test('the shared control plane is declared on ActorAgent and on neither root', () => {
    const shared = [
      'getStoredModelSpec', 'setModel', 'steerTurn', 'cancelCurrentWork', 'getChatHistoryPage',
    ];
    const onActor = actorMembers.map((m) => m.name).filter((name) => shared.includes(name));
    expect(onActor.sort()).toEqual([...shared].sort());
    for (const file of ['orchestrator.ts', 'subordinate-agent.ts']) {
      const redeclared = declaredClassMembers(source(file))
        .map((m) => m.name)
        .filter((name) => shared.includes(name));
      expect(redeclared).toEqual([]);
    }
  });
});

/**
 * The seal is fail-closed, which is right — and it means a facet calling a
 * parent method nobody added to the surface fails at RUNTIME, with workerd's
 * "does not implement the method", inside a background head where nothing but a
 * console line sees it. That is how the four `headJournal*` routing calls and
 * `recordHeadStep` came to be declared, called, typechecked and unreachable at
 * once: `head_steps` stayed empty and a depth-2 head stayed unreadable while
 * every test passed.
 *
 * So the calls are derived from the source rather than listed: a new
 * `parent.foo(...)` in the facet is either on the surface or this is red.
 */
describe('a facet reaches its root only through the sealed surface', () => {
  /**
   * Every file that can hold a cross-DO call on the root stub.
   *
   * `exploration.ts` acquires the stub, and one acquisition HANDS IT AWAY: the
   * `modelOperations` field passes a thunk to `forwardFacetModelOperations`,
   * which is where that stub's only call actually happens. So a scan confined to
   * the acquiring file cannot see it — precisely the hole this describe block
   * exists to close — and the receiving file is in the corpus for the same
   * reason `stepSink`'s parameter is pinned below.
   */
  const REACHING_FILES = ['exploration.ts', 'obs/facet-operations.ts'] as const;

  /** `const parent = this.getSharedParentStub()` is the only way a head obtains
   *  its root's stub, so every `parent.x(` in these files is a cross-DO call. */
  const parentCalls = REACHING_FILES
    .flatMap((file) => [...source(file).matchAll(/\bparent\.(\w+)\(/g)].map(([, name]) => name!))
    .filter((name, i, all) => all.indexOf(name) === i)
    .sort();

  /**
   * The scan keys on the local's NAME, so the naming convention is part of the
   * instrument and is pinned here rather than assumed.
   *
   * It had already been broken once: `runAsNode` bound the same stub to `port`,
   * so `parent.x(` never saw it and `nodeArbitrate` — a call that fails closed at
   * runtime inside a background node — was outside the scan for its whole life.
   * A second spelling shrinks the scan silently, which is the one failure mode a
   * derived list has that a hand-written one does not.
   */
  test('every acquisition of the root stub binds it to the name the scan reads', () => {
    const source_ = source('exploration.ts');
    const bindings = [...source_.matchAll(/this\.getSharedParentStub\(\)/g)];
    const named = [...source_.matchAll(/const (\w+) = this\.getSharedParentStub\(\)/g)]
      .map(([, name]) => name!);
    // The ONE acquisition that is not a local: it hands the thunk to another
    // module, which is why that module is in REACHING_FILES. Counted here so a
    // second hand-off cannot be added without extending the corpus too.
    const handedOff = [...source_.matchAll(/forwardFacetModelOperation\(\(\) => this\.getSharedParentStub\(\), event\)/g)];
    expect(handedOff).toHaveLength(1);
    expect(named).toHaveLength(bindings.length - handedOff.length);
    expect(named.filter((name, i, all) => all.indexOf(name) === i)).toEqual(['parent']);
    // And the two seams that take the stub as an argument instead of acquiring
    // it, for the same reason: a renamed parameter hides its calls too.
    expect(source_).toContain('private stepSink(parent: DurableObjectStub<OrchestratorAgent>');
    expect(source('obs/facet-operations.ts')).toContain('const parent = parentOf();');
  });

  test('the scan found the calls it exists to check (denominator)', () => {
    // Without this the filter below is green on an empty list, which is exactly
    // what a renamed accessor or a refactored stub would produce.
    expect(parentCalls.length).toBeGreaterThan(0);
    expect(parentCalls).toContain('recordHeadStep');
    expect(parentCalls).toContain('headJournalRecordSplit');
    expect(parentCalls).toContain('nodeArbitrate');
    expect(parentCalls).toContain('resolveHostedNodeHome');
  });

  test('every one of them is reachable on an OrchestratorAgent stub', () => {
    expect(parentCalls.filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name))).toEqual([]);
  });
});

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
