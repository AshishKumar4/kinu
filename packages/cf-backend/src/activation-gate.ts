/** The SDK starts only for fetch, alarm and its own RPCs; `ready()` also returns at once mid-start, so no re-entry. */
import { callable, type CallableMetadata } from 'agents';
import { LifecycleCapability } from 'agents/lifecycle';
import { KinuError } from '@kinu.run/core/obs';
import { inheritedDescriptor, type RpcSurfaceSubject } from './rpc-surface';

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
