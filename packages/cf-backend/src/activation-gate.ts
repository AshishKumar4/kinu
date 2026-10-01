/** The SDK starts only for fetch, alarm and its own RPCs; `ready()` never re-enters a start. */
import { callable, getCurrentAgent, type CallableMetadata } from 'agents';
import { LifecycleCapability } from 'agents/lifecycle';
import { Effect } from 'effect';
import { inheritedDescriptor, type RpcSurfaceSubject } from '@kinu.run/core';
import { attemptInItsWords, diagnostics, KinuError, settle } from '@kinu.run/core/obs';

export class ActivationGate extends LifecycleCapability {
  constructor() {
    super('kinu-activation-gate');
  }

  ready(): Promise<void> {
    return this.lifecycle.ready();
  }
}

const startGates = new WeakMap<StartGated, () => Promise<void>>();

/** The wrap is per class, the gate per instance. */
const gatedNames = new WeakMap<StartGatedPrototype, Set<string>>();

interface StartGated extends RpcSurfaceSubject {
  getCallableMethods(): Map<string, CallableMetadata>;
}

type StartGatedPrototype = Record<string, PropertyDescriptor['value']>;

/** Every surface method is async. */
type SurfaceMethod = (this: StartGated, ...args: never[]) => Promise<SurfaceAnswer>;

interface SurfaceAnswer { readonly surfaceAnswer?: never }

/** Called directly, `callable` reads only its first argument. */
const CALLABLE_CONTEXT: ClassMethodDecoratorContext = {
  kind: 'method',
  name: 'gated',
  static: false,
  private: false,
  access: {
    has: () => false,
    get: () => { throw new KinuError('unsupported', 'a gated method is not read through its decorator context'); },
  },
  addInitializer: () => undefined,
  metadata: {},
};

/** Each named method awaits `ready` first; call after `sealRpcSurface`. */
export function startBeforeRpc(instance: StartGated, names: readonly string[], ready: () => Promise<void>): void {
  startGates.set(instance, ready);
  const proto: StartGatedPrototype = Object.getPrototypeOf(instance);
  const gated = gatedNames.get(proto) ?? new Set<string>();

  gatedNames.set(proto, gated);
  const callables = instance.getCallableMethods();

  for (const name of names) {
    const descriptor = inheritedDescriptor(instance, name);

    if (gated.has(name) || descriptor === undefined) continue;
    const method: SurfaceMethod = descriptor.value;

    const gatedMethod: SurfaceMethod = function (...args) {
      return settle(Effect.gen({ self: this }, function* () {
        const gate = startGates.get(this);

        if (gate === undefined) return yield* new KinuError('unsupported', `${name} was called on an object that installed no start gate.`);
        yield* Effect.promise(async () => gate());

        return yield* Effect.promise(async () => method.apply(this, args));
      }));
    };

    Object.defineProperty(gatedMethod, 'name', { value: name });
    Object.defineProperty(gatedMethod, 'length', { value: method.length });
    const metadata = callables.get(name);
    const installed = metadata === undefined ? gatedMethod : callable(metadata)(gatedMethod, CALLABLE_CONTEXT);

    Object.defineProperty(proto, name, { ...descriptor, value: installed });
    gated.add(name);
  }
}

interface CallableHost {
  getCallableMethods(): Map<string, CallableMetadata>;
}

interface SocketAnswer { readonly socketAnswer?: never }

/** Every `@callable` is async. */
type SocketCallable = (this: CallableHost, ...args: never[]) => Promise<SocketAnswer>;

/**
 * A socket call's failure is logged with its code and cause as fields. The SDK's own line renders the error through
 * workerd's stack, which on 2026-09-29 carried no message ("RPC error:     at index.js:100627:29"); the caller still
 * receives a refusal in its own words. Calls over DO RPC fail to their caller, which reports them.
 *
 * Once, where the class is defined: every `@callable` the class or a product ancestor declares, below `sdkBase`.
 * The SDK's own members are never wrapped, and constructing an instance changes no prototype.
 */
export function reportSocketCallFailures(cls: { readonly prototype: object }, sdkBase: { readonly prototype: object }): void {
  const host: CallableHost = Object.create(cls.prototype);

  for (const [name, metadata] of host.getCallableMethods()) {
    let owner: object | null = cls.prototype;

    while (owner !== null && owner !== sdkBase.prototype && !Object.hasOwn(owner, name)) owner = Object.getPrototypeOf(owner);

    const descriptor = owner === null || owner === sdkBase.prototype ? undefined : Object.getOwnPropertyDescriptor(owner, name);

    if (descriptor === undefined) continue;
    const method: SocketCallable = descriptor.value;

    const reporting: SocketCallable = function (...args) {
      return settle(attemptInItsWords('unavailable', () => method.apply(this, args)).pipe(
        Effect.tapError((failure) => Effect.sync(() => {
          if (getCurrentAgent().connection !== undefined) diagnostics.failure('rpc.socket_call_failed', failure, { method: name });
        })),
      ));
    };

    Object.defineProperty(reporting, 'name', { value: name });
    Object.defineProperty(reporting, 'length', { value: method.length });
    Object.defineProperty(cls.prototype, name, { ...descriptor, value: callable(metadata)(reporting, CALLABLE_CONTEXT) });
  }
}
