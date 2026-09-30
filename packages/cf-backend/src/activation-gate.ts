/** The SDK starts only for fetch, alarm and its own RPCs; `ready()` never re-enters a start. */
import { callable, getCurrentAgent, type CallableMetadata } from 'agents';
import { LifecycleCapability } from 'agents/lifecycle';
import { Effect } from 'effect';
import { attemptInItsWords, diagnostics, KinuError, settle } from '@kinu.run/core/obs';

/** Here, not in rpc-surface.ts: that module names the product classes, and a probe importing this one must not. */
export interface RpcSurfaceSubject {
  readonly constructor: Function;
}

export function inheritedDescriptor(instance: RpcSurfaceSubject, name: string): PropertyDescriptor | undefined {
  for (let proto: object | null = Object.getPrototypeOf(instance);
       proto !== null && proto !== Object.prototype;
       proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);

    if (descriptor) return descriptor;
  }

  return undefined;
}

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

const reportingClasses = new WeakSet<StartGatedPrototype>();

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

    const gatedMethod: SurfaceMethod = async function (...args) {
      const gate = startGates.get(this);

      if (gate === undefined) throw new KinuError('unsupported', `${name} was called on an object that installed no start gate.`);
      await gate();

      return method.apply(this, args);
    };

    Object.defineProperty(gatedMethod, 'name', { value: name });
    Object.defineProperty(gatedMethod, 'length', { value: method.length });
    const metadata = callables.get(name);
    const installed = metadata === undefined ? gatedMethod : callable(metadata)(gatedMethod, CALLABLE_CONTEXT);

    Object.defineProperty(proto, name, { ...descriptor, value: installed });
    gated.add(name);
  }
}

/**
 * A socket call's failure is logged with its code and cause as fields. The SDK's own line renders the error through
 * workerd's stack, which on 2026-09-29 carried no message ("RPC error:     at index.js:100627:29"); the caller
 * still receives a refusal in its own words. Calls over DO RPC fail to their caller, which reports them.
 */
export function reportSocketCallFailures(instance: StartGated): void {
  const proto: StartGatedPrototype = Object.getPrototypeOf(instance);

  if (reportingClasses.has(proto)) return;
  reportingClasses.add(proto);

  for (const [name, metadata] of instance.getCallableMethods()) {
    const descriptor = inheritedDescriptor(instance, name);

    if (descriptor === undefined) continue;
    const method: SurfaceMethod = descriptor.value;

    const reporting: SurfaceMethod = function (...args) {
      return settle(attemptInItsWords('unavailable', () => method.apply(this, args)).pipe(
        Effect.tapError((failure) => Effect.sync(() => {
          if (getCurrentAgent().connection !== undefined) diagnostics.failure('rpc.socket_call_failed', failure, { method: name });
        })),
      ));
    };

    Object.defineProperty(reporting, 'name', { value: name });
    Object.defineProperty(reporting, 'length', { value: method.length });
    Object.defineProperty(proto, name, { ...descriptor, value: callable(metadata)(reporting, CALLABLE_CONTEXT) });
  }
}
